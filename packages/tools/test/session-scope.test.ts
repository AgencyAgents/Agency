import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CallerIdentity, type Capabilities, SandboxBoundary } from "@agency/guard";
import type { HttpClient } from "@agency/net";
import type { ToolDeps } from "../src/contract.ts";
import { createSessionScope } from "../src/session-scope.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(label: string): string {
  const d = mkdtempSync(join(tmpdir(), `agency-session-scope-${label}-`));
  dirs.push(d);
  return d;
}

function makeDeps(workspaceRoot: string): ToolDeps {
  const identity: CallerIdentity = { type: "agent", name: "test" };
  const capabilities: Capabilities = { tools: "*", pathScopes: "*", network: "*" };
  const sandbox = new SandboxBoundary(workspaceRoot);
  return { identity, capabilities, sandbox };
}

const noopHttp: HttpClient = { fetch: () => Promise.resolve(new Response()) };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSessionScope", () => {
  test("owns ProcessManager, TodoStore, SnapshotStore, ReadState, ToolRegistry", async () => {
    const ws = tempDir("ws");
    const sd = tempDir("snap");
    const scope = await createSessionScope({
      deps: makeDeps(ws),
      http: noopHttp,
      workspaceRoot: ws,
      snapshotDir: sd,
    });

    expect(scope.processManager).toBeDefined();
    expect(scope.todos).toBeDefined();
    expect(scope.snapshots).toBeDefined();
    expect(scope.readState).toBeDefined();
    expect(scope.registry).toBeDefined();
    expect(scope.tools).toBeDefined();
    expect(scope.tools.length).toBeGreaterThan(0);
    expect(scope.bashState).toBeDefined();
    expect(scope.bashState.cwd).toBe(ws);
    expect(scope.mcpFailures).toBeDefined();
    expect(scope.dispose).toBeInstanceOf(Function);

    await scope.dispose();
  });

  test("each scope gets independent ProcessManager, TodoStore, ReadState", async () => {
    const ws = tempDir("ws");
    const sd = tempDir("snap");
    const scopeA = await createSessionScope({
      deps: makeDeps(ws),
      http: noopHttp,
      workspaceRoot: ws,
      snapshotDir: sd,
    });
    const scopeB = await createSessionScope({
      deps: makeDeps(ws),
      http: noopHttp,
      workspaceRoot: ws,
      snapshotDir: sd,
    });

    // Different object identities
    expect(scopeA.processManager).not.toBe(scopeB.processManager);
    expect(scopeA.todos).not.toBe(scopeB.todos);
    expect(scopeA.readState).not.toBe(scopeB.readState);
    expect(scopeA.registry).not.toBe(scopeB.registry);

    // Independent todo state
    scopeA.todos.items = [{ id: "1", content: "A-only", status: "pending" }];
    expect(scopeB.todos.items).toHaveLength(0);

    // Independent read state
    scopeA.readState.mark("/a.ts");
    expect(scopeB.readState.has("/a.ts")).toBe(false);

    await scopeA.dispose();
    await scopeB.dispose();
  });

  test("dispose() kills processManager and cleans up", async () => {
    const ws = tempDir("ws");
    const sd = tempDir("snap");
    const scope = await createSessionScope({
      deps: makeDeps(ws),
      http: noopHttp,
      workspaceRoot: ws,
      snapshotDir: sd,
    });

    // Spawn a process so we can verify it gets killed
    const info = scope.processManager.spawn(["node", "-e", "setInterval(() => {}, 1000)"]);
    expect(info.running).toBe(true);

    await scope.dispose();

    // After dispose the process should be dead
    await new Promise((r) => setTimeout(r, 200));
    const list = scope.processManager.list();
    expect(list.find((p) => p.id === info.id)?.running).toBe(false);
  });

  test("dispose() is idempotent", async () => {
    const ws = tempDir("ws");
    const sd = tempDir("snap");
    const scope = await createSessionScope({
      deps: makeDeps(ws),
      http: noopHttp,
      workspaceRoot: ws,
      snapshotDir: sd,
    });

    await scope.dispose();
    // Second call must not throw
    await scope.dispose();
  });

  test("blobs dir is shared between scopes — identical content deduplicates", async () => {
    const ws = tempDir("ws");
    const sd = tempDir("snap");
    const scopeA = await createSessionScope({
      deps: makeDeps(ws),
      http: noopHttp,
      workspaceRoot: ws,
      snapshotDir: sd,
    });
    const scopeB = await createSessionScope({
      deps: makeDeps(ws),
      http: noopHttp,
      workspaceRoot: ws,
      snapshotDir: sd,
    });

    // Capture identical content from both scopes
    const entryA = scopeA.snapshots.capture("/repo/a.ts", "shared content");
    const entryB = scopeB.snapshots.capture("/repo/b.ts", "shared content");

    // Same hash means same blob on disk
    expect(entryA.hash).toBe(entryB.hash);

    // Both can read the blob
    expect(scopeA.snapshots.read(entryA)).toBe("shared content");
    expect(scopeB.snapshots.read(entryB)).toBe("shared content");

    await scopeA.dispose();
    await scopeB.dispose();

    // Blobs survive scope disposal (they're on disk, not in-memory)
    expect(readFileSync(join(sd, "blobs", entryA.hash.slice(0, 2), entryA.hash.slice(2)), "utf8")).toBe(
      "shared content",
    );
  });

  test("blobs dir is shared — different content produces different hashes", async () => {
    const ws = tempDir("ws");
    const sd = tempDir("snap");
    const scopeA = await createSessionScope({
      deps: makeDeps(ws),
      http: noopHttp,
      workspaceRoot: ws,
      snapshotDir: sd,
    });
    const scopeB = await createSessionScope({
      deps: makeDeps(ws),
      http: noopHttp,
      workspaceRoot: ws,
      snapshotDir: sd,
    });

    const entryA = scopeA.snapshots.capture("/repo/a.ts", "content A");
    const entryB = scopeB.snapshots.capture("/repo/b.ts", "content B");

    expect(entryA.hash).not.toBe(entryB.hash);

    await scopeA.dispose();
    await scopeB.dispose();
  });

  test("dispose() cleans up internally-created LSP registry", async () => {
    const ws = tempDir("ws");
    const sd = tempDir("snap");
    // Use a server config that will fail to start (bad command) — the registry
    // is still created and must be disposed.
    const scope = await createSessionScope({
      deps: makeDeps(ws),
      http: noopHttp,
      workspaceRoot: ws,
      snapshotDir: sd,
      lspServers: {
        typescript: { command: "nonexistent-lsp", extensions: [".ts"], languageId: "typescript" },
      },
    });

    // LSP registry was created internally
    expect(scope.lspRegistry).toBeDefined();

    // dispose must not throw even with a failed LSP server
    await scope.dispose();
  });

  test("dispose() does NOT dispose externally-provided LSP registry", async () => {
    const ws = tempDir("ws");
    const sd = tempDir("snap");
    let disposed = false;
    const externalLsp = {
      clientFor: () => undefined,
      languageIdFor: () => undefined,
      all: () => [],
      statuses: () => ({}),
      recordInstallDecision: () => {},
      installDecisionFor: () => undefined,
      dispose: async () => {
        disposed = true;
      },
    };

    const scope = await createSessionScope({
      deps: makeDeps(ws),
      http: noopHttp,
      workspaceRoot: ws,
      snapshotDir: sd,
      lspRegistry: externalLsp,
    });

    expect(scope.lspRegistry).toBe(externalLsp);
    await scope.dispose();
    // External registry should NOT have been disposed by scope
    expect(disposed).toBe(false);
  });

  test("registry contains expected built-in tools", async () => {
    const ws = tempDir("ws");
    const sd = tempDir("snap");
    const scope = await createSessionScope({
      deps: makeDeps(ws),
      http: noopHttp,
      workspaceRoot: ws,
      snapshotDir: sd,
    });

    const names = scope.registry.names();
    expect(names).toContain("read");
    expect(names).toContain("write");
    expect(names).toContain("edit");
    expect(names).toContain("bash");
    expect(names).toContain("grep");
    expect(names).toContain("glob");
    expect(names).toContain("fetch");
    expect(names).toContain("todo_read");
    expect(names).toContain("todo_write");
    expect(names).toContain("execute_plan");
    expect(names).toContain("question");
    expect(names).toContain("process_list");
    expect(names).toContain("process_kill");
    expect(names).toContain("process_output");

    await scope.dispose();
  });

  test("two scopes with different snapshotDirs use separate blob stores", async () => {
    const ws = tempDir("ws");
    const sdA = tempDir("snapA");
    const sdB = tempDir("snapB");
    const scopeA = await createSessionScope({
      deps: makeDeps(ws),
      http: noopHttp,
      workspaceRoot: ws,
      snapshotDir: sdA,
    });
    const scopeB = await createSessionScope({
      deps: makeDeps(ws),
      http: noopHttp,
      workspaceRoot: ws,
      snapshotDir: sdB,
    });

    const entryA = scopeA.snapshots.capture("/repo/a.ts", "same content");
    const entryB = scopeB.snapshots.capture("/repo/b.ts", "same content");

    // Same hash (content-addressed), but stored in different dirs
    expect(entryA.hash).toBe(entryB.hash);

    // Blob exists in both dirs
    const blobPath = (dir: string, hash: string) => join(dir, "blobs", hash.slice(0, 2), hash.slice(2));
    expect(readFileSync(blobPath(sdA, entryA.hash), "utf8")).toBe("same content");
    expect(readFileSync(blobPath(sdB, entryB.hash), "utf8")).toBe("same content");

    await scopeA.dispose();
    await scopeB.dispose();
  });
});

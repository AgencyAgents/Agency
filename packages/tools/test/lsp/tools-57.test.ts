import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FULL_CAPABILITIES, SandboxBoundary } from "@agency/guard";
import type { HttpClient } from "@agency/net";
import { createBuiltinTools } from "../../src/builtin-set.ts";
import type { LspClient } from "../../src/lsp/client.ts";
import { createLspRegistry } from "../../src/lsp/registry.ts";

const noopHttp = { fetch: async () => new Response() } as unknown as HttpClient;
const FIXTURE = join(import.meta.dir, "fake-server.ts");

function depsFor(root: string) {
  return {
    identity: { type: "user" as const },
    capabilities: FULL_CAPABILITIES,
    sandbox: new SandboxBoundary(root),
  };
}

function ctx() {
  return { signal: new AbortController().signal };
}

async function handler(
  builtins: Awaited<ReturnType<typeof createBuiltinTools>>,
  name: string,
  input: unknown,
) {
  const tool = builtins.registry.get(name);
  expect(tool).toBeDefined();
  return tool!.handler(input as Record<string, unknown>, ctx());
}

describe("57. LSP tools parity", () => {
  test("all six tools register per session and route to the owning server", async () => {
    const root = mkdtempSync(join(tmpdir(), "agency-lsp-57-"));
    try {
      const registry = createLspRegistry({
        servers: [
          { command: process.execPath, args: [FIXTURE], extensions: [".ts"], languageId: "typescript" },
        ],
      });
      const builtins = await createBuiltinTools({
        deps: depsFor(root),
        http: noopHttp,
        workspaceRoot: root,
        snapshotDir: join(root, "snaps"),
        lspRegistry: registry,
      });
      for (const name of [
        "lsp_goto_definition",
        "lsp_find_references",
        "lsp_symbols",
        "lsp_prepare_rename",
        "lsp_rename",
        "lsp_install_decision",
      ]) {
        expect(builtins.registry.names()).toContain(name);
      }
      await builtins.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("goto-definition resolves through the session server", async () => {
    const root = mkdtempSync(join(tmpdir(), "agency-lsp-57-"));
    try {
      writeFileSync(join(root, "a.ts"), "function greet() {}\ngreet();\n");
      const registry = createLspRegistry({
        servers: [
          { command: process.execPath, args: [FIXTURE], extensions: [".ts"], languageId: "typescript" },
        ],
      });
      const builtins = await createBuiltinTools({
        deps: depsFor(root),
        http: noopHttp,
        workspaceRoot: root,
        snapshotDir: join(root, "snaps"),
        lspRegistry: registry,
      });
      try {
        const result = await handler(builtins, "lsp_goto_definition", {
          path: "a.ts",
          line: 2,
          character: 1,
        });
        expect(result.isError).toBeFalsy();
        expect(result.content).toContain("a.ts:4:3");
      } finally {
        await builtins.dispose();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("find-references, symbols, prepare-rename, and rename preview work end to end", async () => {
    const root = mkdtempSync(join(tmpdir(), "agency-lsp-57-"));
    try {
      writeFileSync(join(root, "a.ts"), "function greet() {}\ngreet();\n");
      const registry = createLspRegistry({
        servers: [
          { command: process.execPath, args: [FIXTURE], extensions: [".ts"], languageId: "typescript" },
        ],
      });
      const builtins = await createBuiltinTools({
        deps: depsFor(root),
        http: noopHttp,
        workspaceRoot: root,
        snapshotDir: join(root, "snaps"),
        lspRegistry: registry,
      });
      try {
        const refs = await handler(builtins, "lsp_find_references", { path: "a.ts", line: 1, character: 10 });
        expect(refs.isError).toBeFalsy();
        expect(refs.content).toContain("a.ts:8:2");

        const docSyms = await handler(builtins, "lsp_symbols", { path: "a.ts" });
        expect(docSyms.isError).toBeFalsy();
        expect(docSyms.content).toContain("greet");

        const wsSyms = await handler(builtins, "lsp_symbols", { query: "greet" });
        expect(wsSyms.isError).toBeFalsy();
        expect(wsSyms.content).toContain("greet");

        const prepared = await handler(builtins, "lsp_prepare_rename", {
          path: "a.ts",
          line: 1,
          character: 10,
        });
        expect(prepared.isError).toBeFalsy();
        expect(prepared.content).toContain("greet");

        const renamed = await handler(builtins, "lsp_rename", {
          path: "a.ts",
          line: 1,
          character: 10,
          newName: "hello",
        });
        expect(renamed.isError).toBeFalsy();
        expect(renamed.content).toContain("-> hello");

        const empty = await handler(builtins, "lsp_rename", { path: "a.ts", newName: "" });
        expect(empty.isError).toBe(true);
      } finally {
        await builtins.dispose();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("unclaimed extensions fail closed without touching a server", async () => {
    const root = mkdtempSync(join(tmpdir(), "agency-lsp-57-"));
    try {
      writeFileSync(join(root, "b.py"), "x = 1\n");
      let spawns = 0;
      const registry = createLspRegistry({
        servers: [{ command: "fake-ts", extensions: [".ts"], languageId: "typescript" }],
        clientFactory: () => {
          spawns += 1;
          return { ready: Promise.resolve() } as unknown as LspClient;
        },
      });
      const builtins = await createBuiltinTools({
        deps: depsFor(root),
        http: noopHttp,
        workspaceRoot: root,
        snapshotDir: join(root, "snaps"),
        lspRegistry: registry,
      });
      try {
        const result = await handler(builtins, "lsp_goto_definition", {
          path: "b.py",
          line: 1,
          character: 1,
        });
        expect(result.isError).toBe(true);
        expect(result.content).toContain("no language server");
        expect(spawns).toBe(0);
      } finally {
        await builtins.dispose();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("two sessions route to their own servers (no cross-session leak)", async () => {
    const root = mkdtempSync(join(tmpdir(), "agency-lsp-57-"));
    try {
      writeFileSync(join(root, "a.ts"), "let x = 1;\n");
      const markerFor = (marker: string) =>
        ({
          ready: Promise.resolve(),
          open() {},
          definition: async () => [{ path: join(root, "a.ts"), line: 0, character: 0 }],
          references: async () => [],
          documentSymbols: async () => [],
          workspaceSymbols: async () => [],
          prepareRename: async () => null,
          rename: async () => [],
          diagnosticsFor: () => [],
          waitForDiagnostics: async () => [],
          close: async () => {},
          __marker: marker,
        }) as unknown as LspClient;
      const regA = createLspRegistry({
        servers: [{ command: "srv-a", extensions: [".ts"], languageId: "typescript" }],
        clientFactory: () => markerFor("a"),
      });
      const regB = createLspRegistry({
        servers: [{ command: "srv-b", extensions: [".ts"], languageId: "typescript" }],
        clientFactory: () => markerFor("b"),
      });
      const builtinsA = await createBuiltinTools({
        deps: depsFor(root),
        http: noopHttp,
        workspaceRoot: root,
        snapshotDir: join(root, "snapsA"),
        lspRegistry: regA,
      });
      const builtinsB = await createBuiltinTools({
        deps: depsFor(root),
        http: noopHttp,
        workspaceRoot: root,
        snapshotDir: join(root, "snapsB"),
        lspRegistry: regB,
      });
      try {
        const resA = await handler(builtinsA, "lsp_goto_definition", { path: "a.ts", line: 1, character: 1 });
        const resB = await handler(builtinsB, "lsp_goto_definition", { path: "a.ts", line: 1, character: 1 });
        expect(resA.isError).toBeFalsy();
        expect(resB.isError).toBeFalsy();
        expect(regA.clientFor(join(root, "a.ts"))).not.toBe(regB.clientFor(join(root, "a.ts")));
      } finally {
        await builtinsA.dispose();
        await builtinsB.dispose();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("install-decision records per registry and surfaces in statuses", async () => {
    const root = mkdtempSync(join(tmpdir(), "agency-lsp-57-"));
    try {
      const registry = createLspRegistry({
        servers: [{ command: "missing-srv", extensions: [".ts"], languageId: "typescript" }],
        clientFactory: () => ({ ready: Promise.resolve() }) as unknown as LspClient,
      });
      const builtins = await createBuiltinTools({
        deps: depsFor(root),
        http: noopHttp,
        workspaceRoot: root,
        snapshotDir: join(root, "snaps"),
        lspRegistry: registry,
      });
      try {
        const recorded = await handler(builtins, "lsp_install_decision", {
          server: "missing-srv",
          decision: "declined",
        });
        expect(recorded.isError).toBeFalsy();
        expect(recorded.content).toContain("missing-srv");
        expect(registry.installDecisionFor("missing-srv")).toBe("declined");
        expect(registry.statuses()["missing-srv"]).toContain("declined");

        const bad = await handler(builtins, "lsp_install_decision", {
          server: "missing-srv",
          decision: "maybe",
        });
        expect(bad.isError).toBe(true);
      } finally {
        await builtins.dispose();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

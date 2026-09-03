import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FULL_CAPABILITIES, SandboxBoundary } from "@agency/guard";
import { createBuiltinTools } from "../../src/builtin-set.ts";
import type { LspClient } from "../../src/lsp/client.ts";
import { createLspRegistry } from "../../src/lsp/registry.ts";

function depsFor(root: string) {
  return { identity: { type: "user" as const }, capabilities: FULL_CAPABILITIES, sandbox: new SandboxBoundary(root) };
}

const noopHttp = { fetch: async () => new Response() } as unknown as import("@agency/net").HttpClient;

describe("LSP diagnostics attached to edit/write", () => {
  test("post-write diagnostics are appended", async () => {
    const root = mkdtempSync(join(tmpdir(), "agency-lsp-diag-"));
    const snapDir = join(root, "snaps");
    try {
      let opened: string[] = [];
      let changed: string[] = [];
      const fakeClient = {
        ready: Promise.resolve(),
        open(path: string) {
          opened.push(path);
        },
        change(path: string) {
          changed.push(path);
        },
        diagnosticsFor() {
          return [{ severity: 1, message: "boom", line: 0, character: 5, source: "fake" }];
        },
        waitForDiagnostics: async () => [{ severity: 1, message: "boom", line: 0, character: 5, source: "fake" }],
        close: async () => {},
      } as unknown as LspClient;

      const registry = createLspRegistry({
        servers: [{ command: "fake", extensions: [".ts"], languageId: "typescript" }],
        clientFactory: () => fakeClient,
      });

      const builtins = await createBuiltinTools({
        deps: depsFor(root),
        http: noopHttp,
        workspaceRoot: root,
        snapshotDir: snapDir,
        lspRegistry: registry,
      });

      const write = builtins.registry.get("write")!;
      const result = await write.handler({ path: "a.ts", content: "let x = 1;\n" }, { signal: new AbortController().signal });
      expect(result.content).toContain("1:6 boom");
      await builtins.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("read triggers didOpen", async () => {
    const root = mkdtempSync(join(tmpdir(), "agency-lsp-read-"));
    const snapDir = join(root, "snaps");
    try {
      const opened: Array<{ path: string; languageId: string }> = [];
      const fakeClient = {
        ready: Promise.resolve(),
        open(path: string, _text: string, languageId: string) {
          opened.push({ path, languageId });
        },
        change() {},
        diagnosticsFor: () => [],
        waitForDiagnostics: async () => [],
        close: async () => {},
      } as unknown as LspClient;

      const registry = createLspRegistry({
        servers: [{ command: "fake", extensions: [".ts"], languageId: "typescript" }],
        clientFactory: () => fakeClient,
      });

      const builtins = await createBuiltinTools({
        deps: depsFor(root),
        http: noopHttp,
        workspaceRoot: root,
        snapshotDir: snapDir,
        lspRegistry: registry,
      });

      // create a file then read it
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(root, "b.ts"), "const y = 2;\n");
      const read = builtins.registry.get("read")!;
      await read.handler({ path: "b.ts" }, { signal: new AbortController().signal });
      expect(opened.some((o) => o.path.endsWith("b.ts") && o.languageId === "typescript")).toBe(true);
      await builtins.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("diagnostics wait times out quickly when server missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "agency-lsp-timeout-"));
    const snapDir = join(root, "snaps");
    try {
      const fakeClient = {
        ready: Promise.resolve(),
        open() {},
        change() {},
        diagnosticsFor: () => [],
        waitForDiagnostics: async (_path: string, ms: number) => {
          await new Promise((r) => setTimeout(r, ms));
          return [];
        },
        close: async () => {},
      } as unknown as LspClient;

      const registry = createLspRegistry({
        servers: [{ command: "fake", extensions: [".ts"], languageId: "typescript" }],
        clientFactory: () => fakeClient,
      });

      const builtins = await createBuiltinTools({
        deps: depsFor(root),
        http: noopHttp,
        workspaceRoot: root,
        snapshotDir: snapDir,
        lspRegistry: registry,
      });

      const write = builtins.registry.get("write")!;
      const start = Date.now();
      const result = await write.handler({ path: "c.ts", content: "hi\n" }, { signal: new AbortController().signal });
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(2000);
      expect(result.isError).toBeFalsy();
      await builtins.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

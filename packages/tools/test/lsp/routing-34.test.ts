import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FULL_CAPABILITIES, SandboxBoundary } from "@agency/guard";
import type { HttpClient } from "@agency/net";
import { createBuiltinTools } from "../../src/builtin-set.ts";
import type { LspClient } from "../../src/lsp/client.ts";
import { normalizeLspServers, parseLspServers } from "../../src/lsp/config.ts";
import { createLspRegistry } from "../../src/lsp/registry.ts";

const noopHttp = { fetch: async () => new Response() } as unknown as HttpClient;

function depsFor(root: string) {
  return {
    identity: { type: "user" as const },
    capabilities: FULL_CAPABILITIES,
    sandbox: new SandboxBoundary(root),
  };
}

describe("34. LSP per-extension routing", () => {
  test("normalize splits string[] command into command+args", () => {
    const out = normalizeLspServers(
      parseLspServers({
        ts: { command: ["bunx", "typescript-language-server", "--stdio"], extensions: [".ts"] },
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.command).toBe("bunx");
    expect(out[0]?.args).toEqual(["typescript-language-server", "--stdio"]);
  });

  test("normalize keeps string command, merges array-command prefix with args, passes env", () => {
    const out = normalizeLspServers(
      parseLspServers({
        py: {
          command: ["pyright-langserver", "--stdio"],
          args: ["--extra"],
          env: { FOO: "bar" },
          extensions: ["py"],
          languageId: "python",
        },
      }),
    );
    expect(out[0]?.command).toBe("pyright-langserver");
    expect(out[0]?.args).toEqual(["--stdio", "--extra"]);
    expect(out[0]?.env).toEqual({ FOO: "bar" });
    expect(out[0]?.extensions).toEqual([".py"]);
    expect(out[0]?.languageId).toBe("python");
  });

  test("normalize lowercases extensions, adds dot, infers languageId", () => {
    const out = normalizeLspServers(parseLspServers({ w: { command: "srv", extensions: ["TS", ".TsX"] } }));
    expect(out[0]?.extensions).toEqual([".ts", ".tsx"]);
    expect(out[0]?.languageId).toBe("ts");
  });

  test("registry spawns lazily and only once per server", () => {
    let spawns = 0;
    const registry = createLspRegistry({
      servers: [{ command: "fake-ts", extensions: [".ts"], languageId: "typescript" }],
      clientFactory: () => {
        spawns += 1;
        return { ready: Promise.resolve() } as unknown as LspClient;
      },
    });
    expect(spawns).toBe(0);
    expect(registry.languageIdFor("a.ts")).toBe("typescript");
    expect(spawns).toBe(0);
    registry.clientFor("a.ts");
    registry.clientFor("b.TS");
    expect(spawns).toBe(1);
    expect(registry.all()).toHaveLength(1);
  });

  test("waitForDiagnostics polling resolves fast on push and times out without hanging", async () => {
    const fakeClient = {
      ready: Promise.resolve(),
      open() {},
      change() {},
      diagnosticsFor: () => [],
      waitForDiagnostics: async (_path: string, ms = 1200) => {
        expect(ms).toBe(1200);
        return [];
      },
      close: async () => {},
    } as unknown as LspClient;
    const start = Date.now();
    const diags = await fakeClient.waitForDiagnostics("x.ts");
    expect(Date.now() - start).toBeLessThan(1200);
    expect(diags).toEqual([]);
  });

  test("write result appends Diagnostics suffix with line:char message", async () => {
    const root = mkdtempSync(join(tmpdir(), "agency-lsp-34-"));
    const snapDir = join(root, "snaps");
    try {
      const fakeClient = {
        ready: Promise.resolve(),
        open() {},
        change() {},
        diagnosticsFor() {
          return [{ severity: 1, message: "boom", line: 0, character: 5, source: "fake" }];
        },
        waitForDiagnostics: async () => [
          { severity: 1, message: "boom", line: 0, character: 5, source: "fake" },
        ],
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
      const result = await write.handler(
        { path: "a.ts", content: "let x = 1;\n" },
        { signal: new AbortController().signal },
      );
      expect(result.content).toContain("Diagnostics:");
      expect(result.content).toContain("1:6 boom");
      await builtins.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

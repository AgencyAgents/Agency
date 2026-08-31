import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FULL_CAPABILITIES, SandboxBoundary } from "@agency/guard";
import { createGlobTool } from "../../src/builtins/glob.ts";
import type { ToolDeps } from "../../src/contract.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "agency-glob-test-"));
  dirs.push(root);
  const capabilities = { ...FULL_CAPABILITIES, pathScopes: [root] };
  const deps: ToolDeps = { identity: { type: "user" }, capabilities, sandbox: new SandboxBoundary(root) };
  return { deps, root };
}

const signal = new AbortController().signal;

describe("createGlobTool", () => {
  test("lists files matching a pattern", async () => {
    const { deps, root } = setup();
    writeFileSync(join(root, "a.ts"), "");
    writeFileSync(join(root, "b.ts"), "");
    writeFileSync(join(root, "c.md"), "");

    const tool = createGlobTool(deps);
    const result = await tool.handler({ pattern: "*.ts" }, { signal });

    expect(result.content).toContain("a.ts");
    expect(result.content).toContain("b.ts");
    expect(result.content).not.toContain("c.md");
  });

  test("matches recursively with **", async () => {
    const { deps, root } = setup();
    mkdirSync(join(root, "src", "nested"), { recursive: true });
    writeFileSync(join(root, "src", "nested", "deep.ts"), "");

    const tool = createGlobTool(deps);
    const result = await tool.handler({ pattern: "**/*.ts" }, { signal });

    expect(result.content).toContain("deep.ts");
  });

  test("reports no matches clearly", async () => {
    const { deps } = setup();
    const tool = createGlobTool(deps);
    const result = await tool.handler({ pattern: "*.nonexistent-ext" }, { signal });
    expect(result.content).toBe("no files matched");
  });

  test("rejects a search root outside the sandbox", async () => {
    const { deps } = setup();
    const tool = createGlobTool(deps);
    await expect(tool.handler({ pattern: "*", path: "../../" }, { signal })).rejects.toThrow();
  });
});

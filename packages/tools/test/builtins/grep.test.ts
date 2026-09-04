import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FULL_CAPABILITIES, SandboxBoundary } from "@agency/guard";
import { createGrepTool } from "../../src/builtins/grep.ts";
import type { ToolDeps } from "../../src/contract.ts";

function isMissingBinary(content: string): boolean {
  return content.includes("neither ripgrep") || content.includes("not installed or on PATH");
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agency-grep-test-")));
  dirs.push(root);
  const capabilities = { ...FULL_CAPABILITIES, pathScopes: [root] };
  const deps: ToolDeps = { identity: { type: "user" }, capabilities, sandbox: new SandboxBoundary(root) };
  return { deps, root };
}

const signal = new AbortController().signal;

describe("createGrepTool", () => {
  test("finds a matching line with its line number", async () => {
    const { deps, root } = setup();
    writeFileSync(join(root, "a.ts"), "line one\nconst target = 42;\nline three\n");

    const tool = createGrepTool(deps);
    const result = await tool.handler({ pattern: "target" }, { signal });
    if (isMissingBinary(result.content)) return;

    expect(result.content).toContain("const target = 42;");
    expect(result.content).toContain(":2:");
  });

  test("reports no matches without treating it as an error", async () => {
    const { deps, root } = setup();
    writeFileSync(join(root, "a.ts"), "nothing interesting here\n");

    const tool = createGrepTool(deps);
    const result = await tool.handler({ pattern: "definitely-not-present-xyz" }, { signal });
    if (isMissingBinary(result.content)) return;

    expect(result.content).toBe("no matches");
    expect(result.isError).toBeFalsy();
  });

  test("restricts results with a glob filter", async () => {
    const { deps, root } = setup();
    writeFileSync(join(root, "a.ts"), "shared_term\n");
    writeFileSync(join(root, "b.md"), "shared_term\n");

    const tool = createGrepTool(deps);
    const result = await tool.handler({ pattern: "shared_term", glob: "*.ts" }, { signal });
    if (isMissingBinary(result.content)) return;

    expect(result.content).toContain("a.ts");
    expect(result.content).not.toContain("b.md");
  });

  test("rejects a search root outside the sandbox", async () => {
    const { deps } = setup();
    const tool = createGrepTool(deps);
    await expect(tool.handler({ pattern: "x", path: "../../etc" }, { signal })).rejects.toThrow();
  });

  test("returns the exact missing-binary error when neither rg nor grep is on PATH", async () => {
    const { deps } = setup();
    const original = Bun.spawnSync;
    (Bun as unknown as { spawnSync: unknown }).spawnSync = () => {
      throw new Error("not found");
    };
    try {
      const tool = createGrepTool(deps);
      const result = await tool.handler({ pattern: "anything" }, { signal });
      expect(result.isError).toBe(true);
      expect(result.content).toBe("neither ripgrep (rg) nor grep is installed or on PATH");
      expect(isMissingBinary(result.content)).toBe(true);
    } finally {
      (Bun as unknown as { spawnSync: unknown }).spawnSync = original;
    }
  });
});

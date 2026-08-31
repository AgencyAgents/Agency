import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FULL_CAPABILITIES, SandboxBoundary } from "@agency/guard";
import { createReadTool } from "../../src/builtins/read.ts";
import type { ToolDeps } from "../../src/contract.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDeps(): { deps: ToolDeps; root: string } {
  const root = mkdtempSync(join(tmpdir(), "agency-read-test-"));
  dirs.push(root);
  const capabilities = { ...FULL_CAPABILITIES, pathScopes: [root] };
  return { deps: { identity: { type: "user" }, capabilities, sandbox: new SandboxBoundary(root) }, root };
}

const signal = new AbortController().signal;

describe("createReadTool", () => {
  test("reads a file's exact content", async () => {
    const { deps, root } = tempDeps();
    writeFileSync(join(root, "a.ts"), "export const x = 1;\n");

    const tool = createReadTool(deps);
    const result = await tool.handler({ path: "a.ts" }, { signal });

    expect(result.content).toBe("export const x = 1;\n");
    expect(result.isError).toBeFalsy();
  });

  test("rejects a path outside the sandbox root", async () => {
    const { deps } = tempDeps();
    const tool = createReadTool(deps);
    await expect(tool.handler({ path: "../../etc/passwd" }, { signal })).rejects.toThrow();
  });

  test("refuses to read a file over the size limit, suggesting grep instead", async () => {
    const { deps, root } = tempDeps();
    writeFileSync(join(root, "huge.txt"), "x".repeat(1_000_001));

    const tool = createReadTool(deps);
    const result = await tool.handler({ path: "huge.txt" }, { signal });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("grep");
  });
});

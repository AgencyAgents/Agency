import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const signal = new AbortController().signal;

function depsFor(root: string): ToolDeps {
  return { identity: { type: "user" }, capabilities: FULL_CAPABILITIES, sandbox: new SandboxBoundary(root) };
}

describe("grep: global cap and flags (A6)", () => {
  test("the match cap is global, not per-file", async () => {
    const root = mkdtempSync(join(tmpdir(), "agency-grep-a6-"));
    dirs.push(root);
    for (let f = 0; f < 5; f++) {
      const lines = Array.from({ length: 80 }, (_, i) => `hit ${f}-${i}`).join("\n");
      writeFileSync(join(root, `f${f}.txt`), `${lines}\n`);
    }

    const tool = createGrepTool(depsFor(root));
    const result = await tool.handler({ pattern: "hit" }, { signal });
    if (isMissingBinary(result.content)) return;

    expect(result.content).toContain("[truncated at 200 matches]");
    const matchLines = result.content.split("\n").filter((line) => /^(.+):\d+:/.test(line)).length;
    expect(matchLines).toBeLessThanOrEqual(201);
  }, 30_000);

  test("caseInsensitive and context flags flow through", async () => {
    const root = mkdtempSync(join(tmpdir(), "agency-grep-a6-"));
    dirs.push(root);
    writeFileSync(join(root, "a.txt"), "Mixed CASE value\nbefore\nafter\n");

    const tool = createGrepTool(depsFor(root));
    const insensitive = await tool.handler({ pattern: "mixed case", caseInsensitive: true }, { signal });
    if (isMissingBinary(insensitive.content)) return;
    expect(insensitive.content).toContain("Mixed CASE value");

    const sensitive = await tool.handler({ pattern: "mixed case" }, { signal });
    expect(sensitive.content).toBe("no matches");

    const withContext = await tool.handler({ pattern: "before", context: 1 }, { signal });
    expect(withContext.content).toContain("Mixed CASE value");
    expect(withContext.content).toContain("after");
  }, 30_000);

  test("filesOnly lists file paths instead of lines", async () => {
    const root = mkdtempSync(join(tmpdir(), "agency-grep-a6-"));
    dirs.push(root);
    writeFileSync(join(root, "x.txt"), "needle here\nneedle again\n");
    writeFileSync(join(root, "y.txt"), "needle too\n");

    const tool = createGrepTool(depsFor(root));
    const result = await tool.handler({ pattern: "needle", filesOnly: true }, { signal });
    if (isMissingBinary(result.content)) return;

    const lines = result.content.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(result.content).toContain("x.txt");
    expect(result.content).toContain("y.txt");
    expect(result.content).not.toContain("needle here");
  }, 30_000);
});

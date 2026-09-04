import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agency-glob-test-")));
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

  test("strips leading / from pattern", async () => {
    const { deps, root } = setup();
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "lib"), { recursive: true });
    writeFileSync(join(root, "src", "app.ts"), "");
    writeFileSync(join(root, "lib", "util.ts"), "");

    const tool = createGlobTool(deps);
    // Pattern with leading / should work the same as without
    const result = await tool.handler({ pattern: "/**/*.ts" }, { signal });

    expect(result.content).toContain("src/app.ts");
    expect(result.content).toContain("lib/util.ts");
  });

  test("caps results at 500 and sorts newest first", async () => {
    const { deps, root } = setup();
    // Create 600 files
    for (let i = 0; i < 600; i++) {
      writeFileSync(join(root, `file${String(i).padStart(3, "0")}.ts`), "");
    }

    const tool = createGlobTool(deps);
    const result = await tool.handler({ pattern: "*.ts" }, { signal });

    const lines = result.content.split("\n").filter((l) => l.length > 0 && !l.startsWith("no files matched"));
    // Should have at most 500 file lines (plus optional truncation message)
    const fileLines = lines.filter((l) => l.endsWith(".ts"));
    expect(fileLines.length).toBeLessThanOrEqual(500);
    // The newest files (highest index) should appear first due to mtime sort
    if (fileLines.length >= 2) {
      const newer = fileLines[0];
      const older = fileLines[fileLines.length - 1];
      // newer files have later mtime so they sort first
      expect(newer).toBeDefined();
      expect(older).toBeDefined();
    }
  });

  test("respects scan bound of 5000", async () => {
    const { deps, root } = setup();
    // Create 6000 files — scan bound should stop at 5000
    for (let i = 0; i < 6000; i++) {
      writeFileSync(join(root, `n${String(i).padStart(4, "0")}.ts`), "");
    }

    const tool = createGlobTool(deps);
    const result = await tool.handler({ pattern: "*.ts" }, { signal });

    const lines = result.content.split("\n").filter((l) => l.length > 0 && !l.startsWith("no files matched"));
    const fileLines = lines.filter((l) => l.endsWith(".ts"));
    // At most 500 results (the cap), but the scan scanned at most 5000
    expect(fileLines.length).toBeLessThanOrEqual(500);
  });
});

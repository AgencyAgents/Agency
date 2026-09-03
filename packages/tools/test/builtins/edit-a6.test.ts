import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FULL_CAPABILITIES, SandboxBoundary } from "@agency/guard";
import { createEditTool } from "../../src/builtins/edit.ts";
import type { ToolDeps } from "../../src/contract.ts";
import { SnapshotStore } from "../../src/snapshot.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const signal = new AbortController().signal;

function setup() {
  const root = mkdtempSync(join(tmpdir(), "agency-edit-a6-"));
  const snapshotDir = mkdtempSync(join(tmpdir(), "agency-edit-a6-snap-"));
  dirs.push(root, snapshotDir);
  const deps: ToolDeps = {
    identity: { type: "user" },
    capabilities: FULL_CAPABILITIES,
    sandbox: new SandboxBoundary(root),
  };
  return { deps, root, snapshots: new SnapshotStore(snapshotDir) };
}

describe("edit tool: multi-hunk + diagnostics (A6)", () => {
  test("applies several hunks in one call", async () => {
    const { deps, root, snapshots } = setup();
    writeFileSync(join(root, "a.ts"), "const a = 1;\nconst b = 2;\n");
    const tool = createEditTool(deps, snapshots, {});

    const result = await tool.handler(
      {
        path: "a.ts",
        hunks: [
          { oldText: "a = 1", newText: "a = 11" },
          { oldText: "b = 2", newText: "b = 22" },
        ],
      },
      { signal },
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("2 hunk(s)");
    expect(readFileSync(join(root, "a.ts"), "utf8")).toBe("const a = 11;\nconst b = 22;\n");
  });

  test("all-or-nothing: a failing hunk leaves the file untouched", async () => {
    const { deps, root, snapshots } = setup();
    writeFileSync(join(root, "a.ts"), "const a = 1;\nconst b = 2;\n");
    const tool = createEditTool(deps, snapshots, {});

    const result = await tool.handler(
      {
        path: "a.ts",
        hunks: [
          { oldText: "a = 1", newText: "a = 11" },
          { oldText: "not present", newText: "x" },
        ],
      },
      { signal },
    );

    expect(result.isError).toBe(true);
    expect(readFileSync(join(root, "a.ts"), "utf8")).toBe("const a = 1;\nconst b = 2;\n");
  });

  test("error-severity diagnostics ride along on the result", async () => {
    const { deps, root, snapshots } = setup();
    writeFileSync(join(root, "a.ts"), "const x = 1;\n");
    const diagnostics = (path: string) =>
      path.endsWith("a.ts") ? [{ severity: 1, message: "boom", line: 0, character: 6 }] : [];
    const tool = createEditTool(deps, snapshots, {}, { diagnostics });

    const result = await tool.handler({ path: "a.ts", oldText: "= 1;", newText: "= 2;" }, { signal });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("edited");
    expect(result.content).toContain("boom");
  });

  test("passing both oldText/newText and hunks is a clean input error", async () => {
    const { deps, root, snapshots } = setup();
    writeFileSync(join(root, "a.ts"), "const a = 1;\n");
    const tool = createEditTool(deps, snapshots, {});

    const result = await tool.handler(
      { path: "a.ts", oldText: "a", newText: "b", hunks: [{ oldText: "a", newText: "b" }] },
      { signal },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("rejected");
  });

  test("whitespace drift between reads still edits (fuzzy fallback)", async () => {
    const { deps, root, snapshots } = setup();
    writeFileSync(join(root, "indented.ts"), "function f() {\n    if (x) {\n        return 1;\n    }\n}\n");
    const tool = createEditTool(deps, snapshots, {});

    const result = await tool.handler(
      { path: "indented.ts", oldText: "if (x) {\n  return 1;\n}", newText: "if (x) {\n  return 2;\n}" },
      { signal },
    );
    expect(result.isError).toBeFalsy();
    expect(readFileSync(join(root, "indented.ts"), "utf8")).toContain("return 2;");
  });
});
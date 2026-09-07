import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agency-edit-test-")));
  const snapshotDir = realpathSync(mkdtempSync(join(tmpdir(), "agency-edit-snap-")));
  dirs.push(root, snapshotDir);
  const capabilities = { ...FULL_CAPABILITIES, pathScopes: [root] };
  const deps: ToolDeps = { identity: { type: "user" }, capabilities, sandbox: new SandboxBoundary(root) };
  return { deps, root, snapshots: new SnapshotStore(snapshotDir) };
}

const signal = new AbortController().signal;

describe("createEditTool", () => {
  test("applies a unique edit and writes the result", async () => {
    const { deps, root, snapshots } = setup();
    writeFileSync(join(root, "a.ts"), "const x = 1;\n");
    const tool = createEditTool(deps, snapshots, {});

    const result = await tool.handler(
      { path: "a.ts", oldText: "const x = 1;", newText: "const x = 2;" },
      { signal },
    );

    expect(result.isError).toBeFalsy();
    expect(readFileSync(join(root, "a.ts"), "utf8")).toBe("const x = 2;\n");
  });

  test("rejects (not misapplies) when oldText has drifted, leaving the file untouched", async () => {
    const { deps, root, snapshots } = setup();
    writeFileSync(join(root, "a.ts"), "const x = 1;\n");
    const tool = createEditTool(deps, snapshots, {});

    const result = await tool.handler(
      { path: "a.ts", oldText: "const x = 99;", newText: "const x = 2;" },
      { signal },
    );

    expect(result.isError).toBe(true);
    expect(readFileSync(join(root, "a.ts"), "utf8")).toBe("const x = 1;\n");
  });

  test("editing a nonexistent file returns a clear error instead of throwing", async () => {
    const { deps, snapshots } = setup();
    const tool = createEditTool(deps, snapshots, {});

    const result = await tool.handler({ path: "missing.ts", oldText: "x", newText: "y" }, { signal });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("write");
  });

  test("snapshots the pre-edit content before writing", async () => {
    const { deps, root, snapshots } = setup();
    writeFileSync(join(root, "a.ts"), "before");
    const tool = createEditTool(deps, snapshots, {});

    await tool.handler({ path: "a.ts", oldText: "before", newText: "after" }, { signal });

    const entry = snapshots.capture(join(root, "a.ts"), "before");
    expect(snapshots.read(entry)).toBe("before");
  });
});

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

  test("the result shows the changed lines with their numbers, so no read has to follow", async () => {
    const { deps, root, snapshots } = setup();
    const lines = Array.from({ length: 40 }, (_, i) => `const v${i + 1} = ${i + 1};`);
    writeFileSync(join(root, "a.ts"), `${lines.join("NL")}NL`.replaceAll("NL", String.fromCharCode(10)));
    const tool = createEditTool(deps, snapshots, {});

    const result = await tool.handler(
      { path: "a.ts", oldText: "const v20 = 20;", newText: "const v20 = 200;" },
      { signal },
    );

    expect(result.isError).toBeFalsy();
    const shown = result.content.split(String.fromCharCode(10));
    expect(shown[0]).toBe("edited a.ts");
    expect(shown).toContain("    20  const v20 = 200;");
    expect(shown).toContain("    17  const v17 = 17;");
    expect(shown).toContain("    23  const v23 = 23;");
    expect(shown).not.toContain("    16  const v16 = 16;");
    expect(tool.renderResult?.({ content: result.content, isError: false })).toBe("edited a.ts");
  });
});

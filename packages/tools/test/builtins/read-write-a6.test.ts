import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FULL_CAPABILITIES, SandboxBoundary } from "@agency/guard";
import { createReadTool } from "../../src/builtins/read.ts";
import { createWriteTool } from "../../src/builtins/write.ts";
import type { ToolDeps } from "../../src/contract.ts";
import { ReadState } from "../../src/read-state.ts";
import { SnapshotStore } from "../../src/snapshot.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const signal = new AbortController().signal;

function depsFor(root: string): ToolDeps {
  return { identity: { type: "user" }, capabilities: FULL_CAPABILITIES, sandbox: new SandboxBoundary(root) };
}

describe("read: offset/limit + line numbers (A6)", () => {
  test("a plain read returns exact content with no line numbers", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "agency-read-a6-")));
    dirs.push(root);
    writeFileSync(join(root, "a.ts"), "export const x = 1;\n");
    const tool = createReadTool(depsFor(root));
    const result = await tool.handler({ path: "a.ts" }, { signal });
    expect(result.content).toBe("export const x = 1;\n");
  });

  test("sliced reads carry line numbers usable as edit anchors", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "agency-read-a6-")));
    dirs.push(root);
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
    writeFileSync(join(root, "lines.txt"), lines.join("\n"));
    const tool = createReadTool(depsFor(root));

    const result = await tool.handler({ path: "lines.txt", offset: 10, limit: 3 }, { signal });
    expect(result.content).toContain("    10  line 10");
    expect(result.content).toContain("    12  line 12");
    expect(result.content).not.toContain("line 13");
    expect(result.content).not.toContain("line 9");
  });

  test("a file over the 1MB limit is sliced with line numbers instead of refused", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "agency-read-a6-")));
    dirs.push(root);
    const lines = Array.from({ length: 100_000 }, (_, i) => `line ${i + 1}`);
    writeFileSync(join(root, "big.txt"), lines.join("\n"));
    const tool = createReadTool(depsFor(root));

    const refused = await tool.handler({ path: "big.txt" }, { signal });
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("grep");
    expect(refused.content).toContain("offset/limit");

    const sliced = await tool.handler({ path: "big.txt", offset: 1, limit: 5 }, { signal });
    expect(sliced.isError).toBeFalsy();
    expect(sliced.content).toContain("line 5");
    expect(sliced.content).not.toContain("line 6\n");
  });

  test("reading marks the file in the shared ReadState", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "agency-read-a6-")));
    dirs.push(root);
    writeFileSync(join(root, "a.ts"), "content");
    const readState = new ReadState();
    const tool = createReadTool(depsFor(root), { readState });
    await tool.handler({ path: "a.ts" }, { signal });
    expect(readState.has(join(root, "a.ts"))).toBe(true);
  });
});

describe("write: read-before-write guard (A6)", () => {
  test("warns when overwriting a file that was never read; silent once read", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "agency-write-a6-")));
    const snapshotDir = realpathSync(mkdtempSync(join(tmpdir(), "agency-write-a6-snap-")));
    dirs.push(root, snapshotDir);
    writeFileSync(join(root, "a.ts"), "original");

    const readState = new ReadState();
    const deps = depsFor(root);
    const write = createWriteTool(deps, new SnapshotStore(snapshotDir), {}, { readState });
    const read = createReadTool(deps, { readState });

    const guarded = await write.handler({ path: "a.ts", content: "new" }, { signal });
    expect(guarded.content).toContain("never read this session");
    expect(readFileSync(join(root, "a.ts"), "utf8")).toBe("new");

    await read.handler({ path: "a.ts" }, { signal });
    const afterRead = await write.handler({ path: "a.ts", content: "newer" }, { signal });
    expect(afterRead.content).not.toContain("never read this session");
  });

  test("a brand-new file never triggers the warning; no readState means no guard", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "agency-write-a6-")));
    const snapshotDir = realpathSync(mkdtempSync(join(tmpdir(), "agency-write-a6-snap-")));
    dirs.push(root, snapshotDir);
    writeFileSync(join(root, "b.ts"), "old");
    const deps = depsFor(root);
    const snapshots = new SnapshotStore(snapshotDir);

    const fresh = await createWriteTool(deps, snapshots, {}, { readState: new ReadState() }).handler(
      { path: "new.ts", content: "x" },
      { signal },
    );
    expect(fresh.content).not.toContain("never read this session");

    const legacy = await createWriteTool(deps, snapshots, {}).handler(
      { path: "b.ts", content: "y" },
      { signal },
    );
    expect(legacy.content).not.toContain("never read this session");
    expect(existsSync(join(root, "new.ts"))).toBe(true);
  });
});

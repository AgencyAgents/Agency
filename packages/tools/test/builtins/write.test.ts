import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FULL_CAPABILITIES, SandboxBoundary } from "@agency/guard";
import { createWriteTool } from "../../src/builtins/write.ts";
import type { ToolDeps } from "../../src/contract.ts";
import { SnapshotStore } from "../../src/snapshot.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agency-write-test-")));
  const snapshotDir = realpathSync(mkdtempSync(join(tmpdir(), "agency-write-snap-")));
  dirs.push(root, snapshotDir);
  const capabilities = { ...FULL_CAPABILITIES, pathScopes: [root] };
  const deps: ToolDeps = { identity: { type: "user" }, capabilities, sandbox: new SandboxBoundary(root) };
  return { deps, root, snapshots: new SnapshotStore(snapshotDir) };
}

const signal = new AbortController().signal;

describe("createWriteTool", () => {
  test("creates a new file, including parent directories", async () => {
    const { deps, root, snapshots } = setup();
    const tool = createWriteTool(deps, snapshots, {});

    await tool.handler({ path: "src/nested/new.ts", content: "hello" }, { signal });

    expect(readFileSync(join(root, "src", "nested", "new.ts"), "utf8")).toBe("hello");
  });

  test("overwrites an existing file entirely", async () => {
    const { deps, root, snapshots } = setup();
    writeFileSync(join(root, "a.ts"), "old content");
    const tool = createWriteTool(deps, snapshots, {});

    await tool.handler({ path: "a.ts", content: "new content" }, { signal });

    expect(readFileSync(join(root, "a.ts"), "utf8")).toBe("new content");
  });

  test("snapshots the prior content before overwriting, enabling undo", async () => {
    const { deps, root, snapshots } = setup();
    writeFileSync(join(root, "a.ts"), "original");
    const tool = createWriteTool(deps, snapshots, {});

    await tool.handler({ path: "a.ts", content: "changed" }, { signal });

    const entry = snapshots.capture(join(root, "a.ts"), "original");
    expect(snapshots.read(entry)).toBe("original");
  });

  test("does not snapshot when creating a brand-new file", async () => {
    const { deps, root, snapshots } = setup();
    const tool = createWriteTool(deps, snapshots, {});
    await tool.handler({ path: "brand-new.ts", content: "x" }, { signal });
    expect(existsSync(join(root, "brand-new.ts"))).toBe(true);
  });

  test("rejects a path outside the sandbox root", async () => {
    const { deps, snapshots } = setup();
    const tool = createWriteTool(deps, snapshots, {});
    await expect(tool.handler({ path: "../outside.ts", content: "x" }, { signal })).rejects.toThrow();
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SnapshotStore } from "../src/snapshot.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempStore(): { store: SnapshotStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "agency-shadow-test-"));
  dirs.push(dir);
  return { store: new SnapshotStore(dir), dir };
}

describe("SnapshotStore.shadowCommit", () => {
  test("checkpoints the latest hash per path with no git side-effects", () => {
    const { store, dir } = tempStore();
    mkdirSync(join(dir, "ws"), { recursive: true });
    const file = join(dir, "ws", "a.ts");
    store.capture(file, "v1", "turn-1");
    writeFileSync(file, "v2", "utf8");
    store.recordAfter(file);
    store.capture(join(dir, "ws", "b.ts"), "b1");

    const outcome = store.shadowCommit("session-1", "checkpoint one");
    expect(outcome.commitHash).toMatch(/^[0-9a-f]{64}$/);
    expect(outcome.files).toHaveLength(2);
    expect(outcome.files[0]?.path.endsWith("a.ts")).toBe(true);

    const manifest = store.readShadowCommit(outcome.commitHash);
    expect(manifest?.sessionId).toBe("session-1");
    expect(manifest?.message).toBe("checkpoint one");
    expect(manifest?.files).toEqual(outcome.files);

    const journal = readFileSync(join(dir, "shadow-journal.jsonl"), "utf8");
    expect(journal).toContain(outcome.commitHash);
  });

  test("empty journals commit zero files and unknown hashes read undefined", () => {
    const { store } = tempStore();
    const outcome = store.shadowCommit("s", "empty");
    expect(outcome.files).toEqual([]);
    expect(store.readShadowCommit("0".repeat(64))).toBeUndefined();
  });

  test("rejects empty session ids and messages", () => {
    const { store } = tempStore();
    expect(() => store.shadowCommit("  ", "msg")).toThrow(/session id/);
    expect(() => store.shadowCommit("s", "   ")).toThrow(/message/);
  });
});

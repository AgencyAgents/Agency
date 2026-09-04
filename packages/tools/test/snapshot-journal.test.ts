import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SnapshotStore } from "../src/snapshot.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDirs(): { storeDir: string; ws: string } {
  const storeDir = mkdtempSync(join(tmpdir(), "agency-journal-store-"));
  const ws = mkdtempSync(join(tmpdir(), "agency-journal-ws-"));
  dirs.push(storeDir, ws);
  return { storeDir, ws };
}

describe("SnapshotStore journal durability", () => {
  test("undo history survives a restart: a new store over the same dir replays the journal", () => {
    const { storeDir, ws } = tempDirs();
    const file = join(ws, "a.ts");
    const journalFile = join(storeDir, "journals", "s1.journal.jsonl");

    const first = new SnapshotStore(storeDir, { journalFile });
    writeFileSync(file, "before", "utf8");
    first.capture(file, "before", "turn-1");
    writeFileSync(file, "after", "utf8");
    first.recordAfter(file);

    const second = new SnapshotStore(storeDir, { journalFile });
    expect(second.depth).toBe(1);
    expect(second.undo()).toEqual({ path: file });
    expect(readFileSync(file, "utf8")).toBe("before");
    expect(second.redo()).toEqual({ path: file });
    expect(readFileSync(file, "utf8")).toBe("after");
  });

  test("undone state persists: a restart after undo still redoes", () => {
    const { storeDir, ws } = tempDirs();
    const file = join(ws, "a.ts");
    const journalFile = join(storeDir, "journals", "s1.journal.jsonl");

    const first = new SnapshotStore(storeDir, { journalFile });
    writeFileSync(file, "before", "utf8");
    first.capture(file, "before");
    writeFileSync(file, "after", "utf8");
    first.recordAfter(file);
    first.undo();
    expect(readFileSync(file, "utf8")).toBe("before");

    const second = new SnapshotStore(storeDir, { journalFile });
    expect(second.redo()).toEqual({ path: file });
    expect(readFileSync(file, "utf8")).toBe("after");
  });

  test("a corrupt journal line is skipped with a warning instead of dropping the journal", () => {
    const { storeDir, ws } = tempDirs();
    const file = join(ws, "a.ts");
    const journalFile = join(storeDir, "journal.jsonl");

    const first = new SnapshotStore(storeDir, { journalFile });
    writeFileSync(file, "v1", "utf8");
    first.capture(file, "v1");
    const valid = readFileSync(journalFile, "utf8");
    writeFileSync(journalFile, `${valid}{not json}\n{"nope":true}\n`, "utf8");

    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(String(args[0]));
    };
    try {
      const second = new SnapshotStore(storeDir, { journalFile });
      expect(second.depth).toBe(1);
    } finally {
      console.warn = orig;
    }
    expect(warnings.length).toBeGreaterThan(0);
  });

  test("prune keeps blobs referenced by a sibling session journal", () => {
    const { storeDir } = tempDirs();
    const journals = join(storeDir, "journals");
    const a = new SnapshotStore(storeDir, { journalFile: join(journals, "a.journal.jsonl") });
    const shared = "shared content";
    a.capture("/repo/a.ts", shared, "turn-1");

    const b = new SnapshotStore(storeDir, { journalFile: join(journals, "b.journal.jsonl") });
    b.capture("/repo/b.ts", "b content", "turn-1");

    expect(b.prune()).toBe(0);
  });

  test("prune still reclaims blobs no journal references", () => {
    const { storeDir } = tempDirs();
    const journals = join(storeDir, "journals");
    const a = new SnapshotStore(storeDir, { journalFile: join(journals, "a.journal.jsonl") });
    a.capture("/repo/a.ts", "live", "turn-1");

    const orphan = new SnapshotStore(storeDir, { journalFile: join(journals, "orphan.journal.jsonl") });
    orphan.capture("/repo/z.ts", "doomed", "turn-9");
    rmSync(join(journals, "orphan.journal.jsonl"), { force: true });

    const fresh = new SnapshotStore(storeDir, { journalFile: join(journals, "a.journal.jsonl") });
    expect(fresh.prune()).toBe(1);
  });
});

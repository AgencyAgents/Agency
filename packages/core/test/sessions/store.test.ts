import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@agency/schema";
import { SessionStore } from "../../src/sessions/store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "agency-sessions-"));
  dirs.push(dir);
  return { store: new SessionStore(dir), dir };
}

function userMsg(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

function captureWarnings() {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  return {
    warnings,
    restore: () => {
      console.warn = original;
    },
  };
}

describe("SessionStore", () => {
  test("appends and loads entries in order", async () => {
    const { store } = setup();
    const meta = store.create("s1");
    const e1 = await store.append(meta.id, { type: "message", parentId: null, message: userMsg("hi") });
    const e2 = await store.append(meta.id, { type: "message", parentId: e1.id, message: userMsg("again") });

    const loaded = store.load(meta.id);
    expect(loaded.map((e) => e.id)).toEqual([e1.id, e2.id]);
  });

  test("an awaited append is fully on disk before load sees it", async () => {
    const { store } = setup();
    const meta = store.create("s1");
    const entry = await store.append(meta.id, {
      type: "message",
      parentId: null,
      message: userMsg("persisted"),
    });

    const loaded = store.load(meta.id);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.id).toBe(entry.id);
  });

  test("crash recovery: a truncated trailing line is discarded with a warning, earlier entries survive", async () => {
    const { store, dir } = setup();
    const meta = store.create("s1");
    const e1 = await store.append(meta.id, { type: "message", parentId: null, message: userMsg("hi") });
    const path = join(dir, `${meta.id}.jsonl`);
    appendFileSync(path, '{"id":"broken","parentId":null,"type":"message","schemaVers'); // cut mid-write, no newline

    const capture = captureWarnings();
    try {
      const loaded = store.load(meta.id);
      expect(loaded.map((e) => e.id)).toEqual([e1.id]);
      expect(capture.warnings.some((w) => w.includes("corrupt line 2"))).toBe(true);
    } finally {
      capture.restore();
    }
  });

  test("a corrupt mid-file line is skipped with a warning; valid entries around it survive", async () => {
    const { store, dir } = setup();
    const meta = store.create("s1");
    const e1 = await store.append(meta.id, { type: "message", parentId: null, message: userMsg("hi") });
    const path = join(dir, `${meta.id}.jsonl`);
    appendFileSync(path, '{"id":"mangled","parentId":null,"type":"message",\n');
    const e2 = await store.append(meta.id, {
      type: "message",
      parentId: e1.id,
      message: userMsg("after corruption"),
    });

    const capture = captureWarnings();
    try {
      const loaded = store.load(meta.id);
      expect(loaded.map((e) => e.id)).toEqual([e1.id, e2.id]);
      expect(capture.warnings.some((w) => w.includes("corrupt line 2"))).toBe(true);
    } finally {
      capture.restore();
    }
  });

  test("a parseable line that is not a session entry is skipped with a warning", async () => {
    const { store, dir } = setup();
    const meta = store.create("s1");
    const e1 = await store.append(meta.id, { type: "message", parentId: null, message: userMsg("hi") });
    const path = join(dir, `${meta.id}.jsonl`);
    appendFileSync(path, '"just a string"\n');

    const capture = captureWarnings();
    try {
      const loaded = store.load(meta.id);
      expect(loaded.map((e) => e.id)).toEqual([e1.id]);
      expect(capture.warnings.some((w) => w.includes("not a session entry"))).toBe(true);
    } finally {
      capture.restore();
    }
  });

  test("latestTip breaks same-millisecond ties by creation order, deterministically", async () => {
    const { store } = setup();
    const meta = store.create("s1");
    const root = await store.append(meta.id, { type: "message", parentId: null, message: userMsg("root") });
    const a = await store.append(meta.id, { type: "message", parentId: root.id, message: userMsg("a") });
    const b = await store.append(meta.id, { type: "message", parentId: root.id, message: userMsg("b") });

    const sameMillisecond = new Date("2026-01-01T00:00:00.000Z").toISOString();
    const entries = store
      .load(meta.id)
      .map((e) => (e.id === root.id ? e : { ...e, createdAt: sameMillisecond }));

    expect(store.latestTip(entries)).toBe(b.id);
    expect(store.latestTip([...entries].reverse())).toBe(a.id);
  });

  test("unknown entry types round-trip verbatim (R5)", async () => {
    const { store } = setup();
    const meta = store.create("s1");
    const entry = await store.append(meta.id, {
      type: "future_entry_kind",
      parentId: null,
      someField: 42,
      nested: { a: [1, 2, 3] },
    });

    const loaded = store.load(meta.id);
    expect(loaded).toEqual([entry]);
    expect(loaded[0]?.type).toBe("future_entry_kind");
    expect(loaded[0]?.someField).toBe(42);
  });

  test("tips finds every leaf, and latestTip picks the most recently created one", async () => {
    const { store } = setup();
    const meta = store.create("s1");
    const root = await store.append(meta.id, { type: "message", parentId: null, message: userMsg("root") });
    const a = await store.append(meta.id, {
      type: "message",
      parentId: root.id,
      message: userMsg("branch a"),
    });
    const b = await store.append(meta.id, {
      type: "message",
      parentId: root.id,
      message: userMsg("branch b"),
    });

    const entries = store.load(meta.id);
    expect(new Set(store.tips(entries))).toEqual(new Set([a.id, b.id]));
    expect(store.latestTip(entries)).toBe(b.id);
  });

  test("messagesFor walks the chain to a tip and renders a compaction_summary as a synthetic message", async () => {
    const { store } = setup();
    const meta = store.create("s1");
    const root = await store.append(meta.id, {
      type: "message",
      parentId: null,
      message: userMsg("old stuff"),
    });
    const summary = await store.append(meta.id, {
      type: "compaction_summary",
      parentId: null,
      summary: "the user asked about X",
      replacedEntryIds: [root.id],
    });
    const tail = await store.append(meta.id, {
      type: "message",
      parentId: summary.id,
      message: userMsg("new stuff"),
    });

    const entries = store.load(meta.id);
    const messages = store.messagesFor(entries, tail.id);
    expect(messages).toHaveLength(2);
    const firstBlock = messages[0]?.content[0];
    expect(firstBlock).toMatchObject({ type: "text" });
    expect((firstBlock as { text: string }).text).toContain("the user asked about X");
    expect(messages[1]).toEqual(userMsg("new stuff"));
  });

  test("clone copies a session under a new id, independent of the original afterward", async () => {
    const { store } = setup();
    const meta = store.create("s1");
    await store.append(meta.id, { type: "message", parentId: null, message: userMsg("hi") });

    const cloned = store.clone(meta.id, "s2");
    await store.append(meta.id, { type: "message", parentId: null, message: userMsg("only in original") });

    expect(store.load(cloned.id)).toHaveLength(1);
    expect(store.load(meta.id)).toHaveLength(2);
  });

  test("list and delete", () => {
    const { store } = setup();
    store.create("s1");
    store.create("s2");
    expect(new Set(store.list())).toEqual(new Set(["s1", "s2"]));

    store.delete("s1");
    expect(store.list()).toEqual(["s2"]);
  });

  test("fork appends a branch_summary entry on a new branch and shares prior history", async () => {
    const { store } = setup();
    const meta = store.create("s1");
    const root = await store.append(meta.id, { type: "message", parentId: null, message: userMsg("root") });
    const a = await store.append(meta.id, {
      type: "message",
      parentId: root.id,
      message: userMsg("branch a"),
    });

    const forkEntry = await store.fork(meta.id, { fromTipId: root.id, label: "try another approach" });
    expect(forkEntry.type).toBe("branch_summary");
    expect(forkEntry.parentId).toBe(root.id);
    expect((forkEntry as { label: string }).label).toBe("try another approach");

    const entries = store.load(meta.id);
    // Both branch tips are leaves; the forked one is the newest.
    expect(new Set(store.tips(entries))).toEqual(new Set([a.id, forkEntry.id]));
    expect(store.latestTip(entries)).toBe(forkEntry.id);

    // The fork's chain carries the full prior history.
    const messages = store.messagesFor(entries, forkEntry.id);
    expect(messages).toEqual([userMsg("root")]);
  });

  test("fork defaults to the latest tip and a generic label", async () => {
    const { store } = setup();
    const meta = store.create("s1");
    const root = await store.append(meta.id, { type: "message", parentId: null, message: userMsg("root") });

    const forkEntry = await store.fork(meta.id);
    expect(forkEntry.parentId).toBe(root.id);
    expect((forkEntry as { label: string }).label).toBe("forked");
  });

  test("load sees entries appended by another store instance over the same directory", async () => {
    const { store, dir } = setup();
    const meta = store.create("s1");
    await store.append(meta.id, { type: "message", parentId: null, message: userMsg("first") });

    // Prime the first store's cache, then append through a second instance.
    expect(store.load(meta.id)).toHaveLength(1);
    const other = new SessionStore(dir);
    const second = await other.append(meta.id, {
      type: "message",
      parentId: null,
      message: userMsg("from the other process"),
    });

    const loaded = store.load(meta.id);
    expect(loaded).toHaveLength(2);
    expect(loaded[1]?.id).toBe(second.id);
  });

  test("concurrent appends from two store instances serialize and all entries survive", async () => {
    const { store, dir } = setup();
    const meta = store.create("s1");

    const a = new SessionStore(dir);
    const b = new SessionStore(dir);
    const appendThree = (s: SessionStore, prefix: string) =>
      Promise.all(
        [1, 2, 3].map((n) =>
          s.append(meta.id, { type: "message", parentId: null, message: userMsg(`${prefix}-${n}`) }),
        ),
      );

    await Promise.all([appendThree(a, "a"), appendThree(b, "b")]);

    const entries = store.load(meta.id);
    expect(entries).toHaveLength(6);
    expect(new Set(entries.map((e) => e.id))).toHaveLength(6);
    expect(store.tips(entries)).toHaveLength(6);
  });

  test("line numbers in corruption warnings stay file-accurate across incremental loads", async () => {
    const { store, dir } = setup();
    const meta = store.create("s1");
    await store.append(meta.id, { type: "message", parentId: null, message: userMsg("good") });
    appendFileSync(join(dir, `${meta.id}.jsonl`), '"garbage line"\n');

    const capture = captureWarnings();
    try {
      expect(store.load(meta.id)).toHaveLength(1);
      expect(store.load(meta.id)).toHaveLength(1);
      expect(capture.warnings.some((w) => w.includes("corrupt line 2"))).toBe(true);
    } finally {
      capture.restore();
    }
  });
});

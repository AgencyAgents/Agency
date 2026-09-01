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

describe("SessionStore", () => {
  test("appends and loads entries in order", () => {
    const { store } = setup();
    const meta = store.create("s1");
    const e1 = store.append(meta.id, { type: "message", parentId: null, message: userMsg("hi") });
    const e2 = store.append(meta.id, { type: "message", parentId: e1.id, message: userMsg("again") });

    const loaded = store.load(meta.id);
    expect(loaded.map((e) => e.id)).toEqual([e1.id, e2.id]);
  });

  test("crash recovery: a truncated trailing line is discarded, earlier entries survive", () => {
    const { store, dir } = setup();
    const meta = store.create("s1");
    const e1 = store.append(meta.id, { type: "message", parentId: null, message: userMsg("hi") });
    const path = join(dir, `${meta.id}.jsonl`);
    appendFileSync(path, '{"id":"broken","parentId":null,"type":"message","schemaVers'); // cut mid-write, no newline

    const loaded = store.load(meta.id);
    expect(loaded.map((e) => e.id)).toEqual([e1.id]);
  });

  test("unknown entry types round-trip verbatim (R5)", () => {
    const { store } = setup();
    const meta = store.create("s1");
    const entry = store.append(meta.id, {
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

  test("tips finds every leaf, and latestTip picks the most recently created one", () => {
    const { store } = setup();
    const meta = store.create("s1");
    const root = store.append(meta.id, { type: "message", parentId: null, message: userMsg("root") });
    const a = store.append(meta.id, { type: "message", parentId: root.id, message: userMsg("branch a") });
    const b = store.append(meta.id, { type: "message", parentId: root.id, message: userMsg("branch b") });

    const entries = store.load(meta.id);
    expect(new Set(store.tips(entries))).toEqual(new Set([a.id, b.id]));
    expect(store.latestTip(entries)).toBe(b.id);
  });

  test("messagesFor walks the chain to a tip and renders a compaction_summary as a synthetic message", () => {
    const { store } = setup();
    const meta = store.create("s1");
    const root = store.append(meta.id, { type: "message", parentId: null, message: userMsg("old stuff") });
    const summary = store.append(meta.id, {
      type: "compaction_summary",
      parentId: null,
      summary: "the user asked about X",
      replacedEntryIds: [root.id],
    });
    const tail = store.append(meta.id, {
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

  test("clone copies a session under a new id, independent of the original afterward", () => {
    const { store } = setup();
    const meta = store.create("s1");
    store.append(meta.id, { type: "message", parentId: null, message: userMsg("hi") });

    const cloned = store.clone(meta.id, "s2");
    store.append(meta.id, { type: "message", parentId: null, message: userMsg("only in original") });

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
});

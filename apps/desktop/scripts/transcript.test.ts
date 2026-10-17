import { expect, test } from "bun:test";
import { buildTurns, history, summarize, type Work } from "../src/lib/transcript.ts";
import type { Entry, Message } from "../src/lib/types.ts";

let n = 0;
const entry = (parentId: string | null, fields: Partial<Entry>): Entry => ({
  id: `e${++n}`,
  parentId,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
  type: "message",
  ...fields,
});
const msg = (role: Message["role"], content: Message["content"]): Partial<Entry> => ({
  message: { role, content },
});

test("a compacted session shows the replaced turns once, above the summary", () => {
  const a = entry(null, msg("user", [{ type: "text", text: "first" }]));
  const b = entry(a.id, msg("assistant", [{ type: "text", text: "one" }]));
  const c = entry(b.id, msg("user", [{ type: "text", text: "second" }]));
  const d = entry(c.id, msg("assistant", [{ type: "text", text: "two" }]));
  const sum = entry(null, { type: "compaction_summary", summary: "s", replacedEntryIds: [a.id, b.id] });
  // The kept tail is copied onto the summary under new ids.
  const c2 = entry(sum.id, { ...msg("user", [{ type: "text", text: "second" }]) });
  const d2 = entry(c2.id, msg("assistant", [{ type: "text", text: "two" }]));
  const e = entry(d2.id, msg("user", [{ type: "text", text: "third" }]));
  const entries = [a, b, c, d, sum, c2, d2, e];

  const turns = buildTurns(history(entries, e.id));
  expect(turns.map((t) => t.prompt)).toEqual(["first", "second", "third"]);
  expect(turns[0]?.parts.at(-1)).toEqual({ kind: "note", text: expect.stringContaining("summarized") });
});

test("thinking and tool calls keep their order inside one group, and usage gives the turn's stats", () => {
  const u = entry(null, msg("user", [{ type: "text", text: "go" }]));
  const a1 = entry(
    u.id,
    msg("assistant", [
      { type: "thinking", text: "plan" },
      { type: "tool_call", id: "t1", name: "read", input: { path: "src/a.ts" } },
    ]),
  );
  const r1 = entry(a1.id, msg("user", [{ type: "tool_result", toolCallId: "t1", content: "x" }]));
  const a2 = entry(
    r1.id,
    msg("assistant", [
      { type: "thinking", text: "next" },
      { type: "tool_call", id: "t2", name: "bash", input: { command: "ls" } },
      { type: "text", text: "done" },
    ]),
  );
  const usage = entry(a2.id, {
    type: "usage",
    model: "m1",
    usage: { inputTokens: 100, outputTokens: 40 },
    timing: { ttftMs: 300, streamMs: 2000, outputTokens: 40 },
  });
  const [turn] = buildTurns(history([u, a1, r1, a2, usage], usage.id));
  const work = turn?.parts[0] as Work;
  expect(work.items.map((i) => (i.kind === "tool" ? i.name : `thought:${i.text}`))).toEqual([
    "thought:plan",
    "read",
    "thought:next",
    "bash",
  ]);
  expect(turn?.parts[1]).toEqual({ kind: "text", text: "done" });
  expect(turn?.stats).toEqual({
    model: "m1",
    inputTokens: 100,
    outputTokens: 40,
    ttftMs: 300,
    streamMs: 2000,
  });
});

test("a message the harness sent mid-turn stays in that turn, so its usage and footer stay whole", () => {
  const u = entry(null, msg("user", [{ type: "text", text: "change a.ts" }]));
  const a = entry(u.id, msg("assistant", [{ type: "text", text: "done" }]));
  const h = entry(a.id, { ...msg("user", [{ type: "text", text: "Run the checks." }]), origin: "harness" });
  const b = entry(h.id, msg("assistant", [{ type: "text", text: "checked" }]));
  const usage = entry(b.id, { type: "usage", model: "m", usage: { inputTokens: 1, outputTokens: 2 } });
  const turns = buildTurns(history([u, a, h, b, usage], usage.id));
  expect(turns).toHaveLength(1);
  expect(turns[0]?.parts.map((p) => p.kind)).toEqual(["text", "aside", "text"]);
  expect(turns[0]?.stats?.outputTokens).toBe(2);
});

test("a group's summary names what it did and counts edited lines", () => {
  const tool = (id: string, name: string, input: Record<string, unknown>) =>
    ({ kind: "tool", id, name, input }) as const;
  const work: Work = {
    kind: "work",
    items: [
      tool("1", "bash", { command: "a" }),
      tool("2", "edit", { path: "src/App.tsx", oldText: "x", newText: "y\nz" }),
      tool("3", "bash", { command: "b" }),
      tool("4", "read", { path: "a.ts" }),
      tool("5", "read", { path: "b.ts" }),
      { kind: "thought", text: "hm" },
    ],
  };
  expect(summarize(work)).toEqual({
    text: "Ran 2 commands, edited App.tsx, read 2 files",
    added: 2,
    removed: 1,
  });
  expect(summarize({ kind: "work", items: [{ kind: "thought", text: "hm" }] }).text).toBe("Thought");
});

test("a message sent mid-turn shows inside that turn, not as a new prompt", () => {
  const u = entry(null, msg("user", [{ type: "text", text: "build it" }]));
  const a = entry(u.id, msg("assistant", [{ type: "text", text: "on it" }]));
  const s = entry(a.id, { ...msg("user", [{ type: "text", text: "use blue" }]), origin: "inbox" });
  const b = entry(s.id, msg("assistant", [{ type: "text", text: "blue it is" }]));
  const turns = buildTurns(history([u, a, s, b], b.id));
  expect(turns).toHaveLength(1);
  expect(turns[0]?.parts).toEqual([
    { kind: "text", text: "on it" },
    { kind: "said", text: "use blue" },
    { kind: "text", text: "blue it is" },
  ]);
});

test("line counts skip the empty line after a final newline, and files with one name in two folders count twice", () => {
  const tool = (id: string, name: string, input: Record<string, unknown>) =>
    ({ kind: "tool", id, name, input }) as const;
  const one: Work = {
    kind: "work",
    items: [
      tool("1", "write", { path: "src/a/index.ts", content: "a\nb\n" }),
      tool("2", "edit", { path: "src/a/index.ts", oldText: "a\n", newText: "x\ny\n" }),
    ],
  };
  expect(summarize(one)).toEqual({ text: "Wrote index.ts, edited index.ts", added: 4, removed: 1 });
  const two: Work = {
    kind: "work",
    items: [tool("1", "read", { path: "src/a/index.ts" }), tool("2", "read", { path: "src/b/index.ts" })],
  };
  expect(summarize(two).text).toBe("Read 2 files");
});

test("hook context the daemon put in the inbox shows as an aside, not as a message from the user", () => {
  const u = entry(null, msg("user", [{ type: "text", text: "hi" }]));
  const h = entry(u.id, {
    ...msg("user", [{ type: "text", text: "<hook-context>\nbranch: dev\n</hook-context>" }]),
    origin: "inbox",
  });
  const a = entry(h.id, msg("assistant", [{ type: "text", text: "hello" }]));
  const [turn] = buildTurns(history([u, h, a], a.id));
  expect(turn?.parts[0]).toEqual({ kind: "aside", label: "A hook added context", text: "branch: dev" });
});

test("a prompt shows without the reminder that the daemon stored with it", () => {
  const u = entry(
    null,
    msg("user", [
      { type: "text", text: "plan the change" },
      {
        type: "text",
        text: "<system-reminder>\n- [plan_mode] Read-only (plan) mode is active\n</system-reminder>",
      },
    ]),
  );
  expect(buildTurns(history([u], u.id)).map((t) => t.prompt)).toEqual(["plan the change"]);
});

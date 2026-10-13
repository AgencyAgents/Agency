import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FULL_CAPABILITIES } from "@agency/guard";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, StreamEvent } from "@agency/providers";
import { createApproximateTokenizer, Scheduler } from "@agency/providers";
import type { Message } from "@agency/schema";
import { AgencyError, ErrorCode } from "@agency/schema";
import { runTurn, type ToolSpec } from "../../src/loop.ts";
import {
  COMPACTION_TARGET_RATIO,
  COMPACTION_TRIGGER_RATIO,
  collapseTranscript,
  compact,
  countChainTokens,
  countChainTokensAsync,
  ensureOutputContract,
  isContextOverflowError,
  MAX_SUMMARY_CHUNKS,
  planCompaction,
  SUMMARY_CAP_TOKENS,
  shouldCompact,
  splitTranscriptToCap,
  summaryCapTokens,
  targetTokens,
  triggerTokens,
  truncateSummaryToCap,
} from "../../src/sessions/compaction.ts";
import { SessionStore } from "../../src/sessions/store.ts";
import { summarizeTranscript } from "../../src/sessions/summarize.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "agency-compaction-"));
  dirs.push(dir);
  return new SessionStore(dir);
}

function userMsg(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

describe("shouldCompact", () => {
  test("false under the proactive ratio, true at or above it", () => {
    expect(shouldCompact(79, { contextWindow: 100, proactiveRatio: 0.8 })).toBe(false);
    expect(shouldCompact(80, { contextWindow: 100, proactiveRatio: 0.8 })).toBe(true);
  });

  test("defaults to a 0.9 proactive trigger ratio", () => {
    expect(shouldCompact(850, { contextWindow: 1000 })).toBe(false);
    expect(shouldCompact(900, { contextWindow: 1000 })).toBe(true);
  });
});

describe("planCompaction", () => {
  test("keeps the last N messages and every todo_state entry out of the summary", () => {
    const chain = [
      { id: "1", parentId: null, schemaVersion: 1, createdAt: "t1", type: "message", message: userMsg("a") },
      { id: "2", parentId: "1", schemaVersion: 1, createdAt: "t2", type: "todo_state", todos: [] },
      { id: "3", parentId: "2", schemaVersion: 1, createdAt: "t3", type: "message", message: userMsg("b") },
      { id: "4", parentId: "3", schemaVersion: 1, createdAt: "t4", type: "message", message: userMsg("c") },
    ];
    const plan = planCompaction(chain, 1);
    expect(plan.summarize.map((e) => e.id)).toEqual(["1", "3"]);
    expect(plan.carryForward.map((e) => e.id)).toEqual(["2", "4"]);
  });
});

describe("compact", () => {
  test("the user's own messages stay word for word through two compactions", async () => {
    const store = setup();
    const meta = store.create("s1");
    const tokenizer = createApproximateTokenizer(1);
    let parentId: string | null = null;
    const say = async (role: "user" | "assistant", text: string) => {
      const entry = await store.append(meta.id, {
        type: "message",
        message: { role, content: [{ type: "text", text }] },
        parentId,
      });
      parentId = entry.id;
      return entry.id;
    };
    const fold = async () => {
      const outcome = await compact(
        store,
        meta.id,
        parentId ?? "",
        tokenizer,
        { contextWindow: 2000, proactiveRatio: 0.1 },
        async () => "The user asked for a refactor.",
        1,
      );
      expect(outcome.compacted).toBe(true);
      parentId = outcome.tipId;
      const first = store.messagesFor(store.load(meta.id), outcome.tipId)[0]?.content[0];
      return (first as { text: string }).text;
    };
    await say("user", "RULE-ONE: never edit the file billing.py");
    await say("assistant", "a".repeat(300));
    await say("user", "next step please");
    const once = await fold();
    expect(once).toContain("The user asked for a refactor.");
    expect(once).toContain("- RULE-ONE: never edit the file billing.py");

    await say("assistant", "b".repeat(300));
    await say("user", "RULE-TWO: run the tests with make check");
    await say("assistant", "c".repeat(300));
    await say("user", "go on");
    const twice = await fold();
    expect(twice).toContain("- RULE-ONE: never edit the file billing.py");
    expect(twice).toContain("- RULE-TWO: run the tests with make check");
    // One block, not a block inside a block.
    expect(twice.split("word for word").length).toBe(2);
  });

  test("summarizes the older portion, carries todos and the recent tail forward onto a new tip", async () => {
    const store = setup();
    const meta = store.create("s1");
    const tokenizer = createApproximateTokenizer(1); // 1 char/token, so thresholds are easy to hit deterministically

    let parentId: string | null = null;
    const append = async (entry: { type: string } & Record<string, unknown>) => {
      const e = await store.append(meta.id, { ...entry, parentId });
      parentId = e.id;
      return e;
    };

    await append({ type: "message", message: userMsg("x".repeat(50)) });
    await append({ type: "todo_state", todos: [{ id: "t1", content: "do the thing", status: "pending" }] });
    await append({ type: "message", message: userMsg("y".repeat(50)) });
    const lastMessage = await append({ type: "message", message: userMsg("z".repeat(50)) });

    const summaries: string[] = [];
    const result = await compact(
      store,
      meta.id,
      lastMessage.id,
      tokenizer,
      { contextWindow: 100, proactiveRatio: 0.5 },
      async (text) => {
        summaries.push(text);
        return "summary of old messages";
      },
      1, // keep only the last message out of the summary
    );

    expect(result.compacted).toBe(true);
    expect(summaries).toHaveLength(1);

    const entries = store.load(meta.id);
    const messages = store.messagesFor(entries, result.tipId);
    // synthetic summary message, then the preserved tail message
    expect(messages).toHaveLength(2);
    const firstBlock = messages[0]?.content[0];
    expect((firstBlock as { text: string }).text).toContain("summary of old messages");
    expect(messages[1]).toEqual(userMsg("z".repeat(50)));

    // the todo survived compaction, reachable on the new tip's chain
    const chain = store.chainFor(entries, result.tipId);
    expect(chain.some((e) => e.type === "todo_state")).toBe(true);
  });

  test("does nothing when under threshold", async () => {
    const store = setup();
    const meta = store.create("s1");
    const entry = await store.append(meta.id, { type: "message", parentId: null, message: userMsg("short") });
    const tokenizer = createApproximateTokenizer(3.5);

    const result = await compact(
      store,
      meta.id,
      entry.id,
      tokenizer,
      { contextWindow: 1_000_000 },
      async () => "unused",
    );

    expect(result.compacted).toBe(false);
    expect(result.tipId).toBe(entry.id);
  });

  const call = (id: string, pad = 0): Message => ({
    role: "assistant",
    content: [{ type: "tool_call", id, name: "read", input: { path: "p".repeat(pad) } }],
  });
  const result = (id: string): Message => ({
    role: "user",
    content: [{ type: "tool_result", toolCallId: id, content: "x".repeat(20), isError: false }],
  });

  /** Compacts the transcript and returns the ids of tool results whose call is gone. */
  async function resultsWithoutCall(transcript: Message[], contextWindow: number): Promise<string[]> {
    const store = setup();
    const meta = store.create("s1");
    let parentId: string | null = null;
    for (const message of transcript) {
      parentId = (await store.append(meta.id, { type: "message", parentId, message })).id;
    }
    const outcome = await compact(
      store,
      meta.id,
      parentId as unknown as string,
      createApproximateTokenizer(1),
      { contextWindow },
      async () => "summary",
      4,
      { force: true },
    );
    const seen = new Set<string>();
    const lost: string[] = [];
    for (const message of store.messagesFor(store.load(meta.id), outcome.tipId)) {
      for (const block of message.content) {
        if (block.type === "tool_call") seen.add(block.id);
        if (block.type === "tool_result" && !seen.has(block.toolCallId)) lost.push(block.toolCallId);
      }
    }
    return lost;
  }

  test("the summarizer's instructions stay out of the stored summary", async () => {
    const store = setup();
    const meta = store.create("s1");
    let parentId: string | null = null;
    for (const text of ["first request", "second", "third", "fourth", "fifth", "sixth"]) {
      parentId = (await store.append(meta.id, { type: "message", parentId, message: userMsg(text) })).id;
    }
    const given: Array<{ transcript: string; instructions: string }> = [];
    const outcome = await compact(
      store,
      meta.id,
      parentId as unknown as string,
      createApproximateTokenizer(1),
      { contextWindow: 1_000_000 },
      async (transcript, instructions) => {
        given.push({ transcript, instructions });
        return summarizeTranscript(transcript);
      },
      4,
      { force: true },
    );

    // The model reads this summary as a user message: "MUST NOT call tools" there would stop the agent.
    const summary = JSON.stringify(store.messagesFor(store.load(meta.id), outcome.tipId)[0]);
    expect(summary).toContain("first request");
    expect(summary).not.toContain("session summarizer");
    expect(summary).not.toContain("MUST NOT");
    expect(given[0]?.instructions).toContain("session summarizer");
  });

  test("the cut does not fall between a tool call and its result", async () => {
    // A turn that ended without a closing reply: the last four messages start with a tool result.
    const transcript = [
      userMsg("first"),
      call("c1"),
      result("c1"),
      call("c2"),
      result("c2"),
      userMsg("next"),
    ];
    expect(await resultsWithoutCall(transcript, 1_000_000)).toEqual([]);
  });

  test("the summary window never grows past a tool call alone, at any context size", async () => {
    const transcript = [userMsg("first"), userMsg("second"), call("c1", 300), result("c1"), userMsg("next")];
    const lost: Array<[number, string[]]> = [];
    for (let contextWindow = 100; contextWindow <= 1500; contextWindow += 25) {
      const ids = await resultsWithoutCall(transcript, contextWindow);
      if (ids.length > 0) lost.push([contextWindow, ids]);
    }
    expect(lost).toEqual([]);
  });
});

describe("countChainTokens", () => {
  test("counts text, thinking, tool_call, and tool_result blocks", () => {
    const tokenizer = createApproximateTokenizer(1);
    const chain = [
      {
        id: "1",
        parentId: null,
        schemaVersion: 1,
        createdAt: "t1",
        type: "message" as const,
        message: {
          role: "assistant" as const,
          content: [
            { type: "text" as const, text: "abc" },
            { type: "tool_call" as const, id: "c1", name: "read", input: { path: "x" } },
          ],
        },
      },
    ];
    expect(countChainTokens(chain, tokenizer)).toBeGreaterThan(0);
  });
});

describe("countChainTokensAsync", () => {
  test("falls through to sync counting for sync tokenizers", async () => {
    const tokenizer = createApproximateTokenizer(1);
    const chain = [
      {
        id: "1",
        parentId: null,
        schemaVersion: 1,
        createdAt: "t1",
        type: "message" as const,
        message: {
          role: "user" as const,
          content: [{ type: "text" as const, text: "abc" }],
        },
      },
    ];
    const result = await countChainTokensAsync(chain, tokenizer);
    expect(result).toBe(3);
  });

  test("counts text, thinking, tool_call, and tool_result blocks via async tokenizer", async () => {
    const asyncTokenizer = {
      precise: true,
      async: true as const,
      async count(text: string): Promise<number> {
        return Promise.resolve(text.length);
      },
    };
    const chain = [
      {
        id: "1",
        parentId: null,
        schemaVersion: 1,
        createdAt: "t1",
        type: "message" as const,
        message: {
          role: "assistant" as const,
          content: [
            { type: "text" as const, text: "abc" },
            { type: "tool_call" as const, id: "c1", name: "read", input: { path: "x" } },
          ],
        },
      },
    ];
    const result = await countChainTokensAsync(chain, asyncTokenizer);
    expect(result).toBeGreaterThan(0);
  });

  test("counts compaction summary entries via async tokenizer", async () => {
    const asyncTokenizer = {
      precise: true,
      async: true as const,
      async count(text: string): Promise<number> {
        return Promise.resolve(text.length);
      },
    };
    const chain = [
      {
        id: "1",
        parentId: null,
        schemaVersion: 1,
        createdAt: "t1",
        type: "compaction_summary" as const,
        summary: "hello world",
        replacedEntryIds: [],
      },
    ];
    const result = await countChainTokensAsync(chain, asyncTokenizer);
    expect(result).toBe(11); // "hello world" is 11 chars
  });
});

describe("compact bus emission", () => {
  test("emits session.compacted via getBus() when bus is set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agency-compaction-bus-"));
    dirs.push(dir);
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const bus = {
      emit: (event: string, payload: unknown) => {
        emitted.push({ event, payload });
      },
    };
    const store = new SessionStore(dir, { bus });
    const meta = store.create("s1");
    const tokenizer = createApproximateTokenizer(1);

    let parentId: string | null = null;
    const append = async (entry: { type: string } & Record<string, unknown>) => {
      const e = await store.append(meta.id, { ...entry, parentId });
      parentId = e.id;
      return e;
    };

    await append({ type: "message", message: userMsg("x".repeat(50)) });
    await append({ type: "message", message: userMsg("y".repeat(50)) });
    const last = await append({ type: "message", message: userMsg("z".repeat(50)) });

    const result = await compact(
      store,
      meta.id,
      last.id,
      tokenizer,
      { contextWindow: 100, proactiveRatio: 0.5 },
      async () => "summary",
      1,
    );

    expect(result.compacted).toBe(true);
    expect(emitted.length).toBeGreaterThanOrEqual(1);
    expect(emitted.some((e) => e.event === "session.compacted")).toBe(true);
  });

  test("does not crash when no bus is set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agency-compaction-nobus-"));
    dirs.push(dir);
    const store = new SessionStore(dir);
    const meta = store.create("s1");
    const tokenizer = createApproximateTokenizer(1);

    let parentId: string | null = null;
    const append = async (entry: { type: string } & Record<string, unknown>) => {
      const e = await store.append(meta.id, { ...entry, parentId });
      parentId = e.id;
      return e;
    };

    await append({ type: "message", message: userMsg("x".repeat(50)) });
    await append({ type: "message", message: userMsg("y".repeat(50)) });
    const last = await append({ type: "message", message: userMsg("z".repeat(50)) });

    const result = await compact(
      store,
      meta.id,
      last.id,
      tokenizer,
      { contextWindow: 100, proactiveRatio: 0.5 },
      async () => "summary",
      1,
    );

    expect(result.compacted).toBe(true);
  });
});

function assistantMsg(text: string): Message {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function asyncExactTokenizer() {
  return {
    precise: true,
    async: true as const,
    count: async (text: string): Promise<number> => text.length,
  };
}

describe("U8 two-stage compaction constants", () => {
  test("90 percent trigger and 70 percent target with 20K summary cap", () => {
    expect(COMPACTION_TRIGGER_RATIO).toBe(0.9);
    expect(COMPACTION_TARGET_RATIO).toBe(0.7);
    expect(SUMMARY_CAP_TOKENS).toBe(20_000);
    expect(triggerTokens({ contextWindow: 1000 })).toBe(900);
    expect(targetTokens({ contextWindow: 1000 })).toBe(700);
    expect(summaryCapTokens({ contextWindow: 1000 })).toBe(20_000);
    expect(summaryCapTokens({ contextWindow: 1000, summaryCapTokens: 50 })).toBe(50);
  });

  test("trigger boundary holds under an explicit ratio", () => {
    expect(shouldCompact(89, { contextWindow: 100, proactiveRatio: 0.9 })).toBe(false);
    expect(shouldCompact(90, { contextWindow: 100, proactiveRatio: 0.9 })).toBe(true);
  });
});

describe("U8 tokenizer source of truth", () => {
  test("async exact tokenizer wins when available, sync approximate otherwise", async () => {
    const chain = [
      {
        id: "1",
        parentId: null,
        schemaVersion: 1,
        createdAt: "t1",
        type: "message" as const,
        message: userMsg("abcdefgh"),
      },
    ];
    const exact = await countChainTokensAsync(chain, asyncExactTokenizer());
    expect(exact).toBe(8);
    const approx = countChainTokens(chain, createApproximateTokenizer(4));
    expect(approx).toBe(2);
    expect(exact).not.toBe(approx);
  });
});

describe("U8 deterministic collapse (stage one)", () => {
  test("keeps 3 recent assistant texts verbatim, folds old tool pairs, strips images", () => {
    const oldToolInput = JSON.stringify({ path: "old-secret-path.ts" });
    const imageData = "aGVsbG8td29ybGQtaW1hZ2UtZGF0YQ==";
    const chain = [
      {
        id: "1",
        parentId: null,
        schemaVersion: 1,
        createdAt: "t1",
        type: "message",
        message: assistantMsg("old-one"),
      },
      {
        id: "2",
        parentId: "1",
        schemaVersion: 1,
        createdAt: "t2",
        type: "message",
        message: {
          role: "assistant" as const,
          content: [
            { type: "tool_call" as const, id: "c1", name: "read", input: { path: "old-secret-path.ts" } },
          ],
        },
      },
      {
        id: "3",
        parentId: "2",
        schemaVersion: 1,
        createdAt: "t3",
        type: "message",
        message: {
          role: "user" as const,
          content: [
            {
              type: "tool_result" as const,
              toolCallId: "c1",
              content: "old tool output",
              images: [{ type: "image" as const, mimeType: "image/png", data: imageData }],
            },
          ],
        },
      },
      {
        id: "4",
        parentId: "3",
        schemaVersion: 1,
        createdAt: "t4",
        type: "message",
        message: {
          role: "user" as const,
          content: [{ type: "image" as const, mimeType: "image/png", data: imageData }],
        },
      },
      {
        id: "5",
        parentId: "4",
        schemaVersion: 1,
        createdAt: "t5",
        type: "message",
        message: assistantMsg("old-two"),
      },
      {
        id: "6",
        parentId: "5",
        schemaVersion: 1,
        createdAt: "t6",
        type: "message",
        message: assistantMsg("keep-one"),
      },
      {
        id: "7",
        parentId: "6",
        schemaVersion: 1,
        createdAt: "t7",
        type: "message",
        message: assistantMsg("keep-two"),
      },
      {
        id: "8",
        parentId: "7",
        schemaVersion: 1,
        createdAt: "t8",
        type: "message",
        message: assistantMsg("keep-three"),
      },
    ];
    const collapsed = collapseTranscript(chain, 3);
    expect(collapsed.verbatimAssistantTexts).toEqual(["keep-one", "keep-two", "keep-three"]);
    expect(collapsed.text).toContain("keep-one");
    expect(collapsed.text).toContain("keep-two");
    expect(collapsed.text).toContain("keep-three");
    expect(collapsed.text).not.toContain("old-secret-path.ts");
    expect(collapsed.text).not.toContain(oldToolInput);
    expect(collapsed.text).not.toContain(imageData);
    expect(collapsed.collapsedToolPairs).toBeGreaterThanOrEqual(1);
    expect(collapsed.strippedAttachments).toBeGreaterThanOrEqual(2);
  });
});

describe("U8 summary cap (20K)", () => {
  test("truncateSummaryToCap keeps short text and cuts long text (sync approximate tokenizer)", () => {
    const count = (text: string) => createApproximateTokenizer(1).count(text);
    expect(truncateSummaryToCap("short", count, 50)).toBe("short");
    const cut = truncateSummaryToCap("x".repeat(200), count, 50);
    expect(count(cut)).toBeLessThanOrEqual(50);
    expect(cut).toContain("truncated");
  });

  test("splitTranscriptToCap bounds every chunk and honors the hard chunk cap (sync approximate tokenizer)", () => {
    const count = (text: string) => createApproximateTokenizer(1).count(text);
    const lines = Array.from({ length: 20 }, (_, i) => `line-${i}-`.padEnd(30, "z"));
    const chunks = splitTranscriptToCap(lines.join("\n"), count, 100);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThanOrEqual(MAX_SUMMARY_CHUNKS);
    for (const chunk of chunks) expect(count(chunk)).toBeLessThanOrEqual(100);
    expect(chunks.join("\n").split("\n")).toHaveLength(20);
  });

  test("compact truncates an over-cap agentic summary (sync approximate tokenizer)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agency-compaction-cap-"));
    dirs.push(dir);
    const store = new SessionStore(dir);
    const meta = store.create("s1");
    const tokenizer = createApproximateTokenizer(1);
    let parentId: string | null = null;
    const append = async (entry: { type: string } & Record<string, unknown>) => {
      const e = await store.append(meta.id, { ...entry, parentId });
      parentId = e.id;
      return e;
    };
    await append({ type: "message", message: userMsg("x".repeat(60)) });
    await append({ type: "message", message: userMsg("y".repeat(60)) });
    const last = await append({ type: "message", message: userMsg("z".repeat(10)) });
    const result = await compact(
      store,
      meta.id,
      last.id,
      tokenizer,
      { contextWindow: 100, proactiveRatio: 0.5, summaryCapTokens: 40 },
      async () => "s".repeat(500),
      1,
    );
    expect(result.compacted).toBe(true);
    const entries = store.load(meta.id);
    const chain = store.chainFor(entries, result.tipId);
    const summary = chain.find((e) => e.type === "compaction_summary");
    expect(summary).toBeDefined();
    expect(tokenizer.count((summary as unknown as { summary: string }).summary)).toBeLessThanOrEqual(40);
    expect((summary as unknown as { summary: string }).summary).toContain("[Compacted:");
  });

  test("compact counts the cap with the async exact tokenizer when available (async exact tokenizer)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agency-compaction-cap-async-"));
    dirs.push(dir);
    const store = new SessionStore(dir);
    const meta = store.create("s1");
    const tokenizer = asyncExactTokenizer();
    let parentId: string | null = null;
    const append = async (entry: { type: string } & Record<string, unknown>) => {
      const e = await store.append(meta.id, { ...entry, parentId });
      parentId = e.id;
      return e;
    };
    await append({ type: "message", message: userMsg("x".repeat(60)) });
    await append({ type: "message", message: userMsg("y".repeat(60)) });
    const last = await append({ type: "message", message: userMsg("z".repeat(10)) });
    const result = await compact(
      store,
      meta.id,
      last.id,
      tokenizer,
      { contextWindow: 100, proactiveRatio: 0.5, summaryCapTokens: 40 },
      async () => "s".repeat(500),
      1,
    );
    expect(result.compacted).toBe(true);
    const entries = store.load(meta.id);
    const chain = store.chainFor(entries, result.tipId);
    const summary = chain.find((e) => e.type === "compaction_summary") as unknown as { summary: string };
    expect(summary.summary.length).toBeLessThanOrEqual(40);
  });
});

describe("U8 output contract", () => {
  test("ensureOutputContract appends [Compacted: n turns -> m sections] once", () => {
    expect(ensureOutputContract("digest", 5, 2)).toBe("digest\n[Compacted: 5 turns -> 2 sections]");
    const once = ensureOutputContract("digest", 5, 2);
    expect(ensureOutputContract(once, 5, 2)).toBe(once);
    // Seen from a live model: one turn and one section, written in the singular.
    const singular = "digest\n[Compacted: 1 turn -> 1 section]";
    expect(ensureOutputContract(singular, 5, 2)).toBe(singular);
  });
});

describe("U8 seventy percent target", () => {
  test("compact lands at or under 70 percent of the window (sync approximate tokenizer)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agency-compaction-target-"));
    dirs.push(dir);
    const store = new SessionStore(dir);
    const meta = store.create("s1");
    const tokenizer = createApproximateTokenizer(1);
    let parentId: string | null = null;
    const append = async (entry: { type: string } & Record<string, unknown>) => {
      const e = await store.append(meta.id, { ...entry, parentId });
      parentId = e.id;
      return e;
    };
    for (let i = 0; i < 10; i++)
      await append({ type: "message", message: userMsg(`m${i}-`.padEnd(95, "x")) });
    const entries0 = store.load(meta.id);
    const tip0 = entries0[entries0.length - 1]!.id;
    const before = countChainTokens(store.chainFor(entries0, tip0), tokenizer);
    expect(before).toBeGreaterThanOrEqual(triggerTokens({ contextWindow: 1000 }));
    let calls = 0;
    const result = await compact(
      store,
      meta.id,
      tip0,
      tokenizer,
      { contextWindow: 1000 },
      async (text) => {
        calls += 1;
        return `digest-${calls}-${text.slice(0, 40)}`;
      },
      8,
    );
    expect(result.compacted).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(2);
    const entries = store.load(meta.id);
    const after = countChainTokens(store.chainFor(entries, result.tipId), tokenizer);
    expect(after).toBeLessThanOrEqual(targetTokens({ contextWindow: 1000 }));
  });

  test("compact reaches target in one pass when the tail already fits (async exact tokenizer)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agency-compaction-target-async-"));
    dirs.push(dir);
    const store = new SessionStore(dir);
    const meta = store.create("s1");
    const tokenizer = asyncExactTokenizer();
    let parentId: string | null = null;
    const append = async (entry: { type: string } & Record<string, unknown>) => {
      const e = await store.append(meta.id, { ...entry, parentId });
      parentId = e.id;
      return e;
    };
    for (let i = 0; i < 10; i++)
      await append({ type: "message", message: userMsg(`m${i}-`.padEnd(95, "x")) });
    const entries0 = store.load(meta.id);
    const tip0 = entries0[entries0.length - 1]!.id;
    let calls = 0;
    const result = await compact(
      store,
      meta.id,
      tip0,
      tokenizer,
      { contextWindow: 1000 },
      async () => {
        calls += 1;
        return "short digest";
      },
      4,
    );
    expect(result.compacted).toBe(true);
    expect(calls).toBe(1);
    const entries = store.load(meta.id);
    const after = await countChainTokensAsync(store.chainFor(entries, result.tipId), tokenizer);
    expect(after).toBeLessThanOrEqual(700);
  });
});

describe("U8 overflow classification", () => {
  test("isContextOverflowError matches only context_overflow", () => {
    expect(isContextOverflowError(new AgencyError(ErrorCode.CONTEXT_OVERFLOW, "full", { source: "t" }))).toBe(
      true,
    );
    expect(isContextOverflowError(new AgencyError(ErrorCode.RATE_LIMIT, "slow", { source: "t" }))).toBe(
      false,
    );
    expect(isContextOverflowError(new Error("boom"))).toBe(false);
    expect(isContextOverflowError(undefined)).toBe(false);
  });

  test("pins the adapter-normalization contract: overflow always arrives coded", () => {
    // Every adapter maps provider overflow to CONTEXT_OVERFLOW before throwing
    // (anthropic.ts:141, google.ts:128, openai-compatible.ts:142 covering openai.ts), so code check is enough.
    for (const source of ["anthropic", "google", "openai"]) {
      expect(
        isContextOverflowError(new AgencyError(ErrorCode.CONTEXT_OVERFLOW, "context full", { source })),
      ).toBe(true);
    }
    expect(
      isContextOverflowError(new AgencyError(ErrorCode.TRANSIENT, "context full", { source: "anthropic" })),
    ).toBe(false);
  });
});

const noopHttp: HttpClient = { fetch: async () => new Response() };
const overflowUser = { type: "user" as const };

function overflowThenSuccessAdapter(): ProviderAdapter {
  let calls = 0;
  return {
    family: "fake",
    async *stream(): AsyncIterable<StreamEvent> {
      calls += 1;
      if (calls === 1) {
        throw new AgencyError(ErrorCode.CONTEXT_OVERFLOW, "context full", { source: "fake" });
      }
      yield { type: "text_delta", text: "recovered" };
      yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
}

function alwaysOverflowAdapter(): ProviderAdapter {
  return {
    family: "fake",
    stream(): AsyncIterable<StreamEvent> {
      throw new AgencyError(ErrorCode.CONTEXT_OVERFLOW, "context full", { source: "fake" });
    },
  };
}

describe("U8 overflow compact and single retry", () => {
  test("overflow compacts once then retries once (sync approximate tokenizer)", async () => {
    let compactions = 0;
    const scheduler = new Scheduler();
    const result = await runTurn(overflowThenSuccessAdapter(), scheduler, noopHttp, {
      identity: overflowUser,
      capabilities: FULL_CAPABILITIES,
      systemPrompt: "sys",
      tools: [],
      model: "test-model",
      apiKey: "key",
      session: [],
      onContextOverflow: async () => {
        compactions += 1;
      },
    });
    expect(compactions).toBe(1);
    expect(result.stopReason).toBe("end_turn");
    expect(result.messages).toHaveLength(1);
  });

  test("a second overflow propagates with no further retry (sync approximate tokenizer)", async () => {
    let compactions = 0;
    const scheduler = new Scheduler();
    await expect(
      runTurn(alwaysOverflowAdapter(), scheduler, noopHttp, {
        identity: overflowUser,
        capabilities: FULL_CAPABILITIES,
        systemPrompt: "sys",
        tools: [],
        model: "test-model",
        apiKey: "key",
        session: [],
        onContextOverflow: async () => {
          compactions += 1;
        },
      }),
    ).rejects.toThrow("context full");
    expect(compactions).toBe(1);
  });

  test("overflow without a hook throws immediately (sync approximate tokenizer)", async () => {
    const scheduler = new Scheduler();
    await expect(
      runTurn(alwaysOverflowAdapter(), scheduler, noopHttp, {
        identity: overflowUser,
        capabilities: FULL_CAPABILITIES,
        systemPrompt: "sys",
        tools: [],
        model: "test-model",
        apiKey: "key",
        session: [],
      }),
    ).rejects.toThrow("context full");
  });

  /** A turn of `steps` tool calls; the request that follows each step in `overflowAfter` fails once. */
  function longTurn(steps: number, overflowAfter: number[]) {
    const state = { runs: 0, requests: [] as Message[][] };
    const pending = new Set(overflowAfter);
    const tool: ToolSpec = {
      name: "count",
      description: "counts its own runs",
      inputSchema: {},
      riskTier: "safe",
      handler: async () => {
        state.runs += 1;
        return { content: `run ${state.runs}` };
      },
    };
    const adapter: ProviderAdapter = {
      family: "fake",
      async *stream(request): AsyncIterable<StreamEvent> {
        state.requests.push([...request.messages]);
        if (pending.delete(state.runs)) {
          throw new AgencyError(ErrorCode.CONTEXT_OVERFLOW, "context full", { source: "fake" });
        }
        if (state.runs < steps) {
          const id = `c${state.runs + 1}`;
          yield { type: "tool_call_start", id, name: "count" };
          yield { type: "tool_call_delta", id, inputJsonDelta: "{}" };
          yield { type: "tool_call_end", id };
          yield { type: "message_stop", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } };
          return;
        }
        yield { type: "text_delta", text: "done" };
        yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const run = () =>
      runTurn(adapter, new Scheduler(), noopHttp, {
        identity: overflowUser,
        capabilities: FULL_CAPABILITIES,
        systemPrompt: "sys",
        tools: [tool],
        model: "test-model",
        apiKey: "key",
        session: [userMsg("count")],
      });
    return { state, run };
  }

  test("overflow without a hook folds the transcript in memory: the turn keeps its last steps", async () => {
    const { state, run } = longTurn(3, [3]);
    const result = await run();

    expect(result.stopReason).toBe("end_turn");
    expect(state.runs).toBe(3);
    const retried = JSON.stringify(state.requests.at(-1));
    expect(retried).toContain("[earlier conversation compacted]");
    expect(retried).toContain("run 3");
    // The request before the retry is the summary request: the one that overflowed is the longest.
    const overflowed = Math.max(...state.requests.map((request) => request.length));
    expect(state.requests.at(-1)?.length).toBeLessThan(overflowed);
  });

  test("a long turn can fold more than once: the limit is one fold for each request", async () => {
    const { state, run } = longTurn(6, [3, 6]);
    const result = await run();

    expect(result.stopReason).toBe("end_turn");
    expect(state.runs).toBe(6);
  });
});

describe("removal of old tool output before a summary", () => {
  const noSummary = async (): Promise<string> => {
    throw new Error("the summarizer must not run");
  };
  const tokenizer = createApproximateTokenizer();
  async function longSession(store: SessionStore): Promise<string> {
    store.create("s");
    let tip = (await store.append("s", { type: "message", parentId: null, message: userMsg("the task") })).id;
    for (let i = 0; i < 6; i++) {
      const id = `c${i}`;
      tip = (
        await store.append("s", {
          type: "message",
          parentId: tip,
          message: {
            role: "assistant",
            content: [{ type: "tool_call", id, name: "read", input: { path: id } }],
          },
        })
      ).id;
      tip = (
        await store.append("s", {
          type: "message",
          parentId: tip,
          message: {
            role: "user",
            content: [
              { type: "tool_result", toolCallId: id, content: `${id} `.repeat(1000), isError: false },
            ],
          },
        })
      ).id;
    }
    return tip;
  }
  const resultTexts = (store: SessionStore, tipId: string): string[] =>
    store
      .messagesFor(store.load("s"), tipId)
      .flatMap((message) => message.content)
      .flatMap((block) => (block.type === "tool_result" ? [block.content] : []));

  test("old results become one line each with no model call; the newest stay, and so does the user text", async () => {
    const store = setup();
    const tip = await longSession(store);
    const before = countChainTokens(store.chainFor(store.load("s"), tip), tokenizer);
    const threshold = { contextWindow: Math.ceil(before / 0.95) };
    const outcome = await compact(store, "s", tip, tokenizer, threshold, noSummary);
    expect(outcome.compacted).toBe(true);
    const chain = store.chainFor(store.load("s"), outcome.tipId);
    expect(countChainTokens(chain, tokenizer)).toBeLessThanOrEqual(targetTokens(threshold));
    expect(chain.some((entry) => entry.type === "compaction_summary")).toBe(false);
    const texts = resultTexts(store, outcome.tipId);
    expect(texts).toHaveLength(6);
    expect(texts[0]).toMatch(/^\[output removed to save context: 3000 chars/);
    expect(texts[5]).toBe("c5 ".repeat(1000));
    expect(store.messagesFor(store.load("s"), outcome.tipId)[0]).toEqual(userMsg("the task"));
    // A second call has nothing more to remove and is under the trigger.
    const again = await compact(store, "s", outcome.tipId, tokenizer, threshold, noSummary);
    expect(again.compacted).toBe(false);
  });

  test("a compaction that the user asked for summarizes, and so does one where removal is not enough", async () => {
    const store = setup();
    const tip = await longSession(store);
    let calls = 0;
    const summarize = async (): Promise<string> => {
      calls += 1;
      return "summary";
    };
    const manual = await compact(store, "s", tip, tokenizer, { contextWindow: 10_000 }, summarize, 4, {
      force: true,
      trigger: "manual",
    });
    expect(manual.compacted).toBe(true);
    expect(calls).toBeGreaterThan(0);
    calls = 0;
    // The window is too small for the texts that removal leaves.
    const small = await compact(store, "s", tip, tokenizer, { contextWindow: 40 }, summarize);
    expect(small.compacted).toBe(true);
    expect(calls).toBeGreaterThan(0);
  });
});

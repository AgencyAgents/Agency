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
import { runTurn } from "../../src/loop.ts";
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
});

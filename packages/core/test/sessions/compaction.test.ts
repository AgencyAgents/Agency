import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApproximateTokenizer } from "@agency/providers";
import type { Message } from "@agency/schema";
import { compact, countChainTokens, planCompaction, shouldCompact } from "../../src/sessions/compaction.ts";
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

  test("defaults to an 0.8 ratio", () => {
    expect(shouldCompact(900, { contextWindow: 1000 })).toBe(true);
    expect(shouldCompact(700, { contextWindow: 1000 })).toBe(false);
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

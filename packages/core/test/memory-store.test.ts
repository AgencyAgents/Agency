import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_FACT_CHARS, MemoryStore } from "../src/sessions/memory.ts";
import { SessionStore } from "../src/sessions/store.ts";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function makeDirs(): string {
  const base = mkdtempSync(join(tmpdir(), "agency-memory-"));
  dirs.push(base);
  const sessions = join(base, "sessions");
  mkdirSync(sessions, { recursive: true });
  return sessions;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("memory store", () => {
  it("records facts and recalls them in the same instance", async () => {
    const mem = new MemoryStore(makeDirs());
    const fact = await mem.record("sess-a", "user prefers bun over npm", "turn");
    expect(fact.sessionId).toBe("sess-a");
    expect(fact.source).toBe("turn");
    const facts = await mem.recall("sess-a");
    expect(facts.length).toBe(1);
    expect(facts[0]?.text).toBe("user prefers bun over npm");
  });

  it("survives daemon restart via load-on-boot", async () => {
    const dir = makeDirs();
    const first = new MemoryStore(dir);
    await first.record("sess-a", "fact one", "turn");
    await first.record("sess-a", "fact two", "turn");

    const second = new MemoryStore(dir);
    const facts = await second.recall("sess-a");
    expect(facts.map((f) => f.text)).toEqual(["fact one", "fact two"]);
  });

  it("skips corrupt memory lines with a warning, session intact", async () => {
    const dir = makeDirs();
    const mem = new MemoryStore(dir);
    await mem.record("sess-a", "good fact", "turn");
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]): void => {
      warnings.push(String(args[0]));
    };
    try {
      appendFileSync(join(dir, "sess-a.memory.jsonl"), "not-json{{{bad\n");
      appendFileSync(join(dir, "sess-a.memory.jsonl"), '{"id":"x","nope":true}\n');
      const fresh = new MemoryStore(dir);
      const facts = await fresh.recall("sess-a");
      expect(facts.map((f) => f.text)).toEqual(["good fact"]);
      expect(warnings.some((w) => w.includes("corrupt memory line"))).toBe(true);
      expect(warnings.some((w) => w.includes("shape or session mismatch"))).toBe(true);
    } finally {
      console.warn = orig;
    }
  });

  it("isolates facts per session", async () => {
    const dir = makeDirs();
    const mem = new MemoryStore(dir);
    await mem.record("sess-a", "alpha", "turn");
    await mem.record("sess-b", "beta", "turn");
    expect((await mem.recall("sess-a")).map((f) => f.text)).toEqual(["alpha"]);
    expect((await mem.recall("sess-b")).map((f) => f.text)).toEqual(["beta"]);
  });

  it("caps oversized fact text with a marker", async () => {
    const mem = new MemoryStore(makeDirs());
    const fact = await mem.record("sess-a", "x".repeat(MAX_FACT_CHARS + 100), "turn");
    expect(fact.text.length).toBeLessThanOrEqual(MAX_FACT_CHARS);
    expect(fact.text.endsWith("[truncated]")).toBe(true);
  });

  it("indexes compaction summaries through the append hook", async () => {
    const dir = makeDirs();
    const store = new SessionStore(dir);
    const mem = new MemoryStore(dir);
    const detach = mem.attach(store);
    try {
      await store.append("sess-a", { type: "message", parentId: null, message: { role: "user", content: [] } });
      expect(await mem.recall("sess-a")).toEqual([]);
      await store.append("sess-a", {
        type: "compaction_summary",
        parentId: null,
        summary: "user likes dark mode",
        replacedEntryIds: [],
      });
      await flush();
      const facts = await mem.recall("sess-a");
      expect(facts.length).toBe(1);
      expect(facts[0]?.text).toBe("user likes dark mode");
      expect(facts[0]?.source.startsWith("compaction:")).toBe(true);
    } finally {
      detach();
    }
  });

  it("a throwing listener never breaks session append", async () => {
    const store = new SessionStore(makeDirs());
    store.addAppendListener(() => {
      throw new Error("boom");
    });
    const entry = await store.append("sess-a", { type: "message", parentId: null });
    expect(entry.id.length).toBeGreaterThan(0);
    expect(store.load("sess-a").length).toBe(1);
  });

  it("memory sidecars stay out of session list and die with delete", async () => {
    const dir = makeDirs();
    const store = new SessionStore(dir);
    const mem = new MemoryStore(dir);
    mem.attach(store);
    store.create("sess-a");
    await mem.record("sess-a", "sticky fact", "turn");
    expect(store.list()).toEqual(["sess-a"]);
    store.delete("sess-a");
    expect(store.list()).toEqual([]);
  });

  it("malformed inputs: empty text rejects, blank sidecar loads empty", async () => {
    const dir = makeDirs();
    const mem = new MemoryStore(dir);
    await expect(mem.record("sess-a", "   ", "turn")).rejects.toThrow(/non-empty/);
    writeFileSync(join(dir, "sess-a.memory.jsonl"), "\n\n", "utf8");
    expect(await mem.recall("sess-a")).toEqual([]);
  });
});

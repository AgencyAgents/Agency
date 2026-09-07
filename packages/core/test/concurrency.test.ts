import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FULL_CAPABILITIES } from "@agency/guard";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, StreamEvent } from "@agency/providers";
import { Scheduler } from "@agency/providers";
import { runTurn } from "../src/loop.ts";
import { SessionStore } from "../src/sessions/store.ts";

const noopHttp: HttpClient = { fetch: async () => new Response() };
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(p: string): string {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("concurrency", () => {
  test("concurrent runTurn: two turns in one process, isolated state", async () => {
    const barrier = deferred<void>();
    let entered = 0;
    const adapter: ProviderAdapter = {
      family: "fake",
      async *stream(): AsyncIterable<StreamEvent> {
        entered += 1;
        if (entered === 1) await barrier.promise;
        yield { type: "text_delta", text: `reply-${entered}` };
        yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const scheduler = new Scheduler({ maxConcurrent: 4, requestsPerMinute: 6000 });

    const p1 = runTurn(adapter, scheduler, noopHttp, {
      identity: { type: "user" },
      capabilities: FULL_CAPABILITIES,
      systemPrompt: "sys",
      tools: [],
      model: "m",
      apiKey: "k",
      session: [{ role: "user", content: [{ type: "text", text: "hello 1" }] }],
    });
    const p2 = runTurn(adapter, scheduler, noopHttp, {
      identity: { type: "user" },
      capabilities: FULL_CAPABILITIES,
      systemPrompt: "sys",
      tools: [],
      model: "m",
      apiKey: "k",
      session: [{ role: "user", content: [{ type: "text", text: "hello 2" }] }],
    });

    await new Promise((r) => setTimeout(r, 50));
    barrier.resolve();

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.messages.length).toBe(2);
    expect(r2.messages.length).toBe(2);
    expect(r1.messages[1]!.content[0]).toBeDefined();
    expect(r2.messages[1]!.content[0]).toBeDefined();
  }, 10000);

  test("concurrent session append: interleaved appends don't corrupt", async () => {
    const dir = tmp("agency-concur-sess-");
    const store = new SessionStore(dir);
    store.create("s1");
    const first = await store.append("s1", {
      type: "message",
      parentId: null,
      message: { role: "user", content: [{ type: "text", text: "root" }] },
    });

    const N = 20;
    const appends = Array.from({ length: N }, (_, i) =>
      store.append("s1", {
        type: "message",
        parentId: first.id,
        message: { role: "user", content: [{ type: "text", text: `msg-${i}` }] },
      }),
    );
    const results = await Promise.all(appends);
    expect(results).toHaveLength(N);
    const entries = store.load("s1");
    expect(entries.length).toBe(1 + N);
    const ids = new Set(results.map((r) => r.id));
    expect(ids.size).toBe(N);
  }, 10000);
});

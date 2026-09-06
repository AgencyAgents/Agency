import { describe, expect, test } from "bun:test";
import { createHttpGateway } from "../src/http-gateway.ts";

function eventsRequest(path: string, lastEventId?: string): Request {
  return new Request(`http://127.0.0.1${path}`, {
    headers: lastEventId === undefined ? {} : { "Last-Event-ID": lastEventId },
  });
}

interface OpenStream {
  acc: string;
  pull: (timeoutMs?: number) => Promise<boolean>;
  ids: () => number[];
  close: () => Promise<void>;
}

async function openStream(res: Response): Promise<OpenStream> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let acc = "";
  return {
    get acc() {
      return acc;
    },
    async pull(timeoutMs = 2_000) {
      let timerId: ReturnType<typeof setTimeout> | undefined;
      const timer = new Promise<"timeout">((resolve) => {
        timerId = setTimeout(() => resolve("timeout"), timeoutMs);
      });
      try {
        const result = await Promise.race([reader.read(), timer]);
        if (result === "timeout" || result.done) return false;
        acc += decoder.decode(result.value, { stream: true });
        return true;
      } finally {
        clearTimeout(timerId);
      }
    },
    ids() {
      return [...acc.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    },
    async close() {
      await reader.cancel().catch(() => {});
    },
  };
}

async function pullUntil(stream: OpenStream, until: (acc: string) => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !until(stream.acc)) {
    await stream.pull(Math.max(deadline - Date.now(), 1));
  }
  if (!until(stream.acc)) throw new Error(`SSE condition unmet; got: ${JSON.stringify(stream.acc)}`);
}

function stateData(acc: string): Record<string, unknown> {
  const match = acc.match(/^event: state\ndata: (.*)$/m);
  if (!match) throw new Error(`no state frame in: ${JSON.stringify(acc)}`);
  return JSON.parse(match[1] ?? "{}") as Record<string, unknown>;
}

describe("resumable SSE", () => {
  test("every frame carries a monotonic id and connect opens with retry plus state", async () => {
    const gw = createHttpGateway({ handlers: {}, stateSnapshot: () => ({ turns: [] }) });
    try {
      gw.publish("turn.a", { n: 1 });
      const res = await gw.fetch(eventsRequest("/events?stream=turn.a"));
      expect(res.status).toBe(200);
      const stream = await openStream(res);
      await pullUntil(stream, (acc) => acc.includes("retry:"));
      await pullUntil(stream, (acc) => acc.includes("event: state"));
      expect(stream.acc).toMatch(/^retry: 3000\n\n/m);
      expect(stateData(stream.acc)).toEqual({ turns: [] });
      // Pre-connect publish is not replayed without Last-Event-ID; live ones carry ids.
      gw.publish("turn.a", { n: 2 });
      await pullUntil(stream, (acc) => acc.includes('"n":2'));
      expect(stream.ids()).toEqual([2]);
      await stream.close();
    } finally {
      gw.close();
    }
  });

  test("killing mid-turn then resuming with Last-Event-ID loses and duplicates nothing", async () => {
    const gw = createHttpGateway({ handlers: {}, stateSnapshot: () => ({}) });
    try {
      const first = await gw.fetch(eventsRequest("/events?stream=turn.k"));
      const live = await openStream(first);
      await pullUntil(live, (acc) => acc.includes("event: state"));

      for (let n = 1; n <= 4; n++) gw.publish("turn.k", { n });
      await pullUntil(live, (acc) => acc.includes('"n":4'));
      const before = live.ids();
      expect(before).toEqual([1, 2, 3, 4]);
      // Kill the connection mid-turn.
      await live.close();

      for (let n = 5; n <= 7; n++) gw.publish("turn.k", { n });

      const second = await gw.fetch(eventsRequest("/events?stream=turn.k", "4"));
      const resumed = await openStream(second);
      await pullUntil(resumed, (acc) => (acc.match(/"n":7/g) ?? []).length >= 1);
      // One state frame (no id) plus exactly the missed ids, oldest first.
      expect(stateData(resumed.acc)).toEqual({});
      expect(resumed.ids()).toEqual([5, 6, 7]);
      expect(resumed.acc).not.toContain('"n":4');
      await resumed.close();
    } finally {
      gw.close();
    }
  });

  test("reconnecting past the ring gets the state frame with no replay", async () => {
    const snapshot = {
      turns: [{ turnId: "t", sessionId: "s1", provider: "p", model: "m" }],
      approvals: [],
      agents: [],
      cost: { totalUsd: 0.5, bySession: { s1: 0.5 } },
      session: { sessionId: "s1", tipId: "tip-9", entries: [], messages: [], projection: [] },
    };
    const gw = createHttpGateway({ handlers: {}, ringSize: 3, stateSnapshot: () => snapshot });
    try {
      for (let n = 1; n <= 6; n++) gw.publish("turn.old", { n });
      // Id 2 predates the retained tail (4,5,6): gap-tailing is impossible.
      const res = await gw.fetch(eventsRequest("/events", "2"));
      const stream = await openStream(res);
      await pullUntil(stream, (acc) => acc.includes("event: state"));
      await new Promise((r) => setTimeout(r, 150));
      await stream.pull(200);
      expect(stateData(stream.acc)).toEqual(snapshot);
      expect(stream.ids()).toEqual([]);
      expect(stream.acc).not.toContain("turn.old");
      await stream.close();
    } finally {
      gw.close();
    }
  });

  test("an approval outstanding across a reconnect appears in the state frame", async () => {
    const approvals = [
      { id: "ask-1", sessionId: "s9", request: { tool: "bash", title: "rm -rf build" }, turnId: "t9" },
    ];
    const gw = createHttpGateway({
      handlers: {},
      stateSnapshot: (sessionId) => ({ turns: [], approvals, agents: [], cost: {}, sessionId }),
    });
    try {
      const res = await gw.fetch(eventsRequest("/events?sessionId=s9"));
      const stream = await openStream(res);
      await pullUntil(stream, (acc) => acc.includes("ask-1"));
      expect(stateData(stream.acc)).toMatchObject({ approvals, sessionId: "s9" });
      await stream.close();
    } finally {
      gw.close();
    }
  });
});

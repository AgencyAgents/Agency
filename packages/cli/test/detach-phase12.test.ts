import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpClient } from "@agency/net";
import { type AgentDaemon, createAgentDaemon } from "../src/daemon.ts";

const noopHttp: HttpClient = { fetch: async () => new Response() };
const daemons: AgentDaemon[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function startDaemon(): Promise<{ daemon: AgentDaemon; base: string; token: string; root: string }> {
  const root = tempDir("agency-detach-ws-");
  const daemon = await createAgentDaemon({
    workspaceRoot: root,
    instanceFile: join(root, ".agency", "instance.json"),
    sessionsDir: tempDir("agency-detach-sess-"),
    http: noopHttp,
    tools: [],
  });
  daemons.push(daemon);
  return { daemon, base: `http://127.0.0.1:${daemon.httpPort}`, token: daemon.server.token as string, root };
}

async function rpc(
  base: string,
  token: string,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(`${base}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ id: `req-${method}`, method, params }),
  });
  const body = (await res.json()) as { result?: unknown; error?: unknown };
  if (res.status !== 200 || body.error !== undefined || body.result === undefined) {
    throw new Error(`rpc ${method} failed: ${JSON.stringify(body)}`);
  }
  return body.result;
}

interface LiveStream {
  acc: string;
  pull: (timeoutMs?: number) => Promise<boolean>;
  ids: () => number[];
  frames: () => Array<{ id?: number; event?: string; data: unknown }>;
  close: () => Promise<void>;
}

async function openEvents(
  base: string,
  token: string,
  query: string,
  lastEventId?: string,
): Promise<LiveStream> {
  const res = await fetch(`${base}/events${query}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      ...(lastEventId === undefined ? {} : { "Last-Event-ID": lastEventId }),
    },
  });
  if (res.status !== 200 || !res.body) throw new Error(`SSE subscribe failed: ${res.status}`);
  const reader = res.body.getReader();
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
    frames() {
      const out: Array<{ id?: number; event?: string; data: unknown }> = [];
      for (const chunk of acc.split("\n\n")) {
        if (!chunk.includes("data:")) continue;
        const id = /^id: (\d+)$/m.exec(chunk);
        const event = /^event: (.*)$/m.exec(chunk);
        const data = /^data: (.*)$/m.exec(chunk);
        let parsed: unknown;
        try {
          parsed = JSON.parse(data?.[1] ?? "null");
        } catch {}
        out.push({
          ...(id?.[1] === undefined ? {} : { id: Number(id[1]) }),
          ...(event?.[1] === undefined ? {} : { event: event[1] }),
          data: parsed,
        });
      }
      return out;
    },
    async close() {
      await reader.cancel().catch(() => {});
    },
  };
}

async function pullUntil(
  stream: LiveStream,
  until: (acc: string) => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !until(stream.acc)) {
    await stream.pull(Math.max(deadline - Date.now(), 1));
  }
  if (!until(stream.acc))
    throw new Error(`SSE condition unmet; got: ${JSON.stringify(stream.acc.slice(-500))}`);
}

function stateFrame(stream: LiveStream): Record<string, unknown> {
  const frame = stream.frames().find((f) => f.event === "state");
  if (!frame) throw new Error("no state frame");
  return frame.data as Record<string, unknown>;
}

const REVIEW_RESULT = { filesTouched: [], verificationRun: "bun test", decisions: [], openQuestions: [] };

describe("phase 12 detached team runs", () => {
  test("killing the client mid-run loses nothing: reattach gets backlog plus live tail", async () => {
    const { base, token } = await startDaemon();
    const first = await openEvents(base, token, "?stream=team.shared");
    await pullUntil(first, (acc) => acc.includes("event: state"));
    expect((stateFrame(first).board as { items: unknown[] }).items).toEqual([]);

    await rpc(base, token, "task_file", { content: "harden login", pathScope: ["src/auth/**"] });
    await pullUntil(first, (acc) => acc.includes("file") && acc.includes("item-1"));
    await rpc(base, token, "board_claim", { id: "item-1", move: "accept", handle: "coder" });
    await pullUntil(first, (acc) => acc.includes("accept"));
    const cursor = first.ids().at(-1);
    expect(cursor).toBeDefined();
    await first.close();

    await rpc(base, token, "board_status", { id: "item-1", status: "in_progress", handle: "coder" });
    await rpc(base, token, "board_status", {
      id: "item-1",
      status: "ready_for_review",
      handle: "coder",
      result: REVIEW_RESULT,
    });

    const second = await openEvents(base, token, "?stream=team.shared", String(cursor));
    await pullUntil(second, (acc) => acc.includes("status:ready_for_review"));
    const backlogIds = second.ids();
    expect(backlogIds.length).toBeGreaterThan(0);
    expect(Math.min(...backlogIds)).toBeGreaterThan(cursor ?? 0);
    const backlogText = second
      .frames()
      .filter((f) => f.id !== undefined)
      .map((f) => JSON.stringify(f.data))
      .join("\n");
    expect(backlogText).not.toContain("accept");
    expect(second.acc).toContain("status:in_progress");

    await rpc(base, token, "board_status", { id: "item-1", status: "completed", handle: "reviewer" });
    await pullUntil(second, (acc) => acc.includes("status:completed"));

    const board = (await rpc(base, token, "board_read", {})) as {
      items: Array<{ id: string; status: string }>;
    };
    expect(board.items).toEqual(
      [{ id: "item-1", status: "completed" }].map((row) => expect.objectContaining(row)),
    );
    const boardState = stateFrame(second).board as { items: Array<{ id: string; status: string }> };
    expect(boardState.items.map((i) => i.id)).toContain("item-1");
    await second.close();
  });

  test("a standing interest wakes the subscribed agent on review and nothing else", async () => {
    const { base, token } = await startDaemon();
    await rpc(base, token, "wake_subscribe", { handle: "security", pathScope: ["src/auth/**"] });
    const stream = await openEvents(base, token, "?stream=team.shared");
    await pullUntil(stream, (acc) => acc.includes("event: state"));

    await rpc(base, token, "task_file", { content: "harden login", pathScope: ["src/auth/**"] });
    await rpc(base, token, "task_file", { content: "tune query", pathScope: ["src/db/**"] });
    await rpc(base, token, "board_status", {
      id: "item-1",
      status: "ready_for_review",
      handle: "coder",
      result: REVIEW_RESULT,
    });
    await pullUntil(stream, (acc) => acc.includes('"type":"wake"'));
    const wakes = stream.frames().filter((f) => (f.data as { type?: string })?.type === "wake");
    expect(wakes.map((w) => w.data)).toEqual([
      expect.objectContaining({ handle: "security", itemId: "item-1" }),
    ]);

    await rpc(base, token, "board_status", {
      id: "item-2",
      status: "ready_for_review",
      handle: "coder",
      result: REVIEW_RESULT,
    });
    await pullUntil(stream, (acc) => acc.includes("item-2") && acc.includes("status:ready_for_review"));
    await new Promise((r) => setTimeout(r, 400));
    await stream.pull(400);
    const later = stream.frames().filter((f) => (f.data as { type?: string })?.type === "wake");
    expect(later.length).toBe(1);
    expect(stream.acc).not.toContain("agent_lifecycle");
    const board = (await rpc(base, token, "board_read", {})) as {
      events: Array<{ move: string }>;
    };
    expect(board.events.map((e) => e.move)).toContain("wake:security");
    await stream.close();
  });

  test("the progress file steers a detached run: human uncheck reopens the item", async () => {
    const { base, token, root } = await startDaemon();
    await rpc(base, token, "task_file", { content: "harden login", pathScope: ["src/auth/**"] });
    const file = join(root, ".agency", "board.md");
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !existsSync(file)) await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("item-1");

    await rpc(base, token, "board_status", { id: "item-1", status: "completed", handle: "reviewer" });
    const completedDeadline = Date.now() + 10_000;
    let text = "";
    while (Date.now() < completedDeadline) {
      text = readFileSync(file, "utf8");
      if (text.includes("[x]")) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(text).toContain("[x]");
    const reopened = text.replace("[x]", "[ ]");
    expect(reopened).not.toBe(text);
    writeFileSync(file, reopened, "utf8");

    const syncDeadline = Date.now() + 15_000;
    let status = "";
    while (Date.now() < syncDeadline) {
      const board = (await rpc(base, token, "board_read", {})) as {
        items: Array<{ id: string; status: string }>;
      };
      status = board.items.find((i) => i.id === "item-1")?.status ?? "";
      if (status === "pending") break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(status).toBe("pending");
  }, 30_000);

  test("a wake-only team halts on the no-progress detector", async () => {
    const { base, token } = await startDaemon();
    await rpc(base, token, "wake_subscribe", { handle: "watcher", pathScope: ["src/auth/**"] });
    await rpc(base, token, "task_file", { content: "watched slice", pathScope: ["src/auth/**"] });
    const stream = await openEvents(base, token, "?stream=team.shared");
    await pullUntil(stream, (acc) => acc.includes("event: state"));
    for (let n = 0; n < 6; n++) {
      await rpc(base, token, "board_status", { id: "item-1", status: "pending", handle: "lead" });
    }
    await pullUntil(stream, (acc) => acc.includes("team_halted"));
    const halted = stream.frames().find((f) => (f.data as { type?: string })?.type === "team_halted");
    expect(halted?.data).toEqual(expect.objectContaining({ reason: "no-progress" }));
    await stream.close();
  });
});

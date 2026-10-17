import { afterAll, afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, StreamEvent } from "@agency/providers";
import { type AgentDaemon, createAgentDaemon } from "../src/daemon.ts";

const daemons: AgentDaemon[] = [];
const dirs: string[] = [];
const prevKey = process.env.AGENCY_ANTHROPIC_API_KEY;
process.env.AGENCY_ANTHROPIC_API_KEY = "test-key-rewind";
afterAll(() => {
  if (prevKey === undefined) delete process.env.AGENCY_ANTHROPIC_API_KEY;
  else process.env.AGENCY_ANTHROPIC_API_KEY = prevKey;
});
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

/** Each turn makes one `write` call from the queue, then ends. */
function writer(queue: { path: string; content: string }[]): ProviderAdapter {
  let calls = 0;
  return {
    family: "fake",
    async *stream(): AsyncIterable<StreamEvent> {
      calls += 1;
      const next = calls % 2 === 1 ? queue.shift() : undefined;
      if (next) {
        yield { type: "tool_call_start", id: `c${calls}`, name: "write" };
        yield { type: "tool_call_delta", id: `c${calls}`, inputJsonDelta: JSON.stringify(next) };
        yield { type: "tool_call_end", id: `c${calls}` };
        yield { type: "message_stop", stopReason: "tool_use", usage: { inputTokens: 5, outputTokens: 5 } };
        return;
      }
      yield { type: "text_delta", text: "done" };
      yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 5 } };
    },
  };
}

async function start(queue: { path: string; content: string }[]) {
  const ws = tempDir("agency-rewind-ws-");
  const http: HttpClient = { fetch: async () => new Response() };
  const adapter = writer(queue);
  // Each turn makes exactly one write: the verify loop would send a turn back for another model call.
  const configDir = tempDir("agency-rewind-cfg-");
  writeFileSync(join(configDir, "config.jsonc"), JSON.stringify({ verifyGate: false }));
  const daemon = await createAgentDaemon({
    workspaceRoot: ws,
    instanceFile: join(ws, ".agency", "instance.json"),
    sessionsDir: tempDir("agency-rewind-sess-"),
    approvalsDir: tempDir("agency-rewind-appr-"),
    configDir,
    adapterFor: () => adapter,
    http,
  });
  daemons.push(daemon);
  const call = async (method: string, params: Record<string, unknown>) => {
    const res = await fetch(`http://127.0.0.1:${daemon.httpPort}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${daemon.server.token}` },
      body: JSON.stringify({ id: 1, method, params }),
    });
    const body = (await res.json()) as { result?: Record<string, unknown>; error?: { message: string } };
    if (body.error) throw new Error(body.error.message);
    return body.result ?? {};
  };
  const send = (userText: string) =>
    call("session_send", {
      sessionId: "s",
      provider: "anthropic",
      model: "m",
      systemPrompt: "sys",
      userText,
      permissionMode: "allow-all",
    });
  const prompts = async () => {
    const { entries } = (await call("session_show", { sessionId: "s" })) as {
      entries: { id: string; turnId?: string }[];
    };
    return entries.filter((e) => e.turnId !== undefined);
  };
  return { ws, call, send, prompts };
}

test("rewind to a prompt puts back the files of its turn and later ones, and ends the session before it", async () => {
  const queue: { path: string; content: string }[] = [];
  const { ws, call, send, prompts } = await start(queue);
  writeFileSync(join(ws, "a.ts"), "v0");
  queue.push(
    { path: "a.ts", content: "v1" },
    { path: "new.ts", content: "made" },
    { path: "a.ts", content: "v2" },
  );
  await send("first");
  await send("second");
  await send("third");
  expect(readFileSync(join(ws, "a.ts"), "utf8")).toBe("v2");
  const [, second] = await prompts();

  const out = await call("session_rewind", { sessionId: "s", entryId: second?.id });
  expect(out).toMatchObject({ rewound: true, prompt: "second" });
  expect(readFileSync(join(ws, "a.ts"), "utf8")).toBe("v1");
  expect(existsSync(join(ws, "new.ts"))).toBe(false);
  expect((await prompts()).length).toBe(1);
});

test("an edit after the agent's write stops the rewind until it is forced", async () => {
  const queue = [{ path: "a.ts", content: "v1" }];
  const { ws, call, send, prompts } = await start(queue);
  writeFileSync(join(ws, "a.ts"), "v0");
  await send("first");
  writeFileSync(join(ws, "a.ts"), "mine");
  const [first] = await prompts();

  expect(await call("session_rewind", { sessionId: "s", entryId: first?.id })).toEqual({
    rewound: false,
    conflicts: [join(ws, "a.ts")],
  });
  expect(readFileSync(join(ws, "a.ts"), "utf8")).toBe("mine");
  expect((await prompts()).length).toBe(1);
  expect(await call("session_rewind", { sessionId: "s", entryId: first?.id, force: true })).toMatchObject({
    rewound: true,
  });
  expect(readFileSync(join(ws, "a.ts"), "utf8")).toBe("v0");
});

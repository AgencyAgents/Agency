import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, ProviderRequest, StreamEvent } from "@agency/providers";
import { type AgentDaemon, createAgentDaemon } from "../src/daemon.ts";

const daemons: AgentDaemon[] = [];
const dirs: string[] = [];
const prevKey = process.env.AGENCY_ANTHROPIC_API_KEY;
process.env.AGENCY_ANTHROPIC_API_KEY = "test-key-spawn-prefix";
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (prevKey === undefined) delete process.env.AGENCY_ANTHROPIC_API_KEY;
  else process.env.AGENCY_ANTHROPIC_API_KEY = prevKey;
});
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

test("the workers of a session get one system prompt, so they share the cached prefix", async () => {
  const ws = tempDir("agency-spawn-ws-");
  execFileSync("git", ["init", "-q"], { cwd: ws });
  const steps = [
    { name: "spawn", input: { prompt: "worker task one" } },
    { name: "write", input: { path: "changed.txt", content: "a change between the workers\n" } },
    { name: "spawn", input: { prompt: "worker task two" } },
  ];
  const workers: ProviderRequest[] = [];
  let step = 0;
  const adapter: ProviderAdapter = {
    family: "fake",
    async *stream(request): AsyncIterable<StreamEvent> {
      const first = request.messages[0]?.content.find((b) => b.type === "text");
      if (first?.type === "text" && first.text.startsWith("worker task")) {
        workers.push(request);
        yield { type: "text_delta", text: "worker done" };
        yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
        return;
      }
      const call = steps[step++];
      if (call) {
        yield { type: "tool_call_start", id: `c${step}`, name: call.name };
        yield { type: "tool_call_delta", id: `c${step}`, inputJsonDelta: JSON.stringify(call.input) };
        yield { type: "tool_call_end", id: `c${step}` };
        yield { type: "message_stop", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } };
        return;
      }
      yield { type: "text_delta", text: "done" };
      yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const daemon = await createAgentDaemon({
    workspaceRoot: ws,
    instanceFile: join(ws, ".agency", "instance.json"),
    sessionsDir: tempDir("agency-spawn-sess-"),
    approvalsDir: tempDir("agency-spawn-appr-"),
    configDir: tempDir("agency-spawn-cfg-"),
    adapterFor: () => adapter,
    http: { fetch: async () => new Response() } satisfies HttpClient,
  });
  daemons.push(daemon);
  const res = await fetch(`http://127.0.0.1:${daemon.httpPort}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${daemon.server.token}` },
    body: JSON.stringify({
      id: 1,
      method: "session_send",
      params: {
        sessionId: "s",
        provider: "anthropic",
        model: "m",
        userText: "go",
        permissionMode: "allow-all",
      },
    }),
  });
  expect(((await res.json()) as { error?: unknown }).error).toBeUndefined();
  expect(workers).toHaveLength(2);
  expect(workers[1]?.system).toBe(workers[0]?.system);
  expect(workers[0]?.system).toContain("<environment>");
}, 60_000);

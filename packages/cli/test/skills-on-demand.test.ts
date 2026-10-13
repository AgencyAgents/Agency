import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, ProviderRequest, StreamEvent } from "@agency/providers";
import { connectToDaemon, type DaemonClient } from "@agency/rpc";
import { type AgentDaemon, createAgentDaemon } from "../src/daemon.ts";

const noopHttp: HttpClient = { fetch: async () => new Response() };
const daemons: AgentDaemon[] = [];
const clients: DaemonClient[] = [];
const dirs: string[] = [];

const prevKey = process.env.AGENCY_ANTHROPIC_API_KEY;
process.env.AGENCY_ANTHROPIC_API_KEY = "test-key-skills";
afterAll(() => {
  if (prevKey === undefined) delete process.env.AGENCY_ANTHROPIC_API_KEY;
  else process.env.AGENCY_ANTHROPIC_API_KEY = prevKey;
});
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const daemon of daemons.splice(0)) await daemon.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `agency-skilld-${name}-`));
  dirs.push(dir);
  return dir;
}

test("a skill is one line in the prompt until the model loads it with the skill tool", async () => {
  const configDir = tmp("cfg");
  mkdirSync(join(configDir, "skills", "release"), { recursive: true });
  writeFileSync(
    join(configDir, "skills", "release", "SKILL.md"),
    "---\nname: release\ndescription: Use when the user asks for a release\n---\nRELEASE-BODY: tag, then push.",
  );
  const requests: ProviderRequest[] = [];
  const usage = { inputTokens: 5, outputTokens: 5 };
  const adapter: ProviderAdapter = {
    family: "fake",
    async *stream(request): AsyncIterable<StreamEvent> {
      requests.push(request);
      if (requests.length === 1) {
        yield { type: "tool_call_start", id: "c1", name: "skill" };
        yield { type: "tool_call_delta", id: "c1", inputJsonDelta: '{"name":"release"}' };
        yield { type: "tool_call_end", id: "c1" };
        yield { type: "message_stop", stopReason: "tool_use", usage };
        return;
      }
      yield { type: "text_delta", text: "done" };
      yield { type: "message_stop", stopReason: "end_turn", usage };
    },
  };
  const workspaceRoot = tmp("ws");
  const daemon = await createAgentDaemon({
    workspaceRoot,
    configDir,
    instanceFile: join(workspaceRoot, ".agency", "instance.json"),
    sessionsDir: tmp("sess"),
    adapterFor: () => adapter,
    http: noopHttp,
  });
  daemons.push(daemon);
  const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
  clients.push(client);

  await client.call("session_send", {
    sessionId: "sk1",
    provider: "anthropic",
    model: "test-model",
    systemPrompt: "sys",
    userText: "make a release",
  });

  expect(requests[0]?.system).toContain("- release: Use when the user asks for a release");
  expect(requests[0]?.system).not.toContain("RELEASE-BODY");
  expect(requests[0]?.tools?.map((tool) => tool.name)).toContain("skill");
  expect(JSON.stringify(requests[1]?.messages)).toContain("RELEASE-BODY: tag, then push.");
}, 30000);

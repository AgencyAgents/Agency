import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolSpec } from "@agency/core";
import { createFileTrustStore } from "@agency/guard";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, StreamEvent } from "@agency/providers";
import { connectToDaemon, type DaemonClient } from "@agency/rpc";
import { type AgentDaemon, createAgentDaemon } from "../src/daemon.ts";

const noopHttp: HttpClient = { fetch: async () => new Response() };
const daemons: AgentDaemon[] = [];
const clients: DaemonClient[] = [];
const dirs: string[] = [];

const prevKey = process.env.AGENCY_ANTHROPIC_API_KEY;
process.env.AGENCY_ANTHROPIC_API_KEY = "test-key-cmdhooks";
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
  const dir = mkdtempSync(join(tmpdir(), `agency-hookd-${name}-`));
  dirs.push(dir);
  return dir;
}

const usage = { inputTokens: 5, outputTokens: 5 };

/**
 * A daemon with one hook command for each event, and a model that calls `note` in its first reply.
 * The hooks are in the user's config, or in a hook file of the workspace.
 */
async function setup(
  where: "config" | "trusted workspace" | "untrusted workspace" = "config",
): Promise<{ client: DaemonClient; requests: string[]; ran: string[] }> {
  const scripts = tmp("scripts");
  const command = (name: string, body: string): { type: "command"; command: string } => {
    const file = join(scripts, `${name}.js`);
    writeFileSync(file, body);
    return { type: "command", command: `"${process.execPath}" "${file}"` };
  };
  const marker = JSON.stringify(join(scripts, "stopped-once"));
  const hooks = {
    SessionStart: [{ hooks: [command("start", 'console.log("START-CONTEXT");')] }],
    UserPromptSubmit: [
      {
        hooks: [
          command(
            "prompt",
            'let s = ""; process.stdin.on("data", (d) => (s += d)); process.stdin.on("end", () => { if (JSON.parse(s).prompt.includes("forbidden")) { console.error("no forbidden words"); process.exit(2); } console.log("PROMPT-CONTEXT"); });',
          ),
        ],
      },
    ],
    PreToolUse: [
      { matcher: "Note", hooks: [command("pre", 'console.error("note is off"); process.exit(2);')] },
    ],
    Stop: [
      {
        hooks: [
          command(
            "stop",
            `const fs = require("node:fs"); if (!fs.existsSync(${marker})) { fs.writeFileSync(${marker}, ""); console.error("run the checks first"); process.exit(2); }`,
          ),
        ],
      },
    ],
  };
  const configDir = tmp("cfg");
  const workspaceRoot = tmp("ws");
  const trustStorePath = join(tmp("trust"), "trust.json");
  if (where === "config") {
    writeFileSync(join(configDir, "config.jsonc"), JSON.stringify({ hooks }));
  } else {
    mkdirSync(join(workspaceRoot, ".agency", "hooks"), { recursive: true });
    writeFileSync(join(workspaceRoot, ".agency", "hooks", "guard.json"), JSON.stringify({ hooks }));
    if (where === "trusted workspace") createFileTrustStore(trustStorePath).trust(workspaceRoot);
  }

  const requests: string[] = [];
  const adapter: ProviderAdapter = {
    family: "fake",
    async *stream(request): AsyncIterable<StreamEvent> {
      requests.push(JSON.stringify(request.messages));
      if (requests.length === 1) {
        yield { type: "tool_call_start", id: "call-1", name: "note" };
        yield { type: "tool_call_delta", id: "call-1", inputJsonDelta: '{"text":"hi"}' };
        yield { type: "tool_call_end", id: "call-1" };
        yield { type: "message_stop", stopReason: "tool_use", usage };
        return;
      }
      yield { type: "text_delta", text: "done" };
      yield { type: "message_stop", stopReason: "end_turn", usage };
    },
  };
  const ran: string[] = [];
  const note: ToolSpec = {
    name: "note",
    description: "Records a note.",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
    riskTier: "safe",
    handler: async () => {
      ran.push("note");
      return { content: "noted" };
    },
  };
  const daemon = await createAgentDaemon({
    workspaceRoot,
    configDir,
    trustStorePath,
    instanceFile: join(workspaceRoot, ".agency", "instance.json"),
    sessionsDir: tmp("sess"),
    adapterFor: () => adapter,
    http: noopHttp,
    tools: [note],
  });
  daemons.push(daemon);
  const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
  clients.push(client);
  return { client, requests, ran };
}

const send = (client: DaemonClient, userText: string) =>
  client.call("session_send", {
    sessionId: "hook-s1",
    provider: "anthropic",
    model: "test-model",
    systemPrompt: "sys",
    userText,
  }) as Promise<{ stopReason: string }>;

const count = (text: string, part: string): number => text.split(part).length - 1;

describe("command hooks of the config in a session", () => {
  test("each event reaches the model and the session keeps the hook text", async () => {
    const { client, requests, ran } = await setup();
    const first = await send(client, "take a note");
    expect(first.stopReason).toBe("end_turn");
    expect(ran).toEqual([]);
    expect(requests).toHaveLength(3);
    expect(requests[0]).toContain("START-CONTEXT");
    expect(requests[0]).toContain("PROMPT-CONTEXT");
    expect(requests[1]).toContain("note is off");
    expect(requests[2]).toContain("run the checks first");

    await send(client, "and now?");
    const second = requests.at(-1) ?? "";
    expect(count(second, "START-CONTEXT")).toBe(1);
    expect(count(second, "PROMPT-CONTEXT")).toBe(2);
  }, 30000);

  test("a prompt that a hook refuses does not reach the model, in this turn or the next", async () => {
    const { client, requests } = await setup();
    await expect(send(client, "a forbidden word")).rejects.toThrow("no forbidden words");
    expect(requests).toHaveLength(0);
    await send(client, "hello");
    expect(requests.at(-1)).not.toContain("forbidden");
  }, 30000);

  test("the hook files of a workspace run only when the user trusts the workspace", async () => {
    const untrusted = await setup("untrusted workspace");
    await send(untrusted.client, "take a note");
    expect(untrusted.ran).toEqual(["note"]);
    expect(untrusted.requests[0]).not.toContain("START-CONTEXT");

    const trusted = await setup("trusted workspace");
    await send(trusted.client, "take a note");
    expect(trusted.ran).toEqual([]);
    expect(trusted.requests[0]).toContain("START-CONTEXT");
    expect(trusted.requests[1]).toContain("note is off");
  }, 30000);
});

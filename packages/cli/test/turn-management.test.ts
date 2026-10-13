import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolSpec } from "@agency/core";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, StreamEvent } from "@agency/providers";
import { connectToDaemon, type DaemonClient, hashWorkspaceRoot } from "@agency/rpc";
import { type AgentDaemon, createAgentDaemon } from "../src/daemon.ts";
import { runEntrypoint } from "../src/entrypoint.ts";

const noopHttp: HttpClient = { fetch: async () => new Response() };
const daemons: AgentDaemon[] = [];
const clients: DaemonClient[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const daemon of daemons.splice(0)) await daemon.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `agency-turns-${name}-`));
  dirs.push(dir);
  return dir;
}

const usage = { inputTokens: 1, outputTokens: 1 };

/** A daemon whose model calls a tool that waits until the turn is cancelled, and the CLI of a second terminal. */
async function setup() {
  const slow: ToolSpec = {
    name: "slow",
    description: "waits for a cancel",
    inputSchema: {},
    riskTier: "safe",
    handler: (_input, ctx) =>
      new Promise((resolve) => {
        ctx.signal.addEventListener("abort", () => resolve({ content: "aborted", isError: true }));
      }),
  };
  const adapter: ProviderAdapter = {
    family: "fake",
    async *stream(): AsyncIterable<StreamEvent> {
      yield { type: "tool_call_start", id: "c1", name: "slow" };
      yield { type: "tool_call_delta", id: "c1", inputJsonDelta: "{}" };
      yield { type: "tool_call_end", id: "c1" };
      yield { type: "message_stop", stopReason: "tool_use", usage };
    },
  };
  const workspaceRoot = tmp("ws");
  const instanceDir = tmp("instances");
  const daemon = await createAgentDaemon({
    workspaceRoot,
    instanceFile: join(instanceDir, `${hashWorkspaceRoot(workspaceRoot)}.json`),
    sessionsDir: tmp("sess"),
    approvalsDir: tmp("approvals"),
    adapterFor: () => adapter,
    http: noopHttp,
    tools: [slow],
  });
  daemons.push(daemon);
  const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
  clients.push(client);
  const cli = async (...args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runEntrypoint([...args, "--workspace", workspaceRoot], {
      out: (line) => {
        out.push(line);
      },
      err: (line) => {
        err.push(line);
      },
      instanceDir,
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  return { client, cli };
}

describe("run management from a second terminal", () => {
  test("daemon status lists a turn that runs, daemon cancel stops it, and no key is shown", async () => {
    const { client, cli } = await setup();
    const run = client.call("run_turn", {
      turnId: "turn-long-1",
      sessionId: "s-long",
      provider: "anthropic",
      model: "test-model",
      apiKey: "secret-key-of-the-turn",
      systemPrompt: "sys",
      session: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    }) as Promise<{ cancelled: boolean }>;
    await new Promise((r) => setTimeout(r, 100));

    const text = await cli("daemon", "status");
    expect(text.code).toBe(0);
    expect(text.out).toContain("turn-long-1");
    expect(text.out).toContain("s-long");
    expect(text.out).toContain("anthropic/test-model");

    const json = await cli("daemon", "status", "--format", "json");
    const parsed = JSON.parse(json.out) as { status: string; turns: Array<Record<string, unknown>> };
    expect(parsed.turns).toHaveLength(1);
    expect(parsed.turns[0]).toMatchObject({
      turnId: "turn-long-1",
      sessionId: "s-long",
      provider: "anthropic",
      model: "test-model",
    });
    expect(typeof parsed.turns[0]?.startedAt).toBe("string");
    expect(`${text.out}${json.out}`).not.toContain("secret-key-of-the-turn");

    const cancel = await cli("daemon", "cancel", "turn-long-1");
    expect(cancel.code).toBe(0);
    expect((await run).cancelled).toBe(true);

    const after = JSON.parse((await cli("daemon", "status", "--format", "json")).out) as { turns: unknown[] };
    expect(after.turns).toEqual([]);
  }, 30_000);

  test("daemon cancel of a turn that does not run is exit code 1, and a missing id is an error", async () => {
    const { cli } = await setup();
    const unknown = await cli("daemon", "cancel", "no-such-turn");
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain("no-such-turn");
    expect((await cli("daemon", "cancel")).code).toBe(1);
  }, 30_000);
});

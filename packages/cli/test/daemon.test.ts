import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolSpec } from "@agency/core";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, StreamEvent } from "@agency/providers";
import { connectToDaemon, type DaemonClient } from "@agency/rpc";
import { type AgentDaemon, createAgentDaemon, type RunTurnRpcResult } from "../src/daemon.ts";

const noopHttp: HttpClient = { fetch: async () => new Response() };

const daemons: AgentDaemon[] = [];
const clients: DaemonClient[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const daemon of daemons.splice(0)) await daemon.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempInstanceFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "agency-daemon-test-"));
  dirs.push(dir);
  return join(dir, "instance.json");
}

function textAdapter(text: string): ProviderAdapter {
  return {
    family: "fake",
    async *stream(): AsyncIterable<StreamEvent> {
      yield { type: "text_delta", text };
      yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 3, outputTokens: 2 } };
    },
  };
}

async function startFakeDaemon(overrides: Partial<Parameters<typeof createAgentDaemon>[0]> = {}) {
  const daemon = await createAgentDaemon({
    workspaceRoot: "/repo/fake",
    instanceFile: tempInstanceFile(),
    adapterFor: () => textAdapter("hello from the daemon"),
    http: noopHttp,
    ...overrides,
  });
  daemons.push(daemon);
  const client = await connectToDaemon(daemon.server.port);
  clients.push(client);
  return { daemon, client };
}

describe("createAgentDaemon", () => {
  test("run_turn drives a real turn through the loop and returns the result over RPC", async () => {
    const { client } = await startFakeDaemon();

    const result = (await client.call("run_turn", {
      turnId: "t1",
      provider: "anthropic",
      model: "test-model",
      apiKey: "key",
      systemPrompt: "sys",
      session: [],
    })) as RunTurnRpcResult;

    expect(result.stopReason).toBe("end_turn");
    expect(result.cancelled).toBe(false);
    expect(result.messages[0]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "hello from the daemon" }],
    });
  });

  test("turn events are broadcast under a per-turn event name", async () => {
    const { client } = await startFakeDaemon();
    const events: unknown[] = [];
    client.on("turn.t2", (payload) => events.push(payload));

    await client.call("run_turn", {
      turnId: "t2",
      provider: "anthropic",
      model: "test-model",
      apiKey: "key",
      systemPrompt: "sys",
      session: [],
    });

    expect(events).toContainEqual({ type: "text_delta", text: "hello from the daemon" });
  });

  test("cancel_turn aborts a run_turn that's using a tool respecting the signal", async () => {
    let sawAbort = false;
    const slowTool: ToolSpec = {
      name: "slow",
      description: "waits for cancellation",
      inputSchema: {},
      handler: (_input, ctx) =>
        new Promise((resolve) => {
          ctx.signal.addEventListener("abort", () => {
            sawAbort = true;
            resolve({ content: "aborted", isError: true });
          });
        }),
    };

    let call = 0;
    const toolThenDone: ProviderAdapter = {
      family: "fake",
      async *stream(): AsyncIterable<StreamEvent> {
        call += 1;
        if (call === 1) {
          yield { type: "tool_call_start", id: "c1", name: "slow" };
          yield { type: "tool_call_delta", id: "c1", inputJsonDelta: "{}" };
          yield { type: "tool_call_end", id: "c1" };
          yield { type: "message_stop", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } };
        } else {
          yield { type: "text_delta", text: "done" };
          yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
        }
      },
    };

    const { client } = await startFakeDaemon({ adapterFor: () => toolThenDone, tools: [slowTool] });

    const runPromise = client.call("run_turn", {
      turnId: "t3",
      provider: "anthropic",
      model: "test-model",
      apiKey: "key",
      systemPrompt: "sys",
      session: [],
    });

    await new Promise((r) => setTimeout(r, 50));
    const cancelResult = await client.call("cancel_turn", { turnId: "t3" });
    await runPromise;

    expect(cancelResult).toEqual({ cancelled: true });
    expect(sawAbort).toBe(true);
  });

  test("cancel_turn for an unknown turnId reports not cancelled instead of erroring", async () => {
    const { client } = await startFakeDaemon();
    const result = await client.call("cancel_turn", { turnId: "does-not-exist" });
    expect(result).toEqual({ cancelled: false });
  });

  test("an unknown provider surfaces as a rejected call, not a crashed daemon", async () => {
    const { client } = await startFakeDaemon({ adapterFor: undefined });

    await expect(
      client.call("run_turn", {
        turnId: "t4",
        provider: "not-a-real-provider",
        model: "x",
        apiKey: "key",
        systemPrompt: "sys",
        session: [],
      }),
    ).rejects.toThrow(/unknown provider/);

    // The daemon itself must still be alive after that rejection.
    expect(await client.call("cancel_turn", { turnId: "whatever" })).toEqual({ cancelled: false });
  });

  test("onIdleShutdown fires after the last client disconnects and the linger elapses", async () => {
    let shutdownCalled = false;
    const { daemon, client } = await startFakeDaemon({
      idleLingerMs: 30,
      onIdleShutdown: () => {
        shutdownCalled = true;
      },
    });

    await client.close();
    clients.length = 0; // already closed, don't close again in afterEach
    await new Promise((r) => setTimeout(r, 100));

    expect(shutdownCalled).toBe(true);
    void daemon;
  });

  test("onIdleShutdown does not fire while a client is still connected", async () => {
    let shutdownCalled = false;
    await startFakeDaemon({ idleLingerMs: 30, onIdleShutdown: () => (shutdownCalled = true) });

    await new Promise((r) => setTimeout(r, 100));
    expect(shutdownCalled).toBe(false);
  });
});

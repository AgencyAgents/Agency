import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "agency-tools-e2e-"));
  dirs.push(dir);
  return dir;
}

/** A fake model that calls a real tool once, then stops: proves the daemon's
 *  default built-in tool set actually runs, not just a mocked stand-in. */
function scriptedToolCallAdapter(toolName: string, input: Record<string, unknown>): ProviderAdapter {
  let call = 0;
  return {
    family: "fake",
    async *stream(): AsyncIterable<StreamEvent> {
      call += 1;
      if (call === 1) {
        yield { type: "tool_call_start", id: "c1", name: toolName };
        yield { type: "tool_call_delta", id: "c1", inputJsonDelta: JSON.stringify(input) };
        yield { type: "tool_call_end", id: "c1" };
        yield { type: "message_stop", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } };
      } else {
        yield { type: "text_delta", text: "done" };
        yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
      }
    },
  };
}

describe("daemon with real built-in tools", () => {
  test("a scripted 'write' tool call actually creates a file on disk", async () => {
    const root = tempRepo();
    const daemon = await createAgentDaemon({
      workspaceRoot: root,
      instanceFile: join(root, ".agency", "instance.json"),
      adapterFor: () =>
        scriptedToolCallAdapter("write", { path: "hello.ts", content: "export const x = 1;\n" }),
      http: noopHttp,
    });
    daemons.push(daemon);
    const client = await connectToDaemon(daemon.server.port);
    clients.push(client);

    const result = (await client.call("run_turn", {
      turnId: "t1",
      provider: "anthropic",
      model: "test-model",
      apiKey: "key",
      systemPrompt: "sys",
      session: [],
    })) as RunTurnRpcResult;

    expect(result.stopReason).toBe("end_turn");
    expect(readFileSync(join(root, "hello.ts"), "utf8")).toBe("export const x = 1;\n");
  });

  test("a scripted 'edit' tool call rejects a stale edit against the real file, leaving it untouched", async () => {
    const root = tempRepo();
    writeFileSync(join(root, "existing.ts"), "const x = 1;\n");

    const daemon = await createAgentDaemon({
      workspaceRoot: root,
      instanceFile: join(root, ".agency", "instance.json"),
      adapterFor: () =>
        scriptedToolCallAdapter("edit", {
          path: "existing.ts",
          oldText: "const x = 99;", // stale/wrong, doesn't match the real file
          newText: "const x = 2;",
        }),
      http: noopHttp,
    });
    daemons.push(daemon);
    const client = await connectToDaemon(daemon.server.port);
    clients.push(client);

    await client.call("run_turn", {
      turnId: "t2",
      provider: "anthropic",
      model: "test-model",
      apiKey: "key",
      systemPrompt: "sys",
      session: [],
    });

    expect(readFileSync(join(root, "existing.ts"), "utf8")).toBe("const x = 1;\n");
  });

  test("a scripted 'bash' tool call actually runs a real command", async () => {
    const root = tempRepo();
    const daemon = await createAgentDaemon({
      workspaceRoot: root,
      instanceFile: join(root, ".agency", "instance.json"),
      adapterFor: () => scriptedToolCallAdapter("bash", { command: "echo real-bash-output-from-e2e-test" }),
      http: noopHttp,
    });
    daemons.push(daemon);
    const client = await connectToDaemon(daemon.server.port);
    clients.push(client);

    const result = (await client.call("run_turn", {
      turnId: "t3",
      provider: "anthropic",
      model: "test-model",
      apiKey: "key",
      systemPrompt: "sys",
      session: [],
    })) as RunTurnRpcResult;

    const toolResultMessage = result.messages[1];
    const toolResult = toolResultMessage?.content[0] as { content: string };
    expect(toolResult.content).toContain("real-bash-output-from-e2e-test");
  });
});

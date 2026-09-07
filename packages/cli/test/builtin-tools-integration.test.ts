import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agency-tools-e2e-")));
  dirs.push(dir);
  return dir;
}

/**
 * These tests assert file/bash EFFECTS, not permission policy, so each daemon
 * config explicitly allows the tools it exercises — under A5 the unconfigured
 * defaults ask for approval on every mutating tool call, which would hang a
 * scripted turn with no approval surface attached.
 */
function configAllowing(permissions: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "agency-tools-e2e-cfg-"));
  dirs.push(dir);
  writeFileSync(join(dir, "config.jsonc"), JSON.stringify({ schemaVersion: 2, permissions }));
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
      configDir: configAllowing({ write: "allow" }),
    });
    daemons.push(daemon);
    const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
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
      configDir: configAllowing({ edit: "allow" }),
    });
    daemons.push(daemon);
    const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
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
      configDir: configAllowing({ bash: "allow" }),
    });
    daemons.push(daemon);
    const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
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
  }, 30_000);

  test("undo reverts a scripted write and redo re-applies it, over RPC", async () => {
    const root = tempRepo();
    writeFileSync(join(root, "undo-me.ts"), "original", "utf8");
    // Unique session: the snapshot journal lives in the shared snapshots dir,
    // so reusing the "default" session would read stale undo depth from prior runs.
    const sessionId = `undo-e2e-${randomUUID()}`;

    const daemon = await createAgentDaemon({
      workspaceRoot: root,
      instanceFile: join(root, ".agency", "instance.json"),
      adapterFor: () => scriptedToolCallAdapter("write", { path: "undo-me.ts", content: "overwritten" }),
      http: noopHttp,
      configDir: configAllowing({ write: "allow" }),
    });
    daemons.push(daemon);
    const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
    clients.push(client);

    await client.call("run_turn", {
      turnId: "t4",
      sessionId,
      provider: "anthropic",
      model: "test-model",
      apiKey: "key",
      systemPrompt: "sys",
      session: [],
    });
    expect(readFileSync(join(root, "undo-me.ts"), "utf8")).toBe("overwritten");

    expect(await client.call("undo", { sessionId })).toEqual({
      undone: true,
      path: join(root, "undo-me.ts"),
    });
    expect(readFileSync(join(root, "undo-me.ts"), "utf8")).toBe("original");

    expect(await client.call("redo", { sessionId })).toEqual({
      undone: true,
      path: join(root, "undo-me.ts"),
    });
    expect(readFileSync(join(root, "undo-me.ts"), "utf8")).toBe("overwritten");

    // Nothing left to redo, but the re-applied write can be undone again.
    expect(await client.call("redo", { sessionId })).toEqual({ undone: false });
    expect(await client.call("undo", { sessionId })).toEqual({
      undone: true,
      path: join(root, "undo-me.ts"),
    });
  });
});

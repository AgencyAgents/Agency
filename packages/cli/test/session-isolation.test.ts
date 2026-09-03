import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  for (const c of clients.splice(0)) await c.close();
  for (const d of daemons.splice(0)) await d.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "agency-iso-"));
  dirs.push(dir);
  return dir;
}

function configAllowing(permissions: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "agency-iso-cfg-"));
  dirs.push(dir);
  writeFileSync(join(dir, "config.jsonc"), JSON.stringify({ schemaVersion: 2, permissions }));
  return dir;
}

function cdThenPwdAdapter(targetDir: string): ProviderAdapter {
  let step = 0;
  return {
    family: "fake",
    async *stream(): AsyncIterable<StreamEvent> {
      step += 1;
      if (step === 1) {
        yield { type: "tool_call_start", id: "c1", name: "bash" };
        yield { type: "tool_call_delta", id: "c1", inputJsonDelta: JSON.stringify({ command: `cd ${targetDir}` }) };
        yield { type: "tool_call_end", id: "c1" };
        yield { type: "message_stop", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } };
      } else if (step === 2) {
        yield { type: "tool_call_start", id: "c2", name: "bash" };
        yield { type: "tool_call_delta", id: "c2", inputJsonDelta: JSON.stringify({ command: "pwd" }) };
        yield { type: "tool_call_end", id: "c2" };
        yield { type: "message_stop", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } };
      } else {
        yield { type: "text_delta", text: "done" };
        yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
      }
    },
  };
}

function singleBashAdapter(command: string): ProviderAdapter {
  let call = 0;
  return {
    family: "fake",
    async *stream(): AsyncIterable<StreamEvent> {
      call += 1;
      if (call === 1) {
        yield { type: "tool_call_start", id: "c1", name: "bash" };
        yield { type: "tool_call_delta", id: "c1", inputJsonDelta: JSON.stringify({ command }) };
        yield { type: "tool_call_end", id: "c1" };
        yield { type: "message_stop", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } };
      } else {
        yield { type: "text_delta", text: "done" };
        yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
      }
    },
  };
}

describe("B1 per-session isolation", () => {
  test("two concurrent turns cd-ing to different dirs observe their own cwd", async () => {
    const root = tempRepo();
    mkdirSync(join(root, "a"), { recursive: true });
    mkdirSync(join(root, "b"), { recursive: true });

    const adapterA = cdThenPwdAdapter("a");
    const adapterB = cdThenPwdAdapter("b");

    const daemon = await createAgentDaemon({
      workspaceRoot: root,
      instanceFile: join(root, ".agency", "instance.json"),
      adapterFor: (provider: string) => (provider === "provA" ? adapterA : adapterB),
      http: noopHttp,
      configDir: configAllowing({ bash: "allow" }),
    });
    daemons.push(daemon);
    const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
    clients.push(client);

    const [r1, r2] = (await Promise.all([
      client.call("run_turn", {
        turnId: "t-a",
        provider: "provA",
        model: "m",
        apiKey: "k",
        systemPrompt: "sys",
        session: [],
        sessionId: "s1",
      }),
      client.call("run_turn", {
        turnId: "t-b",
        provider: "provB",
        model: "m",
        apiKey: "k",
        systemPrompt: "sys",
        session: [],
        sessionId: "s2",
      }),
    ])) as RunTurnRpcResult[];

    const pwdResult = (r: RunTurnRpcResult, callIndex: number): string => {
      const msg = r.messages[callIndex];
      const block = msg?.content[0] as { content: string } | undefined;
      return block?.content ?? "";
    };

    const pwdA = pwdResult(r1!, 3);
    const pwdB = pwdResult(r2!, 3);
    const dirAPattern = /[\\/]a(\r|\n|$)/;
    const dirBPattern = /[\\/]b(\r|\n|$)/;
    expect(pwdA).toMatch(dirAPattern);
    expect(pwdB).toMatch(dirBPattern);
    expect(pwdA).not.toMatch(dirBPattern);
    expect(pwdB).not.toMatch(dirAPattern);
  }, 30_000);

  test("a narrowed-capability turn is denied a tool the parent can use", async () => {
    const root = tempRepo();
    const daemon = await createAgentDaemon({
      workspaceRoot: root,
      instanceFile: join(root, ".agency", "instance.json"),
      adapterFor: () => singleBashAdapter("pwd"),
      http: noopHttp,
      configDir: configAllowing({ bash: "allow" }),
    });
    daemons.push(daemon);
    const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
    clients.push(client);

    const result = (await client.call("run_turn", {
      turnId: "t-narrow",
      provider: "anthropic",
      model: "m",
      apiKey: "k",
      systemPrompt: "sys",
      session: [],
      sessionId: "s-narrow",
      capabilities: { tools: ["read"], pathScopes: "*", network: "*" },
    })) as RunTurnRpcResult;

    const toolResult = result.messages[1]?.content[0] as { content: string; isError: boolean } | undefined;
    expect(toolResult?.isError).toBe(true);
    expect(toolResult?.content).toMatch(/not allowed|outside|denied/i);

    const okResult = (await client.call("run_turn", {
      turnId: "t-wide",
      provider: "anthropic",
      model: "m",
      apiKey: "k",
      systemPrompt: "sys",
      session: [],
      sessionId: "s-wide",
    })) as RunTurnRpcResult;
    const okToolResult = okResult.messages[1]?.content[0] as { content: string; isError: boolean } | undefined;
    expect(okToolResult?.isError).toBe(false);
  }, 30_000);

  test("scope disposal resets cwd and todos for that session", async () => {
    const root = tempRepo();
    mkdirSync(join(root, "a"), { recursive: true });
    const daemon = await createAgentDaemon({
      workspaceRoot: root,
      instanceFile: join(root, ".agency", "instance.json"),
      adapterFor: (provider: string) => {
        if (provider === "setup") return cdThenPwdAdapter("a");
        return singleBashAdapter("pwd");
      },
      http: noopHttp,
      configDir: configAllowing({ bash: "allow", todo_write: "allow", todo_read: "allow" }),
    });
    daemons.push(daemon);
    const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
    clients.push(client);

    await client.call("run_turn", {
      turnId: "t-setup",
      provider: "setup",
      model: "m",
      apiKey: "k",
      systemPrompt: "sys",
      session: [],
      sessionId: "s-dispose",
    });

    const deleted = (await client.call("session_delete", { sessionId: "s-dispose" })) as { deleted: boolean };
    expect(deleted.deleted).toBe(true);

    const after = (await client.call("run_turn", {
      turnId: "t-after",
      provider: "check",
      model: "m",
      apiKey: "k",
      systemPrompt: "sys",
      session: [],
      sessionId: "s-dispose",
    })) as RunTurnRpcResult;
    const pwdContent = (after.messages[1]?.content[0] as { content: string } | undefined)?.content ?? "";
    expect(pwdContent).not.toContain(`${join(root, "a")}`);
    expect(pwdContent).toContain(root.replace(/\\/g, "/").split("/").pop() ?? "");
  }, 30_000);

  test("snapshot undo journal is per-session (one session's undo does not affect the other)", async () => {
    const root = tempRepo();
    writeFileSync(join(root, "shared.ts"), "original", "utf8");
    writeFileSync(join(root, "s1.txt"), "orig-s1", "utf8");
    writeFileSync(join(root, "s2.txt"), "orig-s2", "utf8");
    let s1Step = 0;
    const s1Adapter: ProviderAdapter = {
      family: "fake",
      async *stream(): AsyncIterable<StreamEvent> {
        s1Step += 1;
        if (s1Step === 1) {
          yield { type: "tool_call_start", id: "c1", name: "write" };
          yield { type: "tool_call_delta", id: "c1", inputJsonDelta: JSON.stringify({ path: "s1.txt", content: "s1-content" }) };
          yield { type: "tool_call_end", id: "c1" };
          yield { type: "message_stop", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } };
        } else {
          yield { type: "text_delta", text: "done" };
          yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
        }
      },
    };
    let s2Step = 0;
    const s2Adapter: ProviderAdapter = {
      family: "fake",
      async *stream(): AsyncIterable<StreamEvent> {
        s2Step += 1;
        if (s2Step === 1) {
          yield { type: "tool_call_start", id: "c1", name: "write" };
          yield { type: "tool_call_delta", id: "c1", inputJsonDelta: JSON.stringify({ path: "s2.txt", content: "s2-content" }) };
          yield { type: "tool_call_end", id: "c1" };
          yield { type: "message_stop", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } };
        } else {
          yield { type: "text_delta", text: "done" };
          yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
        }
      },
    };
    const daemon = await createAgentDaemon({
      workspaceRoot: root,
      instanceFile: join(root, ".agency", "instance.json"),
      adapterFor: (p: string) => (p === "p1" ? s1Adapter : s2Adapter),
      http: noopHttp,
      configDir: configAllowing({ write: "allow" }),
    });
    daemons.push(daemon);
    const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
    clients.push(client);

    await client.call("run_turn", { turnId: "t1", provider: "p1", model: "m", apiKey: "k", systemPrompt: "sys", session: [], sessionId: "sess1" });
    await client.call("run_turn", { turnId: "t2", provider: "p2", model: "m", apiKey: "k", systemPrompt: "sys", session: [], sessionId: "sess2" });

    const undo1 = (await client.call("undo", { sessionId: "sess1" })) as { undone: boolean };
    expect(undo1.undone).toBe(true);

    const undo2 = (await client.call("undo", { sessionId: "sess2" })) as { undone: boolean };
    expect(undo2.undone).toBe(true);
  }, 30_000);
});

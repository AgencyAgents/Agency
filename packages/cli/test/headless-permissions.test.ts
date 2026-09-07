import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, StreamEvent } from "@agency/providers";
import { connectToDaemon, type DaemonClient } from "@agency/rpc";
import type { Message } from "@agency/schema";
import { type AgentDaemon, createAgentDaemon, type RunTurnRpcResult } from "../src/daemon.ts";

const noopHttp: HttpClient = { fetch: async () => new Response() };
const daemons: AgentDaemon[] = [];
const clients: DaemonClient[] = [];
const dirs: string[] = [];

const prevKey = process.env.AGENCY_ANTHROPIC_API_KEY;
process.env.AGENCY_ANTHROPIC_API_KEY = "test-key-headless";
afterAll(() => {
  if (prevKey === undefined) delete process.env.AGENCY_ANTHROPIC_API_KEY;
  else process.env.AGENCY_ANTHROPIC_API_KEY = prevKey;
});
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const daemon of daemons.splice(0)) await daemon.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function writeConfigDir(config: Record<string, unknown>): string {
  const dir = tempDir("agency-headless-config-");
  writeFileSync(join(dir, "config.jsonc"), JSON.stringify({ schemaVersion: 2, ...config }));
  return dir;
}

/** First provider call emits one tool call, later calls answer in text. */
function toolCallAdapter(tool: string, input: unknown, followup = "done"): ProviderAdapter {
  let calls = 0;
  return {
    family: "fake",
    async *stream(): AsyncIterable<StreamEvent> {
      calls += 1;
      if (calls === 1) {
        yield { type: "tool_call_start", id: "c1", name: tool };
        yield { type: "tool_call_delta", id: "c1", inputJsonDelta: JSON.stringify(input) };
        yield { type: "tool_call_end", id: "c1" };
        yield { type: "message_stop", stopReason: "tool_use", usage: { inputTokens: 5, outputTokens: 5 } };
        return;
      }
      yield { type: "text_delta", text: followup };
      yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 5 } };
    },
  };
}

async function startDaemon(adapter: ProviderAdapter, configDir?: string) {
  const workspaceRoot = tempDir("agency-headless-ws-");
  const daemon = await createAgentDaemon({
    workspaceRoot,
    instanceFile: join(workspaceRoot, ".agency", "instance.json"),
    sessionsDir: tempDir("agency-headless-sess-"),
    adapterFor: () => adapter,
    http: noopHttp,
    ...(configDir ? { configDir } : {}),
  });
  daemons.push(daemon);
  const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
  clients.push(client);
  return { workspaceRoot, client };
}

function toolResultTexts(messages: Message[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === "tool_result") out.push(b.content);
    }
  }
  return out;
}

describe("headless permission modes", () => {
  test("a bash-invoking prompt under default mode ends with a typed refusal, not a hang", async () => {
    const { client } = await startDaemon(toolCallAdapter("bash", { command: "echo headless-ok" }));
    const result = (await client.call("run_turn", {
      turnId: "headless-refuse-1",
      provider: "anthropic",
      model: "test-model",
      systemPrompt: "sys",
      nonInteractive: true,
      session: [{ role: "user", content: [{ type: "text", text: "run the tests" }] }],
    })) as RunTurnRpcResult;
    expect(result.stopReason).toBe("end_turn");
    expect(toolResultTexts(result.messages).join("\n")).toContain("permission denied: bash");
  }, 30000);

  test("an edit prompt completes under --permission-mode allow-edits", async () => {
    const { workspaceRoot, client } = await startDaemon(
      toolCallAdapter("write", { path: "notes.txt", content: "headless edit" }, "written"),
    );
    const result = (await client.call("run_turn", {
      turnId: "headless-allow-1",
      provider: "anthropic",
      model: "test-model",
      systemPrompt: "sys",
      permissionMode: "allow-edits",
      nonInteractive: true,
      session: [{ role: "user", content: [{ type: "text", text: "write notes.txt" }] }],
    })) as RunTurnRpcResult;
    expect(result.stopReason).toBe("end_turn");
    expect(readFileSync(join(workspaceRoot, "notes.txt"), "utf8")).toBe("headless edit");
  }, 30000);

  test("deny mode refuses even file edits", async () => {
    const { workspaceRoot, client } = await startDaemon(
      toolCallAdapter("write", { path: "notes.txt", content: "x" }),
    );
    const result = (await client.call("run_turn", {
      turnId: "headless-deny-1",
      provider: "anthropic",
      model: "test-model",
      systemPrompt: "sys",
      permissionMode: "deny",
      nonInteractive: true,
      session: [{ role: "user", content: [{ type: "text", text: "write notes.txt" }] }],
    })) as RunTurnRpcResult;
    expect(result.stopReason).toBe("end_turn");
    // Denied tools are not even offered, so the call fails as unknown tool.
    expect(toolResultTexts(result.messages).join("\n")).toContain('no such tool: "write"');
    expect(existsSync(join(workspaceRoot, "notes.txt"))).toBe(false);
  }, 30000);

  test("an explicit config entry allows bash without any flag", async () => {
    const configDir = writeConfigDir({ permissions: { bash: "allow" } });
    const { client } = await startDaemon(toolCallAdapter("bash", { command: "echo headless-ok" }), configDir);
    const result = (await client.call("run_turn", {
      turnId: "headless-config-1",
      provider: "anthropic",
      model: "test-model",
      systemPrompt: "sys",
      nonInteractive: true,
      session: [{ role: "user", content: [{ type: "text", text: "echo something" }] }],
    })) as RunTurnRpcResult;
    expect(result.stopReason).toBe("end_turn");
    expect(toolResultTexts(result.messages).join("\n")).toContain("headless-ok");
  }, 30000);

  test("onboard writes a documented starter permissions map", async () => {
    const { runOnboarding } = await import("../src/onboarding.ts");
    const { createFileFallbackBackend } = await import("@agency/providers");
    const { createFileTrustStore } = await import("@agency/guard");
    const root = tempDir("agency-onboard-perms-ws-");
    const configDir = tempDir("agency-onboard-perms-config-");
    const keysDir = tempDir("agency-onboard-perms-keys-");
    const lines: string[] = [];
    const result = await runOnboarding({
      workspaceRoot: root,
      prompter: {
        line: async () => "",
        secret: async () => "",
        confirm: async () => true,
      },
      env: { AGENCY_OPENAI_API_KEY: "sk-test-onboard" },
      configDir,
      keychain: createFileFallbackBackend(keysDir),
      trustStore: createFileTrustStore(join(tempDir("agency-onboard-perms-trust-"), "trust.json")),
      http: noopHttp,
      catalog: [
        {
          id: "gpt-5.2",
          family: "openai",
          name: "gpt-5.2",
          providerName: "openai",
          contextWindow: 100_000,
          maxOutputTokens: 8_000,
          pricing: { inputPerMTok: 1, outputPerMTok: 2 },
          capabilities: { tools: true, vision: false, thinking: false },
        },
      ],
      cacheDir: tempDir("agency-onboard-perms-cache-"),
      out: (l) => lines.push(l),
    });
    expect(result.completed).toBe(true);
    const stored = JSON.parse(readFileSync(join(configDir, "config.jsonc"), "utf8"));
    expect(stored.permissions).toEqual({ read: "allow", write: "ask", edit: "ask", bash: "ask" });
    expect(lines.join("\n")).toContain("permissions");
    expect(existsSync(join(configDir, "config.jsonc"))).toBe(true);
  });
});

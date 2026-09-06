import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, StreamEvent } from "@agency/providers";
import { connectToDaemon, type DaemonClient } from "@agency/rpc";
import { type AgentDaemon, createAgentDaemon } from "../src/daemon.ts";

const noopHttp: HttpClient = { fetch: async () => new Response() };

const daemons: AgentDaemon[] = [];
const clients: DaemonClient[] = [];
const dirs: string[] = [];

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

function textAdapter(text: string): ProviderAdapter {
  return {
    family: "fake",
    async *stream(): AsyncIterable<StreamEvent> {
      yield { type: "text_delta", text };
      yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 3, outputTokens: 2 } };
    },
  };
}

function writeConfigDir(config: Record<string, unknown>): string {
  const dir = tempDir("agency-daemon-obs-config-");
  writeFileSync(join(dir, "config.jsonc"), JSON.stringify({ schemaVersion: 2, ...config }));
  return dir;
}

describe("daemon observability", () => {
  test("a turn's log lines persist to the rotated sink under one trace ID, with the API key redacted", async () => {
    const logsDir = tempDir("agency-daemon-logs-");
    const daemon = await createAgentDaemon({
      workspaceRoot: tempDir("agency-daemon-obs-root-"),
      instanceFile: join(tempDir("agency-daemon-inst-"), "instance.json"),
      adapterFor: () => textAdapter("hello"),
      http: noopHttp,
      tools: [],
      logsDir,
    });
    daemons.push(daemon);
    const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
    clients.push(client);

    await client.call("run_turn", {
      turnId: "obs-1",
      provider: "anthropic",
      model: "test-model",
      apiKey: "sk-ant-daemon-secret-9876543210",
      systemPrompt: "sys",
      session: [],
    });

    // The log sink writes asynchronously; stop() flushes it, so the full
    // turn's lines are on disk before the assertions read the file.
    await daemon.stop();
    daemons.splice(daemons.indexOf(daemon), 1);

    const logPath = join(logsDir, "agency.log");
    expect(existsSync(logPath)).toBe(true);
    const content = readFileSync(logPath, "utf8");

    const entries = content
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { message: string; traceId?: string });
    const started = entries.find((e) => e.message === "turn started");
    const finished = entries.find((e) => e.message === "turn finished");
    expect(started).toBeDefined();
    expect(finished).toBeDefined();
    expect(started!.traceId).toBe(finished!.traceId);
    expect(started!.traceId).not.toBeUndefined();

    expect(content).not.toContain("sk-ant-daemon-secret-9876543210");
  });

  test("telemetry records nothing when disabled and turn events when enabled", async () => {
    const telemetryDir = tempDir("agency-daemon-telemetry-");
    const eventsPath = join(telemetryDir, "telemetry", "events.jsonl");

    const off = await createAgentDaemon({
      workspaceRoot: tempDir("agency-daemon-obs-root-"),
      instanceFile: join(tempDir("agency-daemon-inst-"), "instance.json"),
      adapterFor: () => textAdapter("hello"),
      http: noopHttp,
      tools: [],
      telemetryDir,
    });
    daemons.push(off);
    const offClient = await connectToDaemon(off.server.port, "127.0.0.1", { token: off.server.token });
    clients.push(offClient);
    await offClient.call("run_turn", {
      turnId: "obs-off",
      provider: "anthropic",
      model: "m",
      apiKey: "k",
      systemPrompt: "sys",
      session: [],
    });
    expect(existsSync(eventsPath)).toBe(false);

    const configDir = writeConfigDir({ telemetryEnabled: true });
    const on = await createAgentDaemon({
      workspaceRoot: tempDir("agency-daemon-obs-root-"),
      instanceFile: join(tempDir("agency-daemon-inst-"), "instance.json"),
      adapterFor: () => textAdapter("hello"),
      http: noopHttp,
      tools: [],
      telemetryDir,
      configDir,
    });
    daemons.push(on);
    const onClient = await connectToDaemon(on.server.port, "127.0.0.1", { token: on.server.token });
    clients.push(onClient);
    await onClient.call("run_turn", {
      turnId: "obs-on",
      provider: "anthropic",
      model: "m",
      apiKey: "k",
      systemPrompt: "sys",
      session: [],
    });

    expect(existsSync(eventsPath)).toBe(true);
    const events = readFileSync(eventsPath, "utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { name: string; fields: Record<string, unknown> });
    const turnEvent = events.find((e) => e.name === "turn_complete");
    expect(turnEvent).toBeDefined();
    expect(turnEvent!.fields.provider).toBe("anthropic");
    expect(turnEvent!.fields.inputTokens).toBe(3);
  });
});

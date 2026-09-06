import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolSpec } from "@agency/core";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, StreamEvent } from "@agency/providers";
import { connectToDaemon, type DaemonClient } from "@agency/rpc";
import type { RunTurnRpcResult } from "../src/daemon.ts";
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

function tempInstanceFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "agency-cancel-e2e-"));
  dirs.push(dir);
  return join(dir, "instance.json");
}

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "agency-cancel-root-"));
  dirs.push(dir);
  return dir;
}

function waitForMarker(path: string, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (existsSync(path)) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`marker not created: ${path}`));
      setTimeout(tick, 20);
    };
    tick();
  });
}

function writeConfigDir(config: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "agency-cancel-config-"));
  dirs.push(dir);
  writeFileSync(join(dir, "config.jsonc"), JSON.stringify({ schemaVersion: 2, ...config }));
  return dir;
}

function toolCallingAdapter(
  toolName: string,
  input: Record<string, unknown>,
  secondText: string,
): ProviderAdapter {
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
        yield { type: "text_delta", text: secondText };
        yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
      }
    },
  };
}

function simpleTextAdapter(text: string): ProviderAdapter {
  return {
    family: "fake",
    async *stream(): AsyncIterable<StreamEvent> {
      yield { type: "text_delta", text };
      yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
}

function cancellableBashTool(markerPath: string): ToolSpec {
  return {
    name: "bash",
    description: "cancellable shell command for e2e",
    inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    riskTier: "dangerous",
    handler: async (_input, ctx) => {
      const script = `
        const fs = require('fs');
        process.stdout.write('partial line 1\\n');
        fs.writeFileSync(${JSON.stringify(markerPath)}, 'ready');
        // hold open indefinitely until killed
        setInterval(() => {}, 1000);
      `;
      const proc = Bun.spawn(["node", "-e", script], { stdout: "pipe", stderr: "pipe" });
      const stdoutText = new Response(proc.stdout).text();
      const stderrText = new Response(proc.stderr).text();

      let settleAbort: () => void = () => {};
      const abortSettled = new Promise<void>((resolve) => {
        settleAbort = resolve;
      });
      const onAbort = () => {
        try {
          proc.kill(9);
        } catch {}
        settleAbort();
      };
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener("abort", onAbort);

      try {
        const outcome = await Promise.race([
          Promise.all([stdoutText, stderrText, proc.exited]).then(([stdout, stderr]) => ({
            aborted: false as const,
            stdout,
            stderr,
          })),
          abortSettled.then(async () => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const [stdout, stderr] = await Promise.race([
              Promise.all([stdoutText, stderrText]),
              new Promise<[string, string]>((resolve) => {
                timer = setTimeout(() => resolve(["", ""]), 1000);
              }),
            ]);
            clearTimeout(timer);
            return { aborted: true as const, stdout, stderr };
          }),
        ]);
        let combined = outcome.stdout;
        if (outcome.stderr) combined += `\n[stderr]\n${outcome.stderr}`;
        if (outcome.aborted) {
          const notice = "[cancelled: command aborted before completion]";
          combined = combined ? `${combined}\n${notice}` : notice;
        }
        return { content: combined };
      } finally {
        ctx.signal.removeEventListener("abort", onAbort);
        try {
          proc.kill(9);
        } catch {}
      }
    },
  };
}

describe("cancellation e2e — Esc -> abort -> partial output -> resumable", () => {
  test("aborting mid-turn preserves partial output with [cancelled] and keeps session resumable", async () => {
    const markerDir = mkdtempSync(join(tmpdir(), "agency-cancel-marker-"));
    dirs.push(markerDir);
    const marker = join(markerDir, "ready");

    const bashTool = cancellableBashTool(marker);
    let adapter: ProviderAdapter = toolCallingAdapter("bash", { command: "sleep 60" }, "second turn ok");

    const daemon = await createAgentDaemon({
      workspaceRoot: tempRoot(),
      instanceFile: tempInstanceFile(),
      adapterFor: () => adapter,
      http: noopHttp,
      tools: [bashTool],
      configDir: writeConfigDir({ permissions: { bash: "allow" } }),
    });
    daemons.push(daemon);
    const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
    clients.push(client);

    const runPromise = client.call("run_turn", {
      turnId: "cancel-e2e-1",
      provider: "anthropic",
      model: "test-model",
      apiKey: "key",
      systemPrompt: "sys",
      session: [],
    }) as Promise<RunTurnRpcResult>;

    await waitForMarker(marker, 5000);

    const cancelResult = (await client.call("cancel_turn", { turnId: "cancel-e2e-1" })) as {
      cancelled: boolean;
    };
    expect(cancelResult.cancelled).toBe(true);

    const result = await runPromise;

    const toolResult = result.messages[1]?.content[0];
    expect(toolResult?.type).toBe("tool_result");
    if (toolResult?.type === "tool_result") {
      expect(toolResult.content).toContain("partial line 1");
      expect(toolResult.content).toContain("[cancelled");
    }

    adapter = simpleTextAdapter("second turn ok");
    const second = (await client.call("run_turn", {
      turnId: "cancel-e2e-2",
      provider: "anthropic",
      model: "test-model",
      apiKey: "key",
      systemPrompt: "sys",
      session: result.messages,
    })) as RunTurnRpcResult;

    expect(second.stopReason).toBe("end_turn");
    const text = second.messages
      .flatMap((m) => (m.role === "assistant" ? m.content : []))
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("");
    expect(text).toContain("second turn ok");
  }, 30_000);
});

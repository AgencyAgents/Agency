import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const daemon of daemons.splice(0)) await daemon.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `agency-spawn-${name}-`));
  dirs.push(dir);
  return dir;
}

const usage = { inputTokens: 1, outputTokens: 1 };

function* call(name: string, input: Record<string, unknown>): Iterable<StreamEvent> {
  yield { type: "tool_call_start", id: "c1", name };
  yield { type: "tool_call_delta", id: "c1", inputJsonDelta: JSON.stringify(input) };
  yield { type: "tool_call_end", id: "c1" };
  yield { type: "message_stop", stopReason: "tool_use", usage };
}

function* say(text: string): Iterable<StreamEvent> {
  yield { type: "text_delta", text };
  yield { type: "message_stop", stopReason: "end_turn", usage };
}

const isWorker = (request: ProviderRequest): boolean =>
  /ephemeral worker|REVIEWER-PROMPT/.test(request.system ?? "");
const hasResult = (request: ProviderRequest): boolean =>
  request.messages.some((m) => m.content.some((b) => b.type === "tool_result"));

/** A daemon with one agent file in the user config, and a model whose main turn sends `spawnInput` to spawn. */
async function setup(spawnInput: Record<string, unknown>, workerCall?: Iterable<StreamEvent>) {
  const configDir = tmp("cfg");
  mkdirSync(join(configDir, "agents"), { recursive: true });
  // The frontmatter of a Claude Code agent file: name, description, its tool names, a model alias, a color.
  writeFileSync(
    join(configDir, "agents", "reviewer.md"),
    "---\nname: reviewer\ndescription: Reviews a diff for defects\ntools: Read, Grep\nmodel: inherit\ncolor: blue\n---\nREVIEWER-PROMPT: report defects with file and line.\n",
  );
  const main: ProviderRequest[] = [];
  const worker: ProviderRequest[] = [];
  const adapter: ProviderAdapter = {
    family: "fake",
    async *stream(request): AsyncIterable<StreamEvent> {
      if (isWorker(request)) {
        worker.push(request);
        if (workerCall && !hasResult(request)) yield* workerCall;
        else yield* say("worker report");
        return;
      }
      main.push(request);
      if (!hasResult(request)) yield* call("spawn", spawnInput);
      else yield* say("done");
    },
  };
  const workspaceRoot = tmp("ws");
  const daemon = await createAgentDaemon({
    workspaceRoot,
    configDir,
    instanceFile: join(workspaceRoot, ".agency", "instance.json"),
    sessionsDir: tmp("sess"),
    approvalsDir: tmp("approvals"),
    adapterFor: () => adapter,
    http: noopHttp,
  });
  daemons.push(daemon);
  const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
  clients.push(client);
  const run = (permissionMode?: string) =>
    client.call("run_turn", {
      turnId: `t-${Math.random()}`,
      provider: "anthropic",
      model: "test-model",
      apiKey: "key",
      systemPrompt: "sys",
      session: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      sessionId: "s-spawn",
      ...(permissionMode === undefined ? {} : { permissionMode }),
    });
  return { run, main, worker, workspaceRoot };
}

describe("agent types of the spawn tool", () => {
  test("an agent file with a description is a type: the worker gets its prompt and its tools", async () => {
    const { run, main, worker } = await setup({ prompt: "check the diff", agent: "reviewer" });
    await run();
    const spawn = main[0]?.tools?.find((tool) => tool.name === "spawn");
    expect(spawn?.description).toContain("- reviewer: Reviews a diff for defects");
    expect(worker).toHaveLength(1);
    expect(worker[0]?.system).toContain("REVIEWER-PROMPT: report defects with file and line.");
    expect(worker[0]?.tools?.map((tool) => tool.name).sort()).toEqual(["grep", "read"]);
    expect(JSON.stringify(main[1]?.messages)).toContain("worker report");
  }, 30000);

  test("an unknown agent type is an error that names the types", async () => {
    const { run, main, worker } = await setup({ prompt: "check", agent: "nobody" });
    await run();
    expect(worker).toHaveLength(0);
    expect(JSON.stringify(main[1]?.messages)).toContain("unknown agent type: nobody");
    expect(JSON.stringify(main[1]?.messages)).toContain("reviewer");
  }, 30000);
});

describe("permissions of a spawned worker", () => {
  const write = call("write", { path: "from-worker.txt", content: "x" });

  test("in a run that allows all tools, a worker can write a file", async () => {
    const { run, workspaceRoot } = await setup({ prompt: "write the file" }, write);
    await run("allow-all");
    expect(existsSync(join(workspaceRoot, "from-worker.txt"))).toBe(true);
  }, 30000);

  test("in the default mode, a worker cannot write a file", async () => {
    const { run, workspaceRoot } = await setup({ prompt: "write the file" }, write);
    await run();
    expect(existsSync(join(workspaceRoot, "from-worker.txt"))).toBe(false);
  }, 30000);
});

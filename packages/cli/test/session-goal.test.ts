import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GOAL_JUDGE_PROMPT } from "@agency/core";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, StreamEvent } from "@agency/providers";
import { connectToDaemon, type DaemonClient } from "@agency/rpc";
import { type AgentDaemon, createAgentDaemon } from "../src/daemon.ts";

const noopHttp: HttpClient = { fetch: async () => new Response() };
const daemons: AgentDaemon[] = [];
const clients: DaemonClient[] = [];
const dirs: string[] = [];

const prevKey = process.env.AGENCY_ANTHROPIC_API_KEY;
process.env.AGENCY_ANTHROPIC_API_KEY = "test-key-goal";
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
  const dir = mkdtempSync(join(tmpdir(), `agency-goal-${name}-`));
  dirs.push(dir);
  return dir;
}

const usage = { inputTokens: 5, outputTokens: 5 };

/** A daemon whose model answers "work N" to a turn request, and the next of `verdicts` to a judge request. */
async function setup(verdicts: string[]) {
  const turnInputs: string[] = [];
  const judgeInputs: string[] = [];
  const adapter: ProviderAdapter = {
    family: "fake",
    async *stream(request): AsyncIterable<StreamEvent> {
      const judge = request.system === GOAL_JUDGE_PROMPT;
      (judge ? judgeInputs : turnInputs).push(JSON.stringify(request.messages));
      const text = judge ? (verdicts.shift() ?? "MET") : `work ${turnInputs.length}`;
      yield { type: "text_delta", text };
      yield { type: "message_stop", stopReason: "end_turn", usage };
    },
  };
  const workspaceRoot = tmp("ws");
  const daemon = await createAgentDaemon({
    workspaceRoot,
    configDir: tmp("cfg"),
    instanceFile: join(workspaceRoot, ".agency", "instance.json"),
    sessionsDir: tmp("sess"),
    adapterFor: () => adapter,
    http: noopHttp,
    tools: [],
  });
  daemons.push(daemon);
  const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
  clients.push(client);
  const send = (userText: string, goal?: string, maxToolIterations?: number) =>
    client.call("session_send", {
      sessionId: "g1",
      provider: "anthropic",
      model: "test-model",
      systemPrompt: "sys",
      userText,
      ...(goal === undefined ? {} : { goal }),
      ...(maxToolIterations === undefined ? {} : { maxToolIterations }),
    }) as Promise<{ stopReason: string }>;
  const goalCommand = async (args: string) =>
    (await client.call("command_run", { name: "goal", args })) as {
      text: string;
      data: { goal: string | null };
    };
  return { send, goalCommand, turnInputs, judgeInputs };
}

describe("the goal of a session", () => {
  test("a turn goes on until the judge finds the goal met, and the goal is then cleared", async () => {
    const { send, goalCommand, turnInputs, judgeInputs } = await setup([
      "NOT MET: the tests did not run",
      "MET",
    ]);
    expect((await goalCommand("g1 all tests pass")).data.goal).toBe("all tests pass");

    const result = await send("fix the bug");
    expect(result.stopReason).toBe("end_turn");
    expect(turnInputs).toHaveLength(2);
    expect(judgeInputs).toHaveLength(2);
    expect(judgeInputs[0]).toContain("Goal: all tests pass");
    expect(judgeInputs[0]).toContain("work 1");
    expect(turnInputs[1]).toContain("not met yet: the tests did not run");
    expect((await goalCommand("g1")).data.goal).toBeNull();

    await send("thanks");
    expect(judgeInputs).toHaveLength(2);
  }, 30000);

  test("session_send sets the goal, and the clear command removes it", async () => {
    const { send, goalCommand, judgeInputs } = await setup(["NOT MET: no"]);
    // The step limit of two ends the turn with the goal not met.
    await send("start", "the report is written", 2);
    expect(judgeInputs).toHaveLength(1);
    expect((await goalCommand("g1")).data.goal).toBe("the report is written");
    expect((await goalCommand("g1 clear")).data.goal).toBeNull();
  }, 30000);

  test("a reply of the judge that is not a verdict does not hold the turn", async () => {
    const { send, turnInputs } = await setup(["I am not sure."]);
    await send("start", "the report is written");
    expect(turnInputs).toHaveLength(1);
  }, 30000);
});

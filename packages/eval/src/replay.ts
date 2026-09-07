import { runChildTurn, runTurn } from "@agency/core";
import { FULL_CAPABILITIES } from "@agency/guard";
import type { HttpClient } from "@agency/net";
import { type ProviderAdapter, Scheduler, type StreamEvent } from "@agency/providers";
import type { EvalCassette, EvalTaskRecord } from "./types.ts";

/** Http client that proves zero provider calls: any fetch attempt throws. */
export function noFetchHttp(onCall?: () => void): HttpClient {
  return {
    fetch: async () => {
      onCall?.();
      throw new Error("eval replay must not call the provider");
    },
  };
}

/** Cassette-backed adapter: serves the recorded outcome, touches no network. */
export function cassetteAdapter(task: EvalTaskRecord): ProviderAdapter {
  return {
    family: "eval-cassette",
    async *stream(): AsyncIterable<StreamEvent> {
      yield { type: "text_delta", text: `cassette ${task.taskId} ${task.passed ? "pass" : "fail"}` };
      yield { type: "message_stop", stopReason: "end_turn", usage: { ...task.usage } };
    },
  };
}

/** Replay one task through the real runTurn assembly with a fake adapter. */
export async function replayTask(http: HttpClient, task: EvalTaskRecord) {
  const scheduler = new Scheduler({ maxAttempts: 1, requestsPerMinute: 1000 });
  return runTurn(cassetteAdapter(task), scheduler, http, {
    identity: { type: "user" },
    capabilities: FULL_CAPABILITIES,
    systemPrompt: "eval",
    tools: [],
    model: "eval/cassette",
    apiKey: "cassette",
    session: [{ role: "user", content: [{ type: "text", text: task.taskId }] }],
  });
}

/** Replay one task through the single child-turn assembly dispatch uses. */
export async function replayTaskViaChildTurn(http: HttpClient, cassette: EvalCassette, task: EvalTaskRecord) {
  const scheduler = new Scheduler({ maxAttempts: 1, requestsPerMinute: 1000 });
  return runChildTurn(
    { http, createTraceRecorder: () => undefined },
    {
      adapter: cassetteAdapter(task),
      scheduler,
      session: [{ role: "user", content: [{ type: "text", text: task.taskId }] }],
      systemPrompt: "eval",
      tools: [],
      model: "eval/cassette",
      apiKey: "cassette",
      provider: "eval",
      identity: { type: "user" },
      capabilities: FULL_CAPABILITIES,
      toolPolicy: { check: async () => "allow" as const },
      turnId: `eval-${task.taskId}`,
      sessionId: `eval-${cassette.roster}-${task.taskId}`,
      cwd: ".",
      taskDepth: 1,
    },
  );
}

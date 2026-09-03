import type { LoopEvent, RunTurnOptions } from "./loop.ts";
import type { ProviderAdapter } from "@agency/providers";
import type { HttpClient } from "@agency/net";
import { runTurn } from "./loop.ts";

export interface CassetteRecord {
  params: {
    provider: string;
    model: string;
    systemPrompt: string;
    session: RunTurnOptions["session"];
  };
  events: LoopEvent[];
  result: Awaited<ReturnType<typeof runTurn>>;
}

export async function recordCassette(
  adapter: ProviderAdapter,
  scheduler: import("@agency/providers").Scheduler,
  http: HttpClient,
  options: RunTurnOptions,
): Promise<CassetteRecord> {
  const events: LoopEvent[] = [];
  const wrappedOnEvent = (e: LoopEvent) => {
    events.push(e);
    options.onEvent?.(e);
  };
  const result = await runTurn(adapter, scheduler, http, { ...options, onEvent: wrappedOnEvent });
  return {
    params: {
      provider: options.model.split("/")[0] ?? "test",
      model: options.model,
      systemPrompt: options.systemPrompt,
      session: options.session,
    },
    events,
    result,
  };
}

export function writeCassette(path: string, record: CassetteRecord): void {
  const fs = require("node:fs") as typeof import("node:fs");
  fs.writeFileSync(path, JSON.stringify(record, null, 2));
}

export function readCassette(path: string): CassetteRecord {
  const fs = require("node:fs") as typeof import("node:fs");
  return JSON.parse(fs.readFileSync(path, "utf8")) as CassetteRecord;
}

export async function replayCassette(
  path: string,
  freshAdapter: ProviderAdapter,
  scheduler: import("@agency/providers").Scheduler,
  http: HttpClient,
  options: Omit<RunTurnOptions, "session" | "systemPrompt" | "model"> & { model?: string; systemPrompt?: string },
): Promise<{ equal: boolean; original: CassetteRecord; replayed: Awaited<ReturnType<typeof runTurn>> }> {
  const original = readCassette(path);
  const replayed = await runTurn(freshAdapter, scheduler, http, {
    ...options,
    model: options.model ?? original.params.model,
    systemPrompt: options.systemPrompt ?? original.params.systemPrompt,
    session: original.params.session,
  } as RunTurnOptions);
  const equal = JSON.stringify(replayed.messages) === JSON.stringify(original.result.messages);
  return { equal, original, replayed };
}

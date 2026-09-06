import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  for (const d of daemons.splice(0)) await d.stop().catch(() => {});
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function writeConfigDir(config: Record<string, unknown>): string {
  const dir = tempDir("agency-dp52-cfg-");
  writeFileSync(join(dir, "config.jsonc"), JSON.stringify({ schemaVersion: 2, ...config }));
  return dir;
}

const PRICED_MODEL = "claude-sonnet-5";
const USAGE = { inputTokens: 1000, outputTokens: 500 };
const HANDLES = ["w1", "w2", "w3", "w4", "w5"];

function teamCfg(): Record<string, unknown> {
  const agents: Record<string, unknown> = {
    leader: {
      role: "GeneralDispatcher",
      provider: "anthropic",
      model: PRICED_MODEL,
      effort: "low",
      enabled: true,
    },
  };
  for (const h of HANDLES) {
    agents[h] = { role: "Worker", provider: "anthropic", model: PRICED_MODEL, effort: "low", enabled: true };
  }
  return { agents };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Tracks concurrent stream entries so tests can prove parallel (not serial) spawn. */
function parallelAdapter(state: {
  active: number;
  maxActive: number;
  childBriefs: string[];
}): ProviderAdapter {
  return {
    family: "fake",
    async *stream(request): AsyncIterable<StreamEvent> {
      state.active++;
      state.maxActive = Math.max(state.maxActive, state.active);
      try {
        const msgs = request.messages;
        const hasToolResult = msgs.some((m) =>
          m.content.some((b) => (b as { type: string }).type === "tool_result"),
        );
        const lastUser = [...msgs].reverse().find((m) => m.role === "user");
        const txt =
          (
            lastUser?.content.find((b) => (b as { type: string }).type === "text") as
              | { text?: string }
              | undefined
          )?.text ?? "";
        if (!hasToolResult && txt === "please dispatch five") {
          yield { type: "tool_call_start", id: "c1", name: "dispatch" };
          yield {
            type: "tool_call_delta",
            id: "c1",
            inputJsonDelta: JSON.stringify({
              agents: HANDLES.map((h) => ({ handle: h, brief: `brief for ${h}` })),
            }),
          };
          yield { type: "tool_call_end", id: "c1" };
          yield { type: "message_stop", stopReason: "tool_use", usage: { ...USAGE } };
          return;
        }
        if (txt.startsWith("brief for ")) {
          state.childBriefs.push(txt);
          // Stagger so completion order differs from input order; the barrier
          // must still report results in input order. Base delay dwarfs the
          // pre-stream setup stagger so all five overlap in stream().
          const idx = HANDLES.findIndex((h) => txt === `brief for ${h}`);
          await sleep(300 + (HANDLES.length - idx) * 50);
          yield { type: "text_delta", text: `child output for ${txt}` };
          yield { type: "message_stop", stopReason: "end_turn", usage: { ...USAGE } };
          return;
        }
        if (txt === "compare prompt five") {
          await sleep(300);
          yield { type: "text_delta", text: "compare output" };
          yield { type: "message_stop", stopReason: "end_turn", usage: { ...USAGE } };
          return;
        }
        yield { type: "text_delta", text: "parent done" };
        yield { type: "message_stop", stopReason: "end_turn", usage: { ...USAGE } };
      } finally {
        state.active--;
      }
    },
  };
}

function toolResultText(result: RunTurnRpcResult): string {
  const msg = result.messages.find(
    (m) => m.role === "user" && m.content.some((b) => b.type === "tool_result"),
  );
  const block = msg?.content.find((b) => b.type === "tool_result") as { content?: string } | undefined;
  return block?.content ?? "";
}

async function startDaemon(state: { active: number; maxActive: number; childBriefs: string[] }) {
  const root = tempDir("agency-dp52-root-");
  const sessionsDir = tempDir("agency-dp52-sess-");
  const daemon = await createAgentDaemon({
    workspaceRoot: root,
    instanceFile: join(tempDir("agency-dp52-inst-"), "instance.json"),
    adapterFor: () => parallelAdapter(state),
    http: noopHttp,
    configDir: writeConfigDir(teamCfg()),
    sessionsDir,
  });
  daemons.push(daemon);
  const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
  clients.push(client);
  return { client };
}

describe("daemon parallel specialists (item 52)", () => {
  it("dispatch tool runs 5 specialists in parallel with ordered lean results", async () => {
    const state = { active: 0, maxActive: 0, childBriefs: [] as string[] };
    const { client } = await startDaemon(state);
    const result = (await client.call("run_turn", {
      turnId: "dp52-parent",
      provider: "anthropic",
      model: PRICED_MODEL,
      apiKey: "key",
      systemPrompt: "sys",
      session: [{ role: "user", content: [{ type: "text", text: "please dispatch five" }] }],
      sessionId: "dp52-parent-session",
    })) as RunTurnRpcResult;
    expect(result.stopReason).toBe("end_turn");
    // True parallel spawn: all five child turns overlap.
    expect(state.maxActive).toBe(5);
    expect(state.childBriefs.length).toBe(5);
    // Lean context: each child receives only its short brief, never a history.
    for (const brief of state.childBriefs) {
      expect(brief.length).toBeLessThanOrEqual(2000);
      expect(brief).toMatch(/^brief for w[1-5]$/);
    }
    const text = toolResultText(result);
    const lines = text.split("\n").filter(Boolean);
    expect(lines.length).toBe(5);
    // Promise barrier keeps input order even though w5 finishes first.
    for (let i = 0; i < HANDLES.length; i++) {
      expect(lines[i]).toContain(HANDLES[i]!);
      expect(lines[i]).not.toContain("\n");
    }
    const agents = (await client.call("agents_list", {})) as Array<{
      handle: string;
      state: string;
      costUsd: number;
    }>;
    for (const h of HANDLES) {
      const a = agents.find((x) => x.handle === h)!;
      expect(a.state).toBe("idle");
      expect(a.costUsd).toBeGreaterThan(0);
    }
  });

  it("dispatch_compare runs 5 specialists in parallel with ordered results", async () => {
    const state = { active: 0, maxActive: 0, childBriefs: [] as string[] };
    const { client } = await startDaemon(state);
    const res = (await client.call("dispatch_compare", {
      handles: [...HANDLES],
      prompt: "compare prompt five",
    })) as { results: Array<{ handle: string; result: string }> };
    expect(res.results.length).toBe(5);
    expect(state.maxActive).toBe(5);
    // Ordered by input handles, not by completion order.
    expect(res.results.map((r) => r.handle)).toEqual(HANDLES);
    for (const r of res.results) {
      expect(r.result).toContain(r.handle);
    }
  });
});

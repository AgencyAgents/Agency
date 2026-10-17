import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, ProviderRequest, StreamEvent } from "@agency/providers";
import { type AgentDaemon, createAgentDaemon } from "../src/daemon.ts";

const daemons: AgentDaemon[] = [];
const dirs: string[] = [];
const prevKey = process.env.AGENCY_ANTHROPIC_API_KEY;
const prevHome = process.env.AGENCY_HOME;
process.env.AGENCY_ANTHROPIC_API_KEY = "test-key-prefix";
// The memory file of the workspace goes under AGENCY_HOME, not in the data of the user.
process.env.AGENCY_HOME = mkdtempSync(join(tmpdir(), "agency-prefix-home-"));
afterAll(() => {
  if (prevKey === undefined) delete process.env.AGENCY_ANTHROPIC_API_KEY;
  else process.env.AGENCY_ANTHROPIC_API_KEY = prevKey;
  rmSync(process.env.AGENCY_HOME as string, { recursive: true, force: true });
  if (prevHome === undefined) delete process.env.AGENCY_HOME;
  else process.env.AGENCY_HOME = prevHome;
});
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

type Call = { name: string; input: Record<string, unknown> };

/** Plays the calls of each turn in order, one per request, then ends the turn; records every request. */
function recorder(turns: Call[][], seen: ProviderRequest[]): ProviderAdapter {
  let step = 0;
  return {
    family: "fake",
    async *stream(request): AsyncIterable<StreamEvent> {
      seen.push(structuredClone({ ...request, signal: undefined }));
      const last = request.messages.at(-1);
      if (last?.role === "user" && last.content.some((c) => c.type === "text")) step = 0;
      const turn = turns[0];
      const call = turn?.[step];
      if (call) {
        step += 1;
        const id = `c${seen.length}`;
        yield { type: "tool_call_start", id, name: call.name };
        yield { type: "tool_call_delta", id, inputJsonDelta: JSON.stringify(call.input) };
        yield { type: "tool_call_end", id };
        yield { type: "message_stop", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } };
        return;
      }
      turns.shift();
      yield { type: "text_delta", text: "done" };
      yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
}

test("every request of a session only appends to the one before it", async () => {
  const ws = tempDir("agency-prefix-ws-");
  writeFileSync(join(ws, "a.ts"), "export const a = 1;\n");
  const seen: ProviderRequest[] = [];
  const turns: Call[][] = [
    [
      { name: "read", input: { path: "a.ts" } },
      { name: "glob", input: { pattern: "*.ts" } },
    ],
    [
      { name: "bash", input: { command: "echo hi" } },
      // A note saved in the session reaches later sessions, not the system prompt of this one.
      { name: "memory", input: { action: "add", note: "tests run with bun test" } },
    ],
    [],
  ];
  const daemon = await createAgentDaemon({
    workspaceRoot: ws,
    instanceFile: join(ws, ".agency", "instance.json"),
    sessionsDir: tempDir("agency-prefix-sess-"),
    approvalsDir: tempDir("agency-prefix-appr-"),
    configDir: tempDir("agency-prefix-cfg-"),
    adapterFor: () => recorder(turns, seen),
    http: { fetch: async () => new Response() } satisfies HttpClient,
  });
  daemons.push(daemon);
  for (const userText of ["look around", "run it", "thanks"]) {
    const res = await fetch(`http://127.0.0.1:${daemon.httpPort}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${daemon.server.token}` },
      body: JSON.stringify({
        id: 1,
        method: "session_send",
        params: { sessionId: "s", provider: "anthropic", model: "m", userText, permissionMode: "allow-all" },
      }),
    });
    expect(((await res.json()) as { error?: unknown }).error).toBeUndefined();
  }

  const report = seen.map((r, i) => {
    const prev = seen[i - 1];
    const prefixOk =
      prev === undefined ||
      JSON.stringify(r.messages.slice(0, prev.messages.length)) === JSON.stringify(prev.messages);
    return {
      i,
      messages: r.messages.length,
      systemSame: prev === undefined || prev.system === r.system,
      segmentsSame:
        prev === undefined || JSON.stringify(prev.systemSegments) === JSON.stringify(r.systemSegments),
      toolsSame: prev === undefined || JSON.stringify(prev.tools) === JSON.stringify(r.tools),
      prefixOk,
    };
  });
  // PREFIX_DUMP=<file> keeps the requests, to measure what each one sends.
  if (process.env.PREFIX_DUMP) writeFileSync(process.env.PREFIX_DUMP, JSON.stringify(seen, null, 1));
  expect(report.filter((r) => !(r.systemSame && r.segmentsSame && r.toolsSame && r.prefixOk))).toEqual([]);
  // A session with no team sends no tools of the team.
  expect(seen[0]?.tools?.map((t) => t.name)).not.toContain("board_read");
}, 60_000);

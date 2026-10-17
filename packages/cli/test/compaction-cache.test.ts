import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, ProviderRequest, StreamEvent } from "@agency/providers";
import { type AgentDaemon, createAgentDaemon } from "../src/daemon.ts";

const daemons: AgentDaemon[] = [];
const dirs: string[] = [];
const prevKey = process.env.AGENCY_ANTHROPIC_API_KEY;
const prevHome = process.env.AGENCY_HOME;
process.env.AGENCY_ANTHROPIC_API_KEY = "test-key-compaction-cache";
process.env.AGENCY_HOME = mkdtempSync(join(tmpdir(), "agency-ccache-home-"));
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

const isWhole = (r: ProviderRequest) =>
  JSON.stringify(r.messages.at(-1)).includes("This message is from the harness");

test("a compaction before a turn asks its summary at the end of the last request of the session", async () => {
  const ws = tempDir("agency-ccache-ws-");
  const seen: ProviderRequest[] = [];
  const adapter: ProviderAdapter = {
    family: "fake",
    async *stream(request): AsyncIterable<StreamEvent> {
      seen.push(structuredClone({ ...request, signal: undefined }));
      yield { type: "text_delta", text: isWhole(request) ? "SUMMARY: the port is 8443" : "done" };
      yield {
        type: "message_stop",
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 1, cachedInputTokens: 8 },
      };
    },
  };
  const daemon = await createAgentDaemon({
    workspaceRoot: ws,
    instanceFile: join(ws, ".agency", "instance.json"),
    sessionsDir: tempDir("agency-ccache-sess-"),
    approvalsDir: tempDir("agency-ccache-appr-"),
    configDir: tempDir("agency-ccache-cfg-"),
    adapterFor: () => adapter,
    http: { fetch: async () => new Response() } satisfies HttpClient,
  });
  daemons.push(daemon);
  // The first prompt alone is over the trigger of a 4000-token window: the second turn compacts first.
  for (const userText of [`set the port to 8443 ${"word ".repeat(4000)}`, "go on"]) {
    const res = await fetch(`http://127.0.0.1:${daemon.httpPort}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${daemon.server.token}` },
      body: JSON.stringify({
        id: 1,
        method: "session_send",
        params: {
          sessionId: "s",
          provider: "anthropic",
          model: "m",
          userText,
          permissionMode: "allow-all",
          contextWindow: 4000,
        },
      }),
    });
    expect(((await res.json()) as { error?: unknown }).error).toBeUndefined();
  }

  const [first, whole, second] = seen;
  expect(seen).toHaveLength(3);
  expect(whole && isWhole(whole)).toBe(true);
  expect(whole?.system).toBe(first?.system);
  expect(JSON.stringify(whole?.tools)).toBe(JSON.stringify(first?.tools));
  expect(JSON.stringify(whole?.messages.slice(0, first?.messages.length))).toBe(
    JSON.stringify(first?.messages),
  );
  expect(JSON.stringify(second?.messages)).toContain("SUMMARY: the port is 8443");
}, 60_000);

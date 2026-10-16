import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, StreamEvent } from "@agency/providers";
import { connectToDaemon, type DaemonClient } from "@agency/rpc";
import { setShellEnv } from "@agency/tools";
import { type AgentDaemon, createAgentDaemon } from "../src/daemon.ts";

const noopHttp: HttpClient = { fetch: async () => new Response() };
const daemons: AgentDaemon[] = [];
const clients: DaemonClient[] = [];
const dirs: string[] = [];

const prevKey = process.env.AGENCY_ANTHROPIC_API_KEY;
process.env.AGENCY_ANTHROPIC_API_KEY = "test-key-setup-script";
afterAll(() => {
  if (prevKey === undefined) delete process.env.AGENCY_ANTHROPIC_API_KEY;
  else process.env.AGENCY_ANTHROPIC_API_KEY = prevKey;
});
afterEach(async () => {
  setShellEnv(); // the daemon sets it for the whole process
  for (const client of clients.splice(0)) await client.close();
  for (const daemon of daemons.splice(0)) await daemon.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `agency-setup-${name}-`));
  dirs.push(dir);
  return dir;
}

/** A daemon whose config has a setup script (a node file) and one variable of `shellEnv`. */
async function setup(scriptBody: string, failFirstRequest = false) {
  const workspaceRoot = tmp("ws");
  const configDir = tmp("cfg");
  const scripts = tmp("scripts");
  const file = join(scripts, "setup.js");
  writeFileSync(file, scriptBody);
  writeFileSync(
    join(configDir, "config.jsonc"),
    JSON.stringify({
      setupScript: `"${process.execPath}" "${file}"`,
      shellEnv: { SETUP_FOO: "bar" },
    }),
  );
  const marker = join(workspaceRoot, "setup-marker.txt");
  // The marker as the model's first request found it.
  const seen: boolean[] = [];
  const adapter: ProviderAdapter = {
    family: "fake",
    async *stream(): AsyncIterable<StreamEvent> {
      seen.push(existsSync(marker));
      if (failFirstRequest && seen.length === 1) throw new Error("provider is down");
      yield { type: "text_delta", text: "done" };
      yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 5 } };
    },
  };
  const daemon = await createAgentDaemon({
    workspaceRoot,
    configDir,
    trustStorePath: join(tmp("trust"), "trust.json"),
    instanceFile: join(workspaceRoot, ".agency", "instance.json"),
    sessionsDir: tmp("sess"),
    adapterFor: () => adapter,
    http: noopHttp,
    tools: [],
  });
  daemons.push(daemon);
  const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
  clients.push(client);
  return { client, marker, seen };
}

const send = (client: DaemonClient, userText: string) =>
  client.call("session_send", {
    sessionId: "setup-s1",
    provider: "anthropic",
    model: "test-model",
    systemPrompt: "sys",
    userText,
  }) as Promise<{ stopReason: string }>;

describe("setupScript", () => {
  test("runs once in the workspace root before the first turn, with shellEnv", async () => {
    const { client, marker, seen } = await setup(
      `const fs = require("node:fs"); fs.appendFileSync("setup-marker.txt", process.env.SETUP_FOO + "@" + process.cwd() + "\\n");`,
    );
    await send(client, "one");
    expect(seen).toEqual([true]);
    await send(client, "two");
    expect(seen).toEqual([true, true]);
    const lines = readFileSync(marker, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]?.startsWith("bar@")).toBe(true);
  }, 30000);

  test("a turn that fails after the script ran does not run it again in the next turn", async () => {
    const { client, marker } = await setup(
      `require("node:fs").appendFileSync("setup-marker.txt", "run\\n");`,
      true,
    );
    await expect(send(client, "one")).rejects.toThrow();
    await send(client, "two");
    expect(readFileSync(marker, "utf8").trim().split("\n")).toHaveLength(1);
  }, 30000);

  test("a failing script fails the first turn with its last output lines, and the model never runs", async () => {
    const { client, seen } = await setup(
      `console.log("noise".repeat(5000)); setTimeout(() => { console.log("boom: npm install failed"); process.exit(3); }, 200);`,
    );
    await expect(send(client, "one")).rejects.toThrow("boom: npm install failed");
    expect(seen).toEqual([]);
  }, 30000);

  test("the script gets shellEnv but no provider key of the harness", async () => {
    const { client, marker } = await setup(
      `require("node:fs").writeFileSync("setup-marker.txt", (process.env.AGENCY_ANTHROPIC_API_KEY ?? "none") + " " + process.env.SETUP_FOO);`,
    );
    await send(client, "one");
    expect(readFileSync(marker, "utf8")).toBe("none bar");
  }, 30000);

  test("cancelling the turn stops a running script", async () => {
    const { client, marker } = await setup(
      `const fs = require("node:fs"); fs.writeFileSync("started.txt", ""); setTimeout(() => fs.writeFileSync("setup-marker.txt", "late"), 3000);`,
    );
    const started = join(marker, "..", "started.txt");
    const sending = client.call("session_send", {
      turnId: "setup-t1",
      sessionId: "setup-s1",
      provider: "anthropic",
      model: "test-model",
      userText: "one",
    });
    // Bun's expect().rejects waits for the promise at once: the outcome is read later.
    const outcome = sending.then(
      () => "resolved",
      (error: unknown) => String(error),
    );
    while (!existsSync(started)) await new Promise((r) => setTimeout(r, 50));
    expect(await client.call("cancel_turn", { turnId: "setup-t1" })).toEqual({ cancelled: true });
    expect(await outcome).toContain("the setup script failed: cancelled");
    await new Promise((r) => setTimeout(r, 3500));
    expect(existsSync(marker)).toBe(false);
  }, 30000);
});

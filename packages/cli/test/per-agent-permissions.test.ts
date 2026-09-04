import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  for (const c of clients.splice(0)) await c.close();
  for (const d of daemons.splice(0)) await d.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempInstanceFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "agency-perm-"));
  dirs.push(dir);
  return join(dir, "instance.json");
}

function writeConfigDir(config: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "agency-perm-cfg-"));
  dirs.push(dir);
  writeFileSync(join(dir, "config.jsonc"), JSON.stringify({ schemaVersion: 2, ...config }));
  return dir;
}

function toolCallAdapter(
  toolName: string,
  toolInput: Record<string, unknown>,
  finalText: string,
): ProviderAdapter {
  let step = 0;
  return {
    family: "fake",
    async *stream(): AsyncIterable<StreamEvent> {
      step += 1;
      if (step === 1) {
        yield { type: "tool_call_start", id: "c1", name: toolName };
        yield { type: "tool_call_delta", id: "c1", inputJsonDelta: JSON.stringify(toolInput) };
        yield { type: "tool_call_end", id: "c1" };
        yield { type: "message_stop", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } };
      } else {
        yield { type: "text_delta", text: finalText };
        yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
      }
    },
  };
}

describe("per-agent permissions", () => {
  it("agents_list includes agents from config with permissions", async () => {
    const cfg = {
      agents: {
        leader: {
          role: "Leader",
          provider: "anthropic",
          model: "claude",
          effort: "medium",
          enabled: true,
          permissions: {
            read: "allow",
            glob: "allow",
            grep: "allow",
            write: { "*": "deny", ".agency/plans/**": "allow" },
          },
        },
        coder: {
          role: "Coder",
          provider: "anthropic",
          model: "claude",
          effort: "medium",
          enabled: true,
          permissions: {
            read: "allow",
            write: "allow",
            edit: "allow",
            bash: "allow",
            glob: "allow",
            grep: "allow",
          },
        },
      },
    };
    const daemon = await createAgentDaemon({
      workspaceRoot: "/repo/fake",
      instanceFile: tempInstanceFile(),
      adapterFor: () => toolCallAdapter("read", { path: "test.txt" }, "done"),
      http: noopHttp,
      configDir: writeConfigDir(cfg),
    });
    daemons.push(daemon);
    const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
    clients.push(client);

    const agents = (await client.call("agents_list", {})) as Array<Record<string, unknown>>;
    expect(agents.length).toBe(2);
    const leaderAgent = agents.find((a) => a.handle === "leader")!;
    expect(leaderAgent.role).toBe("Leader");
    const coder = agents.find((a) => a.handle === "coder")!;
    expect(coder.role).toBe("Coder");
  });

  it("single-occupant room with no per-agent override works like global gate", async () => {
    const cfg = {
      agents: {
        leader: { role: "Leader", provider: "anthropic", model: "claude", effort: "low", enabled: true },
      },
      permissions: { read: "allow", bash: "allow" },
    };
    const daemon = await createAgentDaemon({
      workspaceRoot: "/repo/fake",
      instanceFile: tempInstanceFile(),
      adapterFor: () => toolCallAdapter("read", { path: "test.txt" }, "done"),
      http: noopHttp,
      configDir: writeConfigDir(cfg),
    });
    daemons.push(daemon);
    const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
    clients.push(client);

    const agents = (await client.call("agents_list", {})) as Array<Record<string, unknown>>;
    expect(agents.length).toBe(1);
    expect(agents[0]!.handle).toBe("leader");
  });
});

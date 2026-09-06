import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

type NextStep =
  | { kind: "tool"; name: string; input: Record<string, unknown> }
  | { kind: "text"; text: string };

interface SpyCall {
  text: string;
  tools: string[];
}

function spyAdapter(
  spy: { calls: SpyCall[] },
  next: (text: string, toolResult: string) => NextStep,
): ProviderAdapter {
  return {
    family: "fake",
    async *stream(request): AsyncIterable<StreamEvent> {
      const tools = (request.tools ?? []).map((t) => t.name);
      const blocks = [...request.messages].reverse().find((m) => m.role === "user")?.content as
        | Array<{ type: string; text?: string; content?: string }>
        | undefined;
      const text = blocks?.find((b) => b.type === "text")?.text ?? "";
      const toolResult = blocks?.find((b) => b.type === "tool_result")?.content ?? "";
      spy.calls.push({ text, tools });
      const step = next(text, toolResult);
      if (step.kind === "tool") {
        yield { type: "tool_call_start", id: "c1", name: step.name };
        yield { type: "tool_call_delta", id: "c1", inputJsonDelta: JSON.stringify(step.input) };
        yield { type: "tool_call_end", id: "c1" };
        yield { type: "message_stop", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } };
      } else {
        yield { type: "text_delta", text: step.text };
        yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
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

const PLANNER_PERMS = {
  read: "allow",
  glob: "allow",
  grep: "allow",
  write: { "*": "deny", ".agency/plans/**": "allow" },
  edit: { "*": "deny", ".agency/plans/**": "allow" },
};

const CODER_PERMS = {
  read: "allow",
  glob: "allow",
  grep: "allow",
  write: { "*": "allow", ".agency/plans/**": "deny" },
  edit: "allow",
  bash: "allow",
};

const GLOBAL_PERMS = {
  read: "allow",
  glob: "allow",
  grep: "allow",
  write: "allow",
  edit: "allow",
  bash: "allow",
};

function agentEntry(role: string, permissions?: Record<string, unknown>): Record<string, unknown> {
  return {
    role,
    provider: "anthropic",
    model: "claude",
    effort: "medium",
    enabled: true,
    ...(permissions ? { permissions } : {}),
  };
}

async function startDaemon(cfg: Record<string, unknown>, root: string, adapter: ProviderAdapter) {
  const daemon = await createAgentDaemon({
    workspaceRoot: root,
    instanceFile: join(root, ".agency", "instance.json"),
    adapterFor: () => adapter,
    http: noopHttp,
    configDir: writeConfigDir(cfg),
  });
  daemons.push(daemon);
  const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
  clients.push(client);
  return client;
}

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "agency-perm-"));
  dirs.push(dir);
  return dir;
}

function gitRoot(): string {
  const dir = tempRoot();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "qa@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "qa"], { cwd: dir });
  writeFileSync(join(dir, "app.ts"), "export const v = 1;\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
  return dir;
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

  it("dispatched planner is offered no bash", async () => {
    const root = gitRoot();
    const spy = { calls: [] as SpyCall[] };
    const adapter = spyAdapter(spy, (text, toolResult) => {
      if (toolResult.length > 0) return { kind: "text", text: "parent done" };
      if (text.includes("planner brief")) return { kind: "text", text: "planner done" };
      return {
        kind: "tool",
        name: "dispatch",
        input: { agents: [{ handle: "planner", brief: "planner brief alpha" }] },
      };
    });
    const client = await startDaemon(
      {
        permissions: GLOBAL_PERMS,
        agents: { leader: agentEntry("Leader"), planner: agentEntry("Planner", PLANNER_PERMS) },
      },
      root,
      adapter,
    );

    const result = (await client.call("run_turn", {
      turnId: "t-dispatch-planner",
      provider: "anthropic",
      model: "test-model",
      apiKey: "key",
      systemPrompt: "sys",
      session: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      sessionId: "test-dispatch-planner",
    })) as RunTurnRpcResult;
    expect(result.stopReason).toBe("end_turn");

    const childCalls = spy.calls.filter((c) => !c.text.includes("go") && c.text.length > 0);
    expect(childCalls.length).toBeGreaterThan(0);
    for (const c of childCalls) {
      expect(c.tools).not.toContain("bash");
      expect(c.tools).toContain("read");
    }
  });

  it("agent-owned session turn enforces the per-agent gate, not the global one", async () => {
    const root = tempRoot();
    const spy = { calls: [] as SpyCall[] };
    const adapter = spyAdapter(spy, (_text, toolResult) => {
      if (toolResult.length > 0) return { kind: "text", text: `ECHO:${toolResult}` };
      return { kind: "tool", name: "read", input: { path: "test.txt" } };
    });
    const client = await startDaemon(
      {
        permissions: { ...GLOBAL_PERMS, bash: "allow" },
        agents: { leader: agentEntry("Leader"), planner: agentEntry("Planner", PLANNER_PERMS) },
      },
      root,
      adapter,
    );

    const result = (await client.call("run_turn", {
      turnId: "t-agent-session",
      provider: "anthropic",
      model: "test-model",
      apiKey: "key",
      systemPrompt: "sys",
      session: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      sessionId: "team-planner",
    })) as RunTurnRpcResult;
    expect(result.stopReason).toBe("end_turn");

    const offered = spy.calls[0]?.tools ?? [];
    expect(offered).not.toContain("bash");
    expect(offered).toContain("read");
  });

  it("coder write to the plans dir is rejected by the per-agent gate", async () => {
    const root = tempRoot();
    const spy = { calls: [] as SpyCall[] };
    const adapter = spyAdapter(spy, (_text, toolResult) => {
      if (toolResult.length > 0) return { kind: "text", text: `ECHO:${toolResult}` };
      return { kind: "tool", name: "write", input: { path: ".agency/plans/sneaky.md", content: "x" } };
    });
    const client = await startDaemon(
      {
        permissions: GLOBAL_PERMS,
        agents: { leader: agentEntry("Leader"), coder: agentEntry("Coder", CODER_PERMS) },
      },
      root,
      adapter,
    );

    const result = (await client.call("run_turn", {
      turnId: "t-coder-write",
      provider: "anthropic",
      model: "test-model",
      apiKey: "key",
      systemPrompt: "sys",
      session: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      sessionId: "team-coder",
    })) as RunTurnRpcResult;
    expect(result.stopReason).toBe("end_turn");

    expect(toolResultText(result)).toContain("permission denied");
    expect(existsSync(join(root, ".agency", "plans", "sneaky.md"))).toBe(false);
  });

  it("solo-room with no override behaves identically to the global gate", async () => {
    const root = tempRoot();
    const spy = { calls: [] as SpyCall[] };
    const adapter = spyAdapter(spy, (_text, toolResult) => {
      if (toolResult.length > 0) return { kind: "text", text: `ECHO:${toolResult}` };
      return { kind: "tool", name: "write", input: { path: "hello.txt", content: "hi" } };
    });
    const client = await startDaemon({ permissions: GLOBAL_PERMS }, root, adapter);

    const result = (await client.call("run_turn", {
      turnId: "t-solo",
      provider: "anthropic",
      model: "test-model",
      apiKey: "key",
      systemPrompt: "sys",
      session: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      sessionId: "test-solo",
    })) as RunTurnRpcResult;
    expect(result.stopReason).toBe("end_turn");

    expect(toolResultText(result)).not.toContain("permission denied");
    expect(existsSync(join(root, "hello.txt"))).toBe(true);
    expect(spy.calls[0]?.tools ?? []).toContain("bash");
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

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolSpec } from "@agency/core";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, StreamEvent } from "@agency/providers";
import { type AgentDaemon, createAgentDaemon } from "../src/daemon.ts";

const noopHttp: HttpClient = { fetch: async () => new Response() };
const daemons: AgentDaemon[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function echoAdapter(): ProviderAdapter {
  return {
    family: "fake",
    async *stream(): AsyncIterable<StreamEvent> {
      yield { type: "text_delta", text: "ok" };
      yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 5 } };
    },
  };
}

async function startDaemon() {
  const workspaceRoot = tempDir("agency-10b-ws-");
  const daemon = await createAgentDaemon({
    workspaceRoot,
    instanceFile: join(workspaceRoot, ".agency", "instance.json"),
    sessionsDir: tempDir("agency-10b-sess-"),
    approvalsDir: tempDir("agency-10b-appr-"),
    adapterFor: () => echoAdapter(),
    http: noopHttp,
    tools: [] as ToolSpec[],
  });
  daemons.push(daemon);
  return {
    daemon,
    workspaceRoot,
    base: `http://127.0.0.1:${daemon.httpPort}`,
    token: daemon.server.token as string,
  };
}

async function rpcCall(
  base: string,
  token: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<{ status: number; body: { result?: unknown; error?: { message: string } } }> {
  const res = await fetch(`${base}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ id: `req-${method}`, method, params }),
  });
  return {
    status: res.status,
    body: (await res.json()) as { result?: unknown; error?: { message: string } },
  };
}

async function rpcOk(
  base: string,
  token: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const { status, body } = await rpcCall(base, token, method, params);
  if (status !== 200 || body.error !== undefined || body.result === undefined) {
    throw new Error(`rpc ${method} failed (${status}): ${JSON.stringify(body)}`);
  }
  return body.result;
}

describe("Phase 10b team surface", () => {
  test("task_file, board_read, board_claim accept plus decline plus counter plus escalate", async () => {
    const { base, token } = await startDaemon();
    const filed = (await rpcOk(base, token, "task_file", { content: "ship auth" })) as {
      item: { id: string; status: string };
    };
    expect(filed.item.status).toBe("pending");
    const read = (await rpcOk(base, token, "board_read")) as {
      items: { id: string }[];
      events: { move: string }[];
    };
    expect(read.items.map((i) => i.id)).toContain(filed.item.id);
    expect(read.events.length).toBeGreaterThan(0);

    await rpcOk(base, token, "board_claim", { id: filed.item.id, move: "accept", handle: "coder" });
    const afterAccept = (await rpcOk(base, token, "board_read")) as {
      items: { id: string; status: string; claimedBy?: string }[];
    };
    expect(afterAccept.items.find((i) => i.id === filed.item.id)?.claimedBy).toBe("coder");

    const second = (await rpcOk(base, token, "task_file", { content: "ship db" })) as {
      item: { id: string };
    };
    await rpcOk(base, token, "board_claim", {
      id: second.item.id,
      move: "decline",
      handle: "coder",
      reason: "out of scope",
    });
    const countered = (await rpcOk(base, token, "board_claim", {
      id: second.item.id,
      move: "counter",
      handle: "coder",
      content: "ship db reads only",
    })) as { item: { id: string } };
    expect(countered.item.id).not.toBe(second.item.id);
    await rpcOk(base, token, "board_claim", {
      id: countered.item.id,
      move: "escalate",
      handle: "coder",
      question: "which driver?",
    });
    const done = (await rpcOk(base, token, "board_read")) as {
      items: { id: string; status: string }[];
    };
    expect(done.items.find((i) => i.id === countered.item.id)?.status).toBe("needs-user");
    const bad = await rpcCall(base, token, "board_claim", { id: "missing", move: "accept", handle: "coder" });
    expect(bad.status).toBe(500);
  });

  test("inbox_send plus channel_read plus decisions_read plus report_get", async () => {
    const { base, token } = await startDaemon();
    const sent = (await rpcOk(base, token, "inbox_send", {
      kind: "notify",
      from: "lead",
      text: "standup in five",
    })) as { message: { id: string } };
    expect(sent.message.id).toBe("m-1");
    const refused = await rpcCall(base, token, "inbox_send", { kind: "ask", from: "coder", text: "help" });
    expect(refused.status).toBe(500);
    const channel = (await rpcOk(base, token, "channel_read", { since: 0 })) as {
      posts: unknown[];
      cursor: number;
    };
    expect(channel.posts).toEqual([]);
    expect(channel.cursor).toBe(0);
    const decisions = (await rpcOk(base, token, "decisions_read")) as { decisions: unknown[] };
    expect(decisions.decisions).toEqual([]);
    await rpcOk(base, token, "task_file", { content: "team goal item" });
    const report = (await rpcOk(base, token, "report_get", { outcome: "complete" })) as {
      goal: string;
      outcome: string;
      cost: { totalUsd: number };
    };
    expect(report.goal).toBe("team goal item");
    expect(report.outcome).toBe("complete");
    expect(report.cost.totalUsd).toBe(0);
  });

  test("owners_read resolves the .agency/owners map", async () => {
    const { base, token, workspaceRoot } = await startDaemon();
    mkdirSync(join(workspaceRoot, ".agency"), { recursive: true });
    writeFileSync(join(workspaceRoot, ".agency", "owners"), "src/auth/** @coder @security\n", "utf8");
    const owned = (await rpcOk(base, token, "owners_read", { path: "src/auth/login.ts" })) as {
      handles: string[];
    };
    expect(owned.handles).toEqual(["coder", "security"]);
    const bare = (await rpcOk(base, token, "owners_read", { path: "docs/readme.md" })) as {
      handles: string[];
    };
    expect(bare.handles).toEqual([]);
  });

  test("agent_inspect timeline plus reasoning plus step refusal plus peer scoping", async () => {
    const { base, token } = await startDaemon();
    const timeline = (await rpcOk(base, token, "agent_inspect", {
      handle: "coder",
      granularity: "timeline",
    })) as { lines: string[]; chargeUsd: number };
    expect(timeline.lines).toEqual([]);
    expect(timeline.chargeUsd).toBeGreaterThan(0);
    const reasoning = (await rpcOk(base, token, "agent_inspect", {
      handle: "coder",
      granularity: "reasoning",
    })) as { text: string };
    expect(reasoning.text).toBe("");
    const missing = await rpcCall(base, token, "agent_inspect", {
      handle: "coder",
      granularity: "step",
      step: 3,
    });
    expect(missing.status).toBe(500);
    const peer = await rpcCall(base, token, "agent_inspect", {
      handle: "coder",
      granularity: "timeline",
      requester: "reviewer",
      isLead: false,
    });
    expect(peer.status).toBe(500);
  });

  test("agents_upsert writes the file and refreshes the registry", async () => {
    const { base, token } = await startDaemon();
    const upserted = (await rpcOk(base, token, "agents_upsert", {
      handle: "scout",
      role: "scout",
      provider: "anthropic",
      model: "claude-sonnet-5",
      effort: "low",
      body: "You scout ahead.",
    })) as { handle: string; file: string; registered: boolean };
    expect(upserted.registered).toBe(true);
    expect(upserted.file).toContain("scout.md");
    const listed = (await rpcOk(base, token, "agents_list")) as { handle: string }[];
    expect(listed.map((a) => a.handle)).toContain("scout");
    const partial = (await rpcOk(base, token, "agents_upsert", { handle: "draft", body: "Drafting." })) as {
      registered: boolean;
    };
    expect(partial.registered).toBe(false);
    const bad = await rpcCall(base, token, "agents_upsert", { handle: "Bad Handle" });
    expect(bad.status).toBe(500);
  });

  test("team_status, agents_list, activity_graph agree on agents plus tasks plus zero-cost sums", async () => {
    const { base, token } = await startDaemon();
    const filed = (await rpcOk(base, token, "task_file", { content: "graph item" })) as {
      item: { id: string };
    };
    const status = (await rpcOk(base, token, "team_status")) as {
      agents: { handle: string }[];
      todo: { id: string }[];
      costTotal: number;
    };
    expect(status.todo.map((t) => t.id)).toContain(filed.item.id);
    expect(status.costTotal).toBe(0);
    const agents = (await rpcOk(base, token, "agents_list")) as { handle: string }[];
    expect(agents.length).toBeGreaterThan(0);
    const graph = (await rpcOk(base, token, "activity_graph")) as {
      nodes: { kind: string; costUsd: number }[];
      edges: unknown[];
      totalUsd: number;
      perTask: Record<string, unknown>;
    };
    expect(graph.nodes.filter((n) => n.kind === "agent")).toHaveLength(agents.length);
    expect(graph.nodes.filter((n) => n.kind === "task")).toHaveLength(status.todo.length);
    expect(graph.edges).toEqual([]);
    const sum = graph.nodes.reduce((acc, n) => acc + n.costUsd, 0);
    expect(sum).toBe(graph.totalUsd);
  });
});

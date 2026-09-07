import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore, ChoiceLog, EventBus, SessionStore } from "@agency/core";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, StreamEvent } from "@agency/providers";
import { registerSurfaceHandlers } from "../src/daemon/handlers/surface.ts";
import { installCompletionHook } from "../src/daemon/handlers/team-run.ts";
import type { DaemonContext } from "../src/daemon/types.ts";
import type { AgentDaemon } from "../src/daemon.ts";
import { createAgentDaemon } from "../src/daemon.ts";

const noopHttp: HttpClient = { fetch: async () => new Response() };
const daemons: AgentDaemon[] = [];
const dirs: string[] = [];

const prevKey = process.env.AGENCY_ANTHROPIC_API_KEY;
process.env.AGENCY_ANTHROPIC_API_KEY = "test-key-commands";
afterAll(() => {
  if (prevKey === undefined) delete process.env.AGENCY_ANTHROPIC_API_KEY;
  else process.env.AGENCY_ANTHROPIC_API_KEY = prevKey;
});

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(dir, { recursive: true });
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

const FIXTURE_PLUGIN = `import { appendFileSync } from "node:fs";
import { join } from "node:path";
export const commands = [
  { name: "shipit", description: "Fixture ship command", template: "ship $1 to $ARGUMENTS" },
];
export const hooks = {
  "cost.threshold": async (payload, ctx) => {
    appendFileSync(
      join(ctx.workspaceRoot, ".agency", "phase11-hook-markers.jsonl"),
      JSON.stringify({ hook: "cost.threshold", payload }) + "\\n",
    );
  },
};
`;

async function boot(opts: { seed?: (ws: string) => void } = {}) {
  const ws = tempDir("agency-cmd-ws-");
  opts.seed?.(ws);
  const daemon = await createAgentDaemon({
    workspaceRoot: ws,
    instanceFile: join(ws, ".agency", "instance.json"),
    sessionsDir: tempDir("agency-cmd-sess-"),
    approvalsDir: tempDir("agency-cmd-appr-"),
    adapterFor: () => echoAdapter(),
    http: noopHttp,
    tools: [],
  });
  daemons.push(daemon);
  return { ws, base: `http://127.0.0.1:${daemon.httpPort}`, token: daemon.server.token as string };
}

async function rpcCall(base: string, token: string, method: string, params: Record<string, unknown> = {}) {
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

interface CommandOut {
  kind: string;
  text: string;
  data: Record<string, unknown>;
  action?: string;
  pluginId?: string;
  source?: string;
}

async function run(base: string, token: string, name: string, args = ""): Promise<CommandOut> {
  return (await rpcOk(base, token, "command_run", { name, args })) as CommandOut;
}

async function seedSession(base: string, token: string, id: string) {
  await rpcOk(base, token, "session_create", { sessionId: id });
  const sent = (await rpcOk(base, token, "session_send", {
    sessionId: id,
    provider: "anthropic",
    model: "test-model",
    systemPrompt: "sys",
    userText: "hello",
  })) as { turnId: string };
  return sent;
}

describe("command_run Tier 1 goldens", () => {
  test("/help lists all three tiers", async () => {
    const { base, token } = await boot();
    const out = await run(base, token, "help");
    expect(out.kind).toBe("builtin");
    for (const name of ["sessions", "undo-run", "doctor"]) expect(out.text).toContain(`/${name}`);
  });

  test("/init scaffolds guidance files", async () => {
    const { base, token } = await boot();
    const out = await run(base, token, "init");
    expect(out.kind).toBe("builtin");
    expect(Array.isArray(out.data.created)).toBe(true);
  });

  test("/new then /sessions", async () => {
    const { base, token } = await boot();
    const created = await run(base, token, "new", "golden-new");
    expect(created.data.sessionId).toBe("golden-new");
    const listed = await run(base, token, "sessions");
    expect((listed.data.sessions as { id: string }[]).map((s) => s.id)).toContain("golden-new");
  });

  test("/compact runs the compaction path", async () => {
    const { base, token } = await boot();
    await seedSession(base, token, "c1");
    const out = await run(base, token, "compact", "c1");
    expect(out.data.sessionId).toBe("c1");
    expect(typeof out.data.compacted).toBe("boolean");
  });

  test("/model shows current, rejects unknown, sets known", async () => {
    const { base, token } = await boot();
    const shown = await run(base, token, "model");
    expect(typeof shown.data.current).toBe("string");
    const models = shown.data.models as { id: string }[];
    expect(Array.isArray(models)).toBe(true);
    const bad = await rpcCall(base, token, "command_run", { name: "model", args: "no-such-model-xyz" });
    expect(bad.body.error?.message).toContain("unknown model");
    const first = models[0]?.id ?? "";
    const set = await run(base, token, "model", first);
    expect(set.data).toMatchObject({ key: "model", value: first });
  });

  test("/undo and /redo report a boolean", async () => {
    const { base, token } = await boot();
    expect(typeof (await run(base, token, "undo")).data.undone).toBe("boolean");
    expect(typeof (await run(base, token, "redo")).data.undone).toBe("boolean");
  });

  test("/exit returns the client action", async () => {
    const { base, token } = await boot();
    const out = await run(base, token, "exit");
    expect(out).toMatchObject({ kind: "builtin", action: "exit" });
  });

  test("unknown commands fail naming the command", async () => {
    const { base, token } = await boot();
    const { body } = await rpcCall(base, token, "command_run", { name: "nope", args: "" });
    expect(body.error?.message).toBe("unknown command: nope");
  });
});

describe("command_run Tier 2 goldens", () => {
  test("/agents and /team", async () => {
    const { base, token } = await boot();
    const agents = await run(base, token, "agents");
    expect(typeof agents.text).toBe("string");
    const team = await run(base, token, "team");
    expect(Array.isArray(team.data.agents)).toBe(true);
    expect(Array.isArray(team.data.todo)).toBe(true);
  });

  test("/todos reads persisted todos", async () => {
    const { base, token } = await boot();
    await rpcOk(base, token, "session_create", { sessionId: "t1" });
    await rpcOk(base, token, "todo_write", {
      sessionId: "t1",
      todos: [{ id: "a", content: "do it", status: "pending" }],
    });
    const out = await run(base, token, "todos", "t1");
    expect(out.data.todos).toHaveLength(1);
  });

  test("/status projects the session", async () => {
    const { base, token } = await boot();
    await seedSession(base, token, "s1");
    const out = await run(base, token, "status", "s1");
    expect(typeof out.data.tipId).toBe("string");
    expect((out.data.messages as unknown[]).length).toBeGreaterThan(0);
  });

  test("/stop idles the team", async () => {
    const { base, token } = await boot();
    const out = await run(base, token, "stop");
    expect(out.data.stopped).toBe(true);
  });

  test("/cost sums the run", async () => {
    const { base, token } = await boot();
    await seedSession(base, token, "cash");
    const out = await run(base, token, "cost", "cash");
    expect(typeof out.data.runTotalUsd).toBe("number");
    expect((out.data.total as { turns: number }).turns).toBeGreaterThan(0);
  });

  test("/plan approves a plan file", async () => {
    const { base, token, ws } = await boot();
    writeFileSync(join(ws, "plan.md"), "# Plan\n");
    const out = await run(base, token, "plan", "plan.md");
    expect(out.text).toContain("plan.md");
    expect(out.data.record).toBeDefined();
  });

  test("/approve answers a missing ask as unresolved", async () => {
    const { base, token } = await boot();
    const out = await run(base, token, "approve", "missing once");
    expect(out.data.resolved).toBe(false);
  });

  test("/inspect timeline and reasoning succeed, missing step fails typed", async () => {
    const { base, token } = await boot();
    const timeline = await run(base, token, "inspect", "coder");
    expect(timeline.data.granularity).toBe("timeline");
    const reasoning = await run(base, token, "inspect", "coder reasoning");
    expect(reasoning.data.granularity).toBe("reasoning");
    const bad = await rpcCall(base, token, "command_run", { name: "inspect", args: "coder 7" });
    expect(bad.body.error?.message).toContain("no step 7");
  });

  test("/graph, /decisions, /owners", async () => {
    const { base, token } = await boot();
    const graph = await run(base, token, "graph");
    const nodes = graph.data.nodes as { kind: string }[];
    expect(nodes.filter((n) => n.kind === "agent")).toBeDefined();
    expect(graph.text).toContain("task(s)");
    const decisions = await run(base, token, "decisions");
    expect(Array.isArray(decisions.data.decisions)).toBe(true);
    const owners = await run(base, token, "owners", "src/app.ts");
    expect(Array.isArray(owners.data.handles)).toBe(true);
  });

  test("/undo-run rolls back a turn", async () => {
    const { base, token } = await boot();
    await seedSession(base, token, "u1");
    const out = await run(base, token, "undo-run", "u1");
    expect(out.data.undone).toBe(true);
    const empty = await run(base, token, "undo-run", "never-created");
    expect(empty.data.undone).toBe(false);
  });
});

describe("command_run Tier 3 goldens", () => {
  test("/trace loads spans", async () => {
    const { base, token } = await boot();
    await seedSession(base, token, "tr1");
    const out = await run(base, token, "trace", "tr1");
    expect(Array.isArray(out.data.spans)).toBe(true);
  });

  test("/replay re-runs a recorded turn", async () => {
    const { base, token } = await boot();
    const sent = await seedSession(base, token, "rp1");
    const out = await run(base, token, "replay", `rp1 ${sent.turnId}`);
    expect(typeof out.data.equal).toBe("boolean");
    expect(out.data.original).toBeDefined();
  });

  test("/diff reports git state", async () => {
    const { base, token, ws } = await boot();
    execSync("git init", { cwd: ws, stdio: "ignore" });
    writeFileSync(join(ws, "note.txt"), "hi");
    const out = await run(base, token, "diff");
    expect(out.text).toContain("note.txt");
  });

  test("/export returns raw entries", async () => {
    const { base, token } = await boot();
    await seedSession(base, token, "ex1");
    const out = await run(base, token, "export", "ex1");
    expect((out.data.entries as unknown[]).length).toBeGreaterThan(0);
  });

  test("/mcp, /lsp, /permissions", async () => {
    const { base, token } = await boot();
    expect(typeof (await run(base, token, "mcp")).data.failures).toBe("object");
    expect(typeof (await run(base, token, "lsp")).data.statuses).toBe("object");
    const perms = await run(base, token, "permissions");
    expect(perms.data.permissions).toBeDefined();
    expect(perms.data.capabilities).toBeDefined();
  });

  test("/trust reports workspace trust", async () => {
    const { base, token, ws } = await boot();
    const out = await run(base, token, "trust");
    expect(out.data).toMatchObject({ trusted: false, path: ws });
  });

  test("/debug resolves the prompt", async () => {
    const { base, token } = await boot();
    const out = await run(base, token, "debug");
    expect((out.data.prompt as { prompt: string }).prompt.length).toBeGreaterThan(0);
  });

  test("/doctor runs the check composite", async () => {
    const { base, token } = await boot();
    const out = await run(base, token, "doctor");
    expect((out.data.checks as { name: string }[]).map((c) => c.name)).toEqual([
      "providers",
      "models",
      "trust",
      "sessions",
    ]);
  });

  test("/goal returns the team report goal", async () => {
    const { base, token } = await boot();
    const out = await run(base, token, "goal");
    expect(typeof out.data.goal).toBe("string");
  });
});

describe("file templates resolve through command_run", () => {
  test("frontmatter plus $1 plus shell plus @file", async () => {
    const { base, token } = await boot({
      seed: (ws) => {
        mkdirSync(join(ws, ".agency", "commands"), { recursive: true });
        writeFileSync(join(ws, ".agency", "commands", "deploy.md"), "deploy $1 to @target.txt");
        writeFileSync(join(ws, "target.txt"), "prod-cluster");
      },
    });
    const listed = (await rpcOk(base, token, "commands_list")) as { commands: { name: string }[] };
    expect(listed.commands.map((c) => c.name)).toContain("deploy");
    const out = await run(base, token, "deploy", "svc");
    expect(out.kind).toBe("template");
    expect(out.text).toBe("deploy svc to prod-cluster");
  });
});

describe("fixture plugin command plus hook", () => {
  test("plugin command resolves and cost.threshold fires the hook", async () => {
    const { base, token, ws } = await boot({
      seed: (w) => {
        mkdirSync(join(w, ".agency", "plugins"), { recursive: true });
        writeFileSync(join(w, ".agency", "plugins", "fixture.mjs"), FIXTURE_PLUGIN);
      },
    });
    const shipped = await run(base, token, "shipit", "svc extra");
    expect(shipped.kind).toBe("plugin");
    expect(shipped.pluginId).toBe("fixture");
    expect(shipped.text).toBe("ship svc to svc extra");
    await rpcOk(base, token, "session_create", { sessionId: "capped", budget: { maxCostUsd: 0.001 } });
    let caught: unknown;
    try {
      await rpcOk(base, token, "session_send", {
        sessionId: "capped",
        provider: "anthropic",
        model: "claude-sonnet-5",
        systemPrompt: "sys",
        userText: "hi",
      });
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).toContain("session budget exceeded");
    const marker = join(ws, ".agency", "phase11-hook-markers.jsonl");
    expect(existsSync(marker)).toBe(true);
    const lines = readFileSync(marker, "utf8").trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);
    expect((JSON.parse(lines[0] ?? "{}") as { hook: string }).hook).toBe("cost.threshold");
  });
});

describe("new hook firing sites", () => {
  test("board.item.complete fires when an item completes", () => {
    const bus = new EventBus();
    const seen: unknown[] = [];
    bus.on("board.item.complete", (payload) => {
      seen.push(payload);
    });
    const boardStore = new BoardStore();
    const fake = {
      boardStore,
      teamContexts: new Map(),
      teamRegistry: { list: () => [] },
      choiceLog: new ChoiceLog(),
      eventBus: bus,
      broadcast: () => {},
    } as unknown as DaemonContext;
    installCompletionHook(fake);
    const filed = boardStore.file({ content: "ship it" }, "lead", { pathScope: "*", tools: "*" });
    expect(filed.ok).toBe(true);
    if (!filed.ok) return;
    const done = boardStore.setStatus("peer", filed.item.id, "completed");
    expect(done.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ itemId: filed.item.id, status: "completed" });
  });

  test("pre.merge fires before a team-scope undo_run restore", async () => {
    const bus = new EventBus();
    const seen: unknown[] = [];
    bus.on("pre.merge", (payload) => {
      seen.push(payload);
    });
    const sessionsDir = tempDir("agency-cmd-merge-");
    const fake = {
      config: {},
      defaultCapabilitiesForSession: async () => ({ tools: "*", pathScopes: "*", network: "*" }),
      listModels: () => [],
      sessionScopes: new Map(),
      teamCheckpoints: new Map([["m1", { files: {}, at: new Date().toISOString() }]]),
      teamMcpPools: new Map(),
      todoSessionsDir: sessionsDir,
      todoStore: new SessionStore(sessionsDir),
      turnCheckpoints: new Map(),
      eventBus: bus,
    } as unknown as DaemonContext;
    const handlers: Record<string, (params: unknown, ctx: { clientId: string }) => Promise<unknown>> = {};
    registerSurfaceHandlers(handlers as never, fake);
    const out = (await handlers.undo_run?.({ sessionId: "m1" }, { clientId: "t" })) as { undone: boolean };
    expect(out.undone).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ sessionId: "m1" });
  });
});

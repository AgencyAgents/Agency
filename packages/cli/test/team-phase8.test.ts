import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpClient } from "@agency/net";
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
  const dir = mkdtempSync(join(tmpdir(), "agency-p8-"));
  dirs.push(dir);
  return join(dir, "instance.json");
}
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "agency-p8-root-"));
  dirs.push(dir);
  return dir;
}
function writeConfigDir(config: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "agency-p8-cfg-"));
  dirs.push(dir);
  writeFileSync(join(dir, "config.jsonc"), JSON.stringify({ schemaVersion: 2, ...config }));
  return dir;
}

const rosterCfg = {
  agents: {
    leader: { role: "leader", provider: "anthropic", model: "claude", effort: "high", enabled: true },
    coder: { role: "coder", provider: "anthropic", model: "claude", effort: "high", enabled: true },
    reviewer: { role: "reviewer", provider: "openai", model: "gpt", effort: "medium", enabled: true },
  },
};

async function boot(
  root?: string,
): Promise<{ daemon: AgentDaemon; client: DaemonClient; workspaceRoot: string }> {
  const workspaceRoot = root ?? tempRoot();
  const daemon = await createAgentDaemon({
    workspaceRoot,
    instanceFile: tempInstanceFile(),
    http: noopHttp,
    configDir: writeConfigDir(rosterCfg),
  });
  daemons.push(daemon);
  const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
  clients.push(client);
  return { daemon, client, workspaceRoot };
}

async function approveNextTeamOpen(
  client: DaemonClient,
  decision: "once" | "reject" = "once",
): Promise<void> {
  const events: Array<{ type: string; requestId?: string }> = [];
  client.on("team.shared" as never, (p) => events.push(p as { type: string }));
  client.subscribe("team.shared");
  for (let waited = 0; waited < 100; waited++) {
    const ask = events.find((e) => e.type === "approval_requested");
    if (ask?.requestId) {
      await client.call("approval_respond", { requestId: ask.requestId, decision });
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("team_open approval never arrived");
}

const fourDisjoint = [
  { content: "auth slice", pathScope: ["src/auth/**"] },
  { content: "db slice", pathScope: ["src/db/**"] },
  { content: "api slice", pathScope: ["src/api/**"] },
  { content: "ui slice", pathScope: ["src/ui/**"] },
];

describe("phase 8 team open plus agent stop", () => {
  it("a two-item plan stays solo with no approval", async () => {
    const { client } = await boot();
    const result = (await client.call("team_open", {
      sessionId: "solo-plan",
      goal: "small fix",
      items: [
        { content: "one", pathScope: ["src/a.ts"] },
        { content: "two", pathScope: ["src/b.ts"] },
      ],
    })) as { opened: boolean; reason: string };
    expect(result.opened).toBe(false);
    expect(result.reason).toContain("solo");
  });

  it("a four-item disjoint plan opens a team behind an approval", async () => {
    const { client } = await boot();
    const pending = client.call("team_open", { sessionId: "big-plan", goal: "ship it", items: fourDisjoint });
    await approveNextTeamOpen(client, "once");
    const result = (await pending) as {
      opened: boolean;
      teamId: string;
      announcement: string;
      itemIds: string[];
    };
    expect(result.opened).toBe(true);
    expect(result.itemIds).toHaveLength(4);
    expect(result.announcement.split("\n")).toHaveLength(1);
    expect(result.announcement).toContain("team open:");
    const status = (await client.call("team_status", { sessionId: "big-plan" })) as { todo: unknown[] };
    expect(status.todo).toHaveLength(4);
  });

  it("a rejected team open files nothing", async () => {
    const { client } = await boot();
    const pending = client.call("team_open", { sessionId: "no-plan", goal: "ship it", items: fourDisjoint });
    await approveNextTeamOpen(client, "reject");
    const result = (await pending) as { opened: boolean };
    expect(result.opened).toBe(false);
    const status = (await client.call("team_status", { sessionId: "no-plan" })) as { todo: unknown[] };
    expect(status.todo).toHaveLength(0);
  });

  it("agent_stop idles one handle and reports no team when absent", async () => {
    const { client } = await boot();
    const missing = (await client.call("agent_stop", { sessionId: "ghost", handle: "coder" })) as {
      stopped: boolean;
    };
    expect(missing.stopped).toBe(false);
    const pending = client.call("team_open", {
      sessionId: "stop-plan",
      goal: "ship it",
      items: fourDisjoint,
    });
    await approveNextTeamOpen(client, "once");
    await pending;
    const stopped = (await client.call("agent_stop", { sessionId: "stop-plan", handle: "coder" })) as {
      stopped: boolean;
      handle: string;
    };
    expect(stopped.stopped).toBe(true);
    expect(stopped.handle).toBe("coder");
  });

  it("undo_run restores the workspace from the team checkpoint", async () => {
    const root = tempRoot();
    const target = join(root, "ship.ts");
    writeFileSync(target, "original\n");
    const { client } = await boot(root);
    const pending = client.call("team_open", {
      sessionId: "undo-plan",
      goal: "ship it",
      items: [{ content: "ship slice", pathScope: ["*.ts"] }],
      explicitRequest: true,
    });
    await approveNextTeamOpen(client, "once");
    const opened = (await pending) as { opened: boolean };
    expect(opened.opened).toBe(true);
    writeFileSync(target, "merged work\n");
    const undone = (await client.call("undo_run", { sessionId: "undo-plan" })) as {
      undone: boolean;
      scope: string;
      restored: number;
    };
    expect(undone.undone).toBe(true);
    expect(undone.scope).toBe("team");
    expect(undone.restored).toBe(1);
    expect(readFileSync(target, "utf8")).toBe("original\n");
  });

  it("cost_report surfaces the team MCP process cap", async () => {
    const { client } = await boot();
    const cost = (await client.call("cost_report", { sessionId: "never-sent" })) as {
      mcp: { sharedServers: number; perAgentScopes: number; cap: number };
    };
    expect(cost.mcp.cap).toBeGreaterThan(0);
    expect(cost.mcp.sharedServers).toBe(0);
  });
});

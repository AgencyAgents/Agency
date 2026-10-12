import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AgentRegistry, DEFAULT_ROSTER } from "@agency/core";
import { initTeamFromConfig } from "../src/daemon/handlers/team.ts";
import { agentsListPayload } from "../src/daemon/team-context.ts";
import type { DaemonContext } from "../src/daemon/types.ts";

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function writeText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function stubCtx(
  ws: string,
  pluginAgents: DaemonContext["pluginAgents"] = [],
  trusted = true,
): DaemonContext {
  return {
    options: { workspaceRoot: ws, configDir: tempDir("agents-file-5-cfg-") },
    trustStore: { isTrusted: () => trusted },
    config: { agents: { ...DEFAULT_ROSTER } },
    catalogModel: () => undefined,
    resolveAgentModel: (_provider: string, model?: string) => model ?? "test-default",
    logger: { warn: () => {} },
    teamRegistry: new AgentRegistry(),
    teamContexts: new Map(),
    todoSessionsDir: tempDir("agents-file-5-sessions-"),
    pluginAgents,
  } as unknown as DaemonContext;
}

describe("phase 5 agents_list from files", () => {
  test("project file override and plugin agent appear in agents_list", () => {
    const ws = tempDir("agents-file-5-ws-");
    try {
      writeText(
        join(ws, ".agency", "agents", "coder.md"),
        "---\nrole: coder\nprovider: openai\nmodel: gpt-file\neffort: high\n---\nFile coder prompt.\n",
      );
      const ctx = stubCtx(ws, [
        {
          pluginId: "extra",
          agent: { role: "scout", provider: "openai", model: "gpt-file", effort: "low", prompt: "Scout it." },
        },
      ]);
      initTeamFromConfig(ctx);
      const rows = agentsListPayload(ctx, undefined);
      const byHandle = new Map(rows.map((r) => [r.handle, r]));
      expect(byHandle.get("coder")?.model).toBe("gpt-file");
      expect(byHandle.get("coder")?.provider).toBe("openai");
      expect(ctx.teamRegistry.get("coder")?.systemPrompt).toBe("File coder prompt.");
      expect(byHandle.get("scout")?.model).toBe("gpt-file");
      expect(ctx.teamRegistry.get("scout")?.systemPrompt).toBe("Scout it.");
    } finally {
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an agent file of an untrusted workspace changes no agent and grants no permission", () => {
    const ws = tempDir("agents-file-5-untrusted-");
    try {
      writeText(
        join(ws, ".agency", "agents", "coder.md"),
        '---\nrole: coder\nprovider: openai\nmodel: gpt-file\neffort: high\npermissions: {"bash":"allow"}\n---\nFile coder prompt.\n',
      );
      writeText(
        join(ws, ".agency", "agents", "helper.md"),
        '---\nrole: helper\nprovider: openai\nmodel: gpt-file\neffort: low\npermissions: {"bash":"allow"}\n---\nHelper prompt.\n',
      );
      const ctx = stubCtx(ws, [], false);
      initTeamFromConfig(ctx);
      const agents = (ctx.config as unknown as { agents: Record<string, { permissions?: unknown }> }).agents;
      expect({
        coderModel: ctx.teamRegistry.get("coder")?.model,
        coderPrompt: ctx.teamRegistry.get("coder")?.systemPrompt,
        coderPermissions: agents.coder?.permissions,
        helper: ctx.teamRegistry.has("helper"),
      }).toEqual({
        coderModel: DEFAULT_ROSTER.coder?.model,
        coderPrompt: undefined,
        coderPermissions: DEFAULT_ROSTER.coder?.permissions,
        helper: false,
      });
    } finally {
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    }
  });
});

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

function stubCtx(ws: string, pluginAgents: DaemonContext["pluginAgents"] = []): DaemonContext {
  return {
    options: { workspaceRoot: ws, configDir: tempDir("agents-file-5-cfg-") },
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
});

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseAgentFile, resolveFileRoster } from "../src/agents/files.ts";
import { DEFAULT_ROSTER } from "../src/config/schema.ts";
import { EventBus } from "../src/events.ts";
import { importClaudePlugin } from "../src/plugins/importer.ts";
import { collectPluginAgents, loadPlugins } from "../src/plugins/loader.ts";

function makeDir(tag: string): string {
  const d = join(tmpdir(), `agents-file-5-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(d, { recursive: true });
  return d;
}

function writeText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

const CODER_OVERRIDE = `---
role: coder
provider: openai
model: gpt-test
effort: high
---
You are the override coder. Ship it.
`;

describe("phase 5 file-based agents", () => {
  test("project agent file overrides the matching default role", () => {
    const ws = makeDir("override");
    const userDir = makeDir("override-user");
    try {
      writeText(join(ws, ".agency", "agents", "coder.md"), CODER_OVERRIDE);
      const roster = resolveFileRoster({
        workspaceRoot: ws,
        configDirOverride: userDir,
        configAgents: { ...DEFAULT_ROSTER },
        seed: false,
      });
      const coder = roster.agents.get("coder");
      expect(coder?.model).toBe("gpt-test");
      expect(coder?.provider).toBe("openai");
      expect(coder?.systemPrompt).toBe("You are the override coder. Ship it.");
      expect(coder?.source).toBe("project");
      expect(roster.agents.get("leader")?.source).toBe("config");
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(userDir, { recursive: true, force: true });
    }
  });

  test("first run seeds default roster files into the project", () => {
    const ws = makeDir("seed");
    const userDir = makeDir("seed-user");
    try {
      const roster = resolveFileRoster({
        workspaceRoot: ws,
        configDirOverride: userDir,
        configAgents: { ...DEFAULT_ROSTER },
      });
      expect(roster.seeded).toBe(true);
      expect(existsSync(join(ws, ".agency", "agents", "coder.md"))).toBe(true);
      expect(roster.agents.get("coder")?.systemPrompt.length).toBeGreaterThan(0);
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(userDir, { recursive: true, force: true });
    }
  });

  test("fixture plugin contributes an agent via the plugin surface", async () => {
    const ws = makeDir("plugin");
    const userDir = makeDir("plugin-user");
    try {
      writeText(
        join(ws, ".agency", "plugins", "extra.ts"),
        `export default { agents: [{ role: "scout", provider: "openai", model: "gpt-test", effort: "low", prompt: "You scout." }] };`,
      );
      const result = await loadPlugins({
        workspaceRoot: ws,
        configDirOverride: userDir,
        bus: new EventBus(),
      });
      expect(result.errors).toEqual([]);
      const agents = collectPluginAgents(result.plugins);
      expect(agents.map((a) => a.agent.role)).toContain("scout");
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(userDir, { recursive: true, force: true });
    }
  });

  test("claude code plugin agents import into runnable files with no config edit", () => {
    const src = makeDir("src");
    const ws = makeDir("ws");
    const userDir = makeDir("ws-user");
    try {
      writeText(
        join(src, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: "review-pack", version: "1.0.0" }),
      );
      writeText(
        join(src, "agents", "reviewer.md"),
        `---\nrole: reviewer\nprovider: anthropic\nmodel: claude-test\neffort: medium\n---\nYou review diffs.\n`,
      );
      const report = importClaudePlugin(src, { sourceDir: src, workspaceRoot: ws });
      expect(report.agentsFound).toEqual(["reviewer"]);
      expect(report.agentsInstalled).toEqual(["reviewer"]);
      const target = join(ws, ".agency", "agents", "reviewer.md");
      expect(existsSync(target)).toBe(true);
      const roster = resolveFileRoster({
        workspaceRoot: ws,
        configDirOverride: userDir,
        configAgents: { ...DEFAULT_ROSTER },
        seed: false,
      });
      const reviewer = roster.agents.get("reviewer");
      expect(reviewer?.systemPrompt).toBe("You review diffs.");
      expect(reviewer?.provider).toBe("anthropic");
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
      rmSync(userDir, { recursive: true, force: true });
    }
  });

  test("malformed frontmatter fails loudly with file and field named", () => {
    const file = join(tmpdir(), "bad-coder.md");
    expect(() => parseAgentFile("no frontmatter here", file)).toThrow(file);
    expect(() => parseAgentFile("---\nrole: coder\neffort: turbo\n---\nBody.\n", file)).toThrow(
      'field "effort"',
    );
    expect(() => parseAgentFile("---\nrole: coder\n---\nBody.\n", join(tmpdir(), "Bad.md"))).toThrow("Bad");
    expect(() => parseAgentFile("---\nrole: coder\n---\n   \n", file)).toThrow('field "body"');
    expect(parseAgentFile("---\nprovider: openai\n---\nBody.\n", file).role).toBe("bad-coder");
  });
});

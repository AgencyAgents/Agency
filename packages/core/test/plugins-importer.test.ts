import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImportClaudePluginReport } from "../src/plugins/importer.ts";
import { importClaudePlugin } from "../src/plugins/importer.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDir(tag: string): string {
  const d = join(tmpdir(), `plugin-importer-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  return d;
}

function writeJson(path: string, data: unknown): void {
  const dir = path.slice(0, path.lastIndexOf("\\"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
}

function writeText(path: string, content: string): void {
  const dir = path.slice(0, path.lastIndexOf("\\"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, content, "utf8");
}

// ---------------------------------------------------------------------------
// Fixture: ponytail-shape (separate hooks/hooks.json)
// ---------------------------------------------------------------------------

function makePonytailFixture(sourceDir: string): void {
  // .claude-plugin/plugin.json
  writeJson(join(sourceDir, ".claude-plugin", "plugin.json"), {
    name: "ponytail",
    version: "4.9.0",
    description: "Lazy senior dev mode",
    author: { name: "Dietrich Gebert" },
  });

  // hooks/hooks.json (separate file)
  writeJson(join(sourceDir, "hooks", "hooks.json"), {
    hooks: {
      SessionStart: [
        {
          hooks: [{ type: "command", command: "node hooks/activate.js", timeout: 5 }],
        },
      ],
      SubagentStart: [
        {
          hooks: [{ type: "command", command: "node hooks/subagent.js", timeout: 5 }],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [{ type: "command", command: "node hooks/tracker.js", timeout: 5 }],
        },
      ],
    },
  });

  // skills/ponytail/SKILL.md
  writeText(
    join(sourceDir, "skills", "ponytail", "SKILL.md"),
    "---\nname: ponytail\ndescription: Lazy senior dev mode\n---\n# Ponytail Skill\n\nForce simplest solution.",
  );

  // commands/ponytail.md
  writeText(
    join(sourceDir, "commands", "ponytail.md"),
    "# /ponytail\n\nActivate ponytail mode.\n\nUsage: `/ponytail lite|full|ultra`",
  );

  // agents/reviewer.md
  writeText(
    join(sourceDir, "agents", "reviewer.md"),
    "# Reviewer Agent\n\nReviews code for over-engineering.",
  );

  // .mcp.json
  writeJson(join(sourceDir, ".mcp.json"), {
    filesystem: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
    },
  });
}

// ---------------------------------------------------------------------------
// Fixture: caveman-shape (inline hooks in plugin.json)
// ---------------------------------------------------------------------------

function makeCavemanFixture(sourceDir: string): void {
  // .claude-plugin/plugin.json with inline hooks
  writeJson(join(sourceDir, ".claude-plugin", "plugin.json"), {
    name: "caveman",
    description: "Ultra-compressed communication mode",
    hooks: {
      SessionStart: [
        {
          hooks: [{ type: "command", command: "node caveman-activate.js", timeout: 30 }],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [{ type: "command", command: "node caveman-tracker.js", timeout: 30 }],
        },
      ],
    },
  });

  // skills/caveman/SKILL.md
  writeText(
    join(sourceDir, "skills", "caveman", "SKILL.md"),
    "---\nname: caveman\ndescription: Caveman mode\n---\n# Caveman Skill\n\nTalk like caveman.",
  );
}

// ---------------------------------------------------------------------------
// Fixture: .codex-plugin format
// ---------------------------------------------------------------------------

function makeCodexFixture(sourceDir: string): void {
  // .codex-plugin/plugin.json (NOT .claude-plugin/)
  writeJson(join(sourceDir, ".codex-plugin", "plugin.json"), {
    name: "codex-security",
    version: "0.1.22",
    description: "Security scanning plugin",
    author: { name: "OpenAI" },
    skills: "./skills/",
    mcpServers: "./.mcp.json",
  });

  // skills/security-scan/SKILL.md
  writeText(
    join(sourceDir, "skills", "security-scan", "SKILL.md"),
    "---\nname: security-scan\ndescription: Security audit\n---\n# Security Scan\n\nRun security audit.",
  );

  // .mcp.json
  writeJson(join(sourceDir, ".mcp.json"), {
    scanner: {
      command: "python",
      args: ["-m", "security_scanner"],
    },
  });
}

// ---------------------------------------------------------------------------
// Fixture: unknown hooks
// ---------------------------------------------------------------------------

function makeUnknownHooksFixture(sourceDir: string): void {
  writeJson(join(sourceDir, ".claude-plugin", "plugin.json"), {
    name: "unknown-hooks",
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }],
      UnknownEvent: [{ hooks: [{ type: "command", command: "echo unknown" }] }],
      PreToolUse: [{ hooks: [{ type: "command", command: "echo pretool" }] }],
      SubagentStart: [{ hooks: [{ type: "command", command: "echo sub" }] }],
    },
  });
}

// ---------------------------------------------------------------------------
// Fixture: malformed plugin.json
// ---------------------------------------------------------------------------

function makeMalformedManifestFixture(sourceDir: string): void {
  mkdirSync(join(sourceDir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(sourceDir, ".claude-plugin", "plugin.json"), "not valid json", "utf8");
}

// ---------------------------------------------------------------------------
// Fixture: missing name in plugin.json
// ---------------------------------------------------------------------------

function makeMissingNameFixture(sourceDir: string): void {
  writeJson(join(sourceDir, ".claude-plugin", "plugin.json"), {
    version: "1.0.0",
    description: "No name field",
  });
}

// ---------------------------------------------------------------------------
// Fixture: .mcp.json with invalid entries
// ---------------------------------------------------------------------------

function makeInvalidMcpFixture(sourceDir: string): void {
  writeJson(join(sourceDir, ".claude-plugin", "plugin.json"), {
    name: "bad-mcp",
  });

  writeJson(join(sourceDir, ".mcp.json"), {
    valid_server: {
      command: "node",
      args: ["server.js"],
    },
    invalid_server: {
      command: 123, // should be string
      args: "not-an-array", // should be array
    },
    empty_server: {},
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("importClaudePlugin", () => {
  // -----------------------------------------------------------------------
  // ponytail-shape (separate hooks.json)
  // -----------------------------------------------------------------------

  test("ponytail-shape: imports plugin with separate hooks.json", () => {
    const src = makeDir("ponytail");
    const ws = makeDir("ws-ponytail");
    try {
      makePonytailFixture(src);

      const report = importClaudePlugin(src, { sourceDir: src, workspaceRoot: ws });

      expect(report.pluginName).toBe("ponytail");
      expect(report.pluginVersion).toBe("4.9.0");
      expect(report.pluginDescription).toBe("Lazy senior dev mode");

      // Skills
      expect(report.skillsInstalled).toEqual(["ponytail"]);
      expect(existsSync(join(ws, ".agency", "skills", "ponytail", "SKILL.md"))).toBe(true);

      // Hooks
      expect(report.hooksMapped).toHaveLength(3);
      expect(report.hooksMapped).toContainEqual({ claudeEvent: "SessionStart", agencyHook: "session.start" });
      expect(report.hooksMapped).toContainEqual({
        claudeEvent: "SubagentStart",
        agencyHook: "subagent.start",
      });
      expect(report.hooksMapped).toContainEqual({
        claudeEvent: "UserPromptSubmit",
        agencyHook: "prompt.submit",
      });
      expect(report.hooksSkipped).toEqual([]);

      // MCP
      expect(report.mcpServers).toHaveProperty("filesystem");
      expect(report.mcpServers.filesystem).toHaveProperty("command", "npx");

      // Agents
      expect(report.agentsFound).toEqual(["reviewer"]);

      // Commands
      expect(report.commandsInstalled).toEqual(["ponytail.md"]);
      expect(existsSync(join(ws, ".agency", "commands", "ponytail.md"))).toBe(true);
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // -----------------------------------------------------------------------
  // caveman-shape (inline hooks in plugin.json)
  // -----------------------------------------------------------------------

  test("caveman-shape: imports plugin with inline hooks", () => {
    const src = makeDir("caveman");
    const ws = makeDir("ws-caveman");
    try {
      makeCavemanFixture(src);

      const report = importClaudePlugin(src, { sourceDir: src, workspaceRoot: ws });

      expect(report.pluginName).toBe("caveman");
      expect(report.pluginVersion).toBeUndefined();
      expect(report.pluginDescription).toBe("Ultra-compressed communication mode");

      // Skills
      expect(report.skillsInstalled).toEqual(["caveman"]);
      expect(existsSync(join(ws, ".agency", "skills", "caveman", "SKILL.md"))).toBe(true);

      // Hooks (inline)
      expect(report.hooksMapped).toHaveLength(2);
      expect(report.hooksMapped).toContainEqual({ claudeEvent: "SessionStart", agencyHook: "session.start" });
      expect(report.hooksMapped).toContainEqual({
        claudeEvent: "UserPromptSubmit",
        agencyHook: "prompt.submit",
      });
      expect(report.hooksSkipped).toEqual([]);

      // No MCP, no agents, no commands
      expect(report.mcpServers).toEqual({});
      expect(report.agentsFound).toEqual([]);
      expect(report.commandsInstalled).toEqual([]);
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // -----------------------------------------------------------------------
  // .codex-plugin format
  // -----------------------------------------------------------------------

  test("codex-plugin: imports from .codex-plugin/ directory", () => {
    const src = makeDir("codex");
    const ws = makeDir("ws-codex");
    try {
      makeCodexFixture(src);

      const report = importClaudePlugin(src, { sourceDir: src, workspaceRoot: ws });

      expect(report.pluginName).toBe("codex-security");
      expect(report.pluginVersion).toBe("0.1.22");
      expect(report.pluginDescription).toBe("Security scanning plugin");

      // Skills
      expect(report.skillsInstalled).toEqual(["security-scan"]);
      expect(existsSync(join(ws, ".agency", "skills", "security-scan", "SKILL.md"))).toBe(true);

      // MCP
      expect(report.mcpServers).toHaveProperty("scanner");
      expect(report.mcpServers.scanner).toHaveProperty("command", "python");

      // No hooks, no agents, no commands
      expect(report.hooksMapped).toEqual([]);
      expect(report.hooksSkipped).toEqual([]);
      expect(report.agentsFound).toEqual([]);
      expect(report.commandsInstalled).toEqual([]);
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // -----------------------------------------------------------------------
  // Unknown hook skip
  // -----------------------------------------------------------------------

  test("unknown hooks are warn-and-skipped", () => {
    const src = makeDir("unknown-hooks");
    const ws = makeDir("ws-unknown");
    try {
      makeUnknownHooksFixture(src);

      const report = importClaudePlugin(src, { sourceDir: src, workspaceRoot: ws });

      // Known hooks mapped
      expect(report.hooksMapped).toHaveLength(2);
      expect(report.hooksMapped).toContainEqual({ claudeEvent: "SessionStart", agencyHook: "session.start" });
      expect(report.hooksMapped).toContainEqual({
        claudeEvent: "SubagentStart",
        agencyHook: "subagent.start",
      });

      // Unknown hooks skipped
      expect(report.hooksSkipped).toHaveLength(2);
      expect(report.hooksSkipped).toContainEqual({
        event: "UnknownEvent",
        reason: 'unknown event "UnknownEvent"',
      });
      expect(report.hooksSkipped).toContainEqual({
        event: "PreToolUse",
        reason: 'unknown event "PreToolUse"',
      });
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // -----------------------------------------------------------------------
  // Malformed plugin.json error
  // -----------------------------------------------------------------------

  test("malformed plugin.json throws", () => {
    const src = makeDir("malformed");
    const ws = makeDir("ws-malformed");
    try {
      makeMalformedManifestFixture(src);

      expect(() => {
        importClaudePlugin(src, { sourceDir: src, workspaceRoot: ws });
      }).toThrow(/No valid plugin manifest/);
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("missing name in plugin.json throws", () => {
    const src = makeDir("missing-name");
    const ws = makeDir("ws-missing-name");
    try {
      makeMissingNameFixture(src);

      expect(() => {
        importClaudePlugin(src, { sourceDir: src, workspaceRoot: ws });
      }).toThrow(/No valid plugin manifest/);
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // -----------------------------------------------------------------------
  // .mcp.json validation
  // -----------------------------------------------------------------------

  test(".mcp.json validation rejects invalid entries", () => {
    const src = makeDir("bad-mcp");
    const ws = makeDir("ws-bad-mcp");
    try {
      makeInvalidMcpFixture(src);

      const report = importClaudePlugin(src, { sourceDir: src, workspaceRoot: ws });

      // Valid server passes
      expect(report.mcpServers).toHaveProperty("valid_server");
      expect(report.mcpServers.valid_server).toHaveProperty("command", "node");

      // Invalid server is rejected
      expect(report.mcpServers).not.toHaveProperty("invalid_server");

      // Empty server (all optional fields) passes
      expect(report.mcpServers).toHaveProperty("empty_server");
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // -----------------------------------------------------------------------
  // Overwrite behavior
  // -----------------------------------------------------------------------

  test("overwrite: false skips existing skills and commands with warning", () => {
    const src = makeDir("overwrite-skip");
    const ws = makeDir("ws-overwrite-skip");
    try {
      // Pre-create a skill and command
      writeText(join(ws, ".agency", "skills", "ponytail", "SKILL.md"), "# Existing skill");
      writeText(join(ws, ".agency", "commands", "ponytail.md"), "# Existing command");

      makePonytailFixture(src);

      const report = importClaudePlugin(src, { sourceDir: src, workspaceRoot: ws, overwrite: false });

      // Skills and commands should be skipped (not overwritten)
      expect(report.skillsInstalled).toEqual([]);
      expect(report.commandsInstalled).toEqual([]);

      // Existing files should remain unchanged
      const skillContent = require("node:fs").readFileSync(
        join(ws, ".agency", "skills", "ponytail", "SKILL.md"),
        "utf8",
      );
      expect(skillContent).toBe("# Existing skill");
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("overwrite: true replaces existing skills and commands", () => {
    const src = makeDir("overwrite-replace");
    const ws = makeDir("ws-overwrite-replace");
    try {
      // Pre-create a skill
      writeText(join(ws, ".agency", "skills", "ponytail", "SKILL.md"), "# Existing skill");

      makePonytailFixture(src);

      const report = importClaudePlugin(src, { sourceDir: src, workspaceRoot: ws, overwrite: true });

      // Skills and commands should be installed (overwritten)
      expect(report.skillsInstalled).toEqual(["ponytail"]);
      expect(report.commandsInstalled).toEqual(["ponytail.md"]);

      // Existing files should be replaced
      const skillContent = require("node:fs").readFileSync(
        join(ws, ".agency", "skills", "ponytail", "SKILL.md"),
        "utf8",
      );
      expect(skillContent).toContain("Force simplest solution.");
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // -----------------------------------------------------------------------
  // No manifest directory at all
  // -----------------------------------------------------------------------

  test("throws when no .claude-plugin/ or .codex-plugin/ exists", () => {
    const src = makeDir("no-manifest");
    const ws = makeDir("ws-no-manifest");
    try {
      mkdirSync(src, { recursive: true });
      expect(() => {
        importClaudePlugin(src, { sourceDir: src, workspaceRoot: ws });
      }).toThrow(/No valid plugin manifest/);
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // -----------------------------------------------------------------------
  // Report shape
  // -----------------------------------------------------------------------

  test("report has all expected fields", () => {
    const src = makeDir("report-shape");
    const ws = makeDir("ws-report");
    try {
      makePonytailFixture(src);

      const report: ImportClaudePluginReport = importClaudePlugin(src, { sourceDir: src, workspaceRoot: ws });

      expect(report).toHaveProperty("pluginName");
      expect(report).toHaveProperty("pluginVersion");
      expect(report).toHaveProperty("pluginDescription");
      expect(report).toHaveProperty("skillsInstalled");
      expect(report).toHaveProperty("hooksMapped");
      expect(report).toHaveProperty("hooksSkipped");
      expect(report).toHaveProperty("mcpServers");
      expect(report).toHaveProperty("agentsFound");
      expect(report).toHaveProperty("commandsInstalled");
      expect(Array.isArray(report.skillsInstalled)).toBe(true);
      expect(Array.isArray(report.hooksMapped)).toBe(true);
      expect(Array.isArray(report.hooksSkipped)).toBe(true);
      expect(typeof report.mcpServers).toBe("object");
      expect(Array.isArray(report.agentsFound)).toBe(true);
      expect(Array.isArray(report.commandsInstalled)).toBe(true);
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

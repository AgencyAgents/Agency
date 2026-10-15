import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergePermissions, PermissionsGate } from "@agency/guard";
import {
  loadClaudePermissions,
  loadClaudeSettingsEnv,
  permissionsFromRules,
} from "../src/config/claude-permissions.ts";
import { claudeEnabledPlugins, claudeMarketplaceSource } from "../src/config/claude-plugins.ts";

test("Claude Code permission rules become the permissions map here, and deny wins over allow", () => {
  const { permissions, skipped } = permissionsFromRules({
    allow: [
      "Bash(git status)",
      "Bash(npm run test:*)",
      "Read",
      "Edit(./src/**)",
      "WebFetch",
      "mcp__gh__create_issue",
    ],
    ask: ["Bash(git push *)"],
    deny: ["Bash(rm *)", "Read(.env)", "Read(~/.ssh/**)", "mcp__gh", "WebFetch(domain:x.com)", 42],
  });
  expect(permissions).toEqual({
    bash: { "git status": "allow", "npm run test *": "allow", "git push *": "ask", "rm *": "deny" },
    read: { "**": "allow", ".env": "deny" },
    grep: "allow",
    glob: "allow",
    edit: { "src/**": "allow" },
    write: { "src/**": "allow" },
    notebook_edit: { "src/**": "allow" },
    fetch: "allow",
    gh_create_issue: "allow",
  });
  expect(skipped).toEqual(["Read(~/.ssh/**)", "mcp__gh", "WebFetch(domain:x.com)"]);

  const gate = new PermissionsGate({ permissions, workspaceRoot: process.cwd() });
  const decide = (tool: string, subject: { command?: string; path?: string }) =>
    gate.decisionFor({ tool, riskTier: "dangerous", ...subject });
  expect(decide("bash", { command: "git status" })).toBe("allow");
  expect(decide("bash", { command: "npm run test -- --watch" })).toBe("allow");
  expect(decide("bash", { command: "git push origin dev" })).toBe("ask");
  expect(decide("bash", { command: "rm -rf build" })).toBe("deny");
  expect(decide("bash", { command: "npm install" })).toBe("ask");
  expect(decide("bash", { command: "ls" })).toBe("allow");
  expect(decide("read", { path: "src/deep/a.ts" })).toBe("allow");
  expect(decide("edit", { path: "src/a.ts" })).toBe("allow");
  expect(decide("edit", { path: "README.md" })).toBe("ask");
});

test("an Edit rule holds for every tool that edits files, and a bare Read rule for grep and glob, as in Claude Code", () => {
  const { permissions } = permissionsFromRules({ deny: ["Edit(secrets/**)", "Read"] });
  const gate = new PermissionsGate({ permissions, workspaceRoot: process.cwd() });
  for (const tool of ["edit", "write", "notebook_edit"]) {
    expect(gate.decisionFor({ tool, riskTier: "dangerous", path: "secrets/key.txt" })).toBe("deny");
    expect(gate.decisionFor({ tool, riskTier: "dangerous", path: "src/a.ts" })).not.toBe("deny");
  }
  expect(["read", "grep", "glob"].map((tool) => gate.toolOffered(tool, "safe"))).toEqual([
    false,
    false,
    false,
  ]);
  // A path of Read cannot hold for grep and glob here: they take a folder, and the gate matches no path for them.
  expect(permissionsFromRules({ deny: ["Read(.env)"] }).permissions).toEqual({ read: { ".env": "deny" } });
});

test("rules merged on top of a map come after its rules, so they win", () => {
  expect(
    mergePermissions(
      { bash: "ask", write: "deny", read: { "docs/**": "deny" } },
      { bash: { "git *": "allow" }, read: { "**": "allow" }, edit: "allow" },
    ),
  ).toEqual({
    bash: { "*": "ask", "git *": "allow" },
    write: "deny",
    read: { "docs/**": "deny", "**": "allow" },
    edit: "allow",
  });
});

test("the rules of a run win over the gate of the config", () => {
  const gate = new PermissionsGate({
    permissions: { bash: "deny", edit: "ask" },
    workspaceRoot: process.cwd(),
  });
  const run = gate.withMode("ask").withRules({ bash: { "git *": "allow" }, edit: "allow" });
  expect(run.decisionFor({ tool: "bash", command: "git log", riskTier: "dangerous" })).toBe("allow");
  expect(run.decisionFor({ tool: "bash", command: "make", riskTier: "dangerous" })).toBe("deny");
  expect(run.decisionFor({ tool: "edit", path: "a.ts", riskTier: "moderate" })).toBe("allow");
  expect(gate.withRules(undefined)).toBe(gate);
});

test("the settings of Claude Code give their rules: the user's always, the workspace's only when trusted", () => {
  const home = mkdtempSync(join(tmpdir(), "agency-ccperm-home-"));
  const ws = mkdtempSync(join(tmpdir(), "agency-ccperm-ws-"));
  const write = (file: string, permissions: unknown) => {
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify({ permissions }));
  };
  write(join(home, ".claude", "settings.json"), { allow: ["Bash(npm *)", "Read"] });
  write(join(ws, ".claude", "settings.json"), { deny: ["Bash(npm publish *)"] });
  writeFileSync(
    join(ws, ".claude", "settings.local.json"),
    '{\n  // mine\n  "permissions": { "ask": ["Edit"] },\n}',
  );
  const before = process.env.AGENCY_AGENTS_HOME;
  process.env.AGENCY_AGENTS_HOME = home;
  try {
    expect(loadClaudePermissions(ws, true)).toEqual({
      bash: { "npm *": "allow", "npm publish *": "deny" },
      read: "allow",
      grep: "allow",
      glob: "allow",
      edit: "ask",
      write: "ask",
      notebook_edit: "ask",
    });
    expect(loadClaudePermissions(ws, false)).toEqual({
      bash: { "npm *": "allow" },
      read: "allow",
      grep: "allow",
      glob: "allow",
    });
  } finally {
    process.env.AGENCY_AGENTS_HOME = before;
    rmSync(home, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});

test("the env of the Claude Code settings of a workspace: settings.local.json wins, and other values are left out", () => {
  const ws = mkdtempSync(join(tmpdir(), "agency-cc-env-"));
  try {
    mkdirSync(join(ws, ".claude"));
    writeFileSync(
      join(ws, ".claude", "settings.json"),
      JSON.stringify({ env: { A: "1", B: "x", PORT: 3000, DEBUG: true, OBJ: { x: 1 } } }),
    );
    writeFileSync(join(ws, ".claude", "settings.local.json"), '{ "env": { "B": "local" }, }');
    expect(loadClaudeSettingsEnv(ws)).toEqual({ A: "1", B: "local", PORT: "3000", DEBUG: "true" });
    expect(loadClaudeSettingsEnv(join(ws, "none"))).toEqual({});
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("a marketplace of Claude Code resolves from the settings, then from the marketplaces that Claude Code added", () => {
  const root = mkdtempSync(join(tmpdir(), "agency-cc-market-"));
  try {
    const ws = join(root, "ws");
    const home = join(root, "home");
    const copy = join(home, ".claude", "plugins", "marketplaces", "added");
    mkdirSync(join(ws, ".claude"), { recursive: true });
    mkdirSync(copy, { recursive: true });
    const github = (repo: string, extra: object = {}) => ({ source: { source: "github", repo, ...extra } });
    writeFileSync(
      join(ws, ".claude", "settings.json"),
      JSON.stringify({
        enabledPlugins: { "a@team": true, "b@team": false, bad: true },
        extraKnownMarketplaces: { team: github("org/team"), sub: github("org/mono", { path: "market" }) },
      }),
    );
    writeFileSync(
      join(ws, ".claude", "settings.local.json"),
      JSON.stringify({ extraKnownMarketplaces: { team: github("me/fork", { ref: "dev" }) } }),
    );
    writeFileSync(
      join(home, ".claude", "plugins", "known_marketplaces.json"),
      JSON.stringify({ added: { ...github("x/added"), installLocation: copy }, gone: github("x/gone") }),
    );
    expect(claudeEnabledPlugins(ws)).toEqual(["a@team"]);
    expect(claudeMarketplaceSource("team", ws, home)).toBe("me/fork#dev");
    expect(claudeMarketplaceSource("added", ws, home)).toBe(copy);
    expect(claudeMarketplaceSource("gone", ws, home)).toBe("x/gone");
    expect(claudeMarketplaceSource("claude-plugins-official", ws, home)).toBe(
      "anthropics/claude-plugins-official",
    );
    expect(claudeMarketplaceSource("nowhere", ws, home)).toBeUndefined();
    expect(() => claudeMarketplaceSource("sub", ws, home)).toThrow("subfolder market");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

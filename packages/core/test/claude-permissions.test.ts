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
    edit: { "src/**": "allow" },
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
  expect(decide("bash", { command: "ls" })).toBe("ask");
  expect(decide("read", { path: "src/deep/a.ts" })).toBe("allow");
  expect(decide("edit", { path: "src/a.ts" })).toBe("allow");
  expect(decide("edit", { path: "README.md" })).toBe("ask");
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
      edit: "ask",
    });
    expect(loadClaudePermissions(ws, false)).toEqual({ bash: { "npm *": "allow" }, read: "allow" });
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

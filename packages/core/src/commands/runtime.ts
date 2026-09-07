import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { SandboxBoundary } from "@agency/guard";
import { splitFrontmatter } from "../plugins/skill.ts";
import type { PluginCommandContribution } from "../plugins/types.ts";
import type { CommandTemplate } from "./loader.ts";

export interface BuiltinCommand {
  name: string;
  tier: 1 | 2 | 3;
  description: string;
  usage: string;
}

/** Tier 1 ships first: bare-minimum session commands every client needs. */
const TIER_1: BuiltinCommand[] = [
  { name: "help", tier: 1, description: "List built-in, file, and plugin commands.", usage: "/help" },
  { name: "init", tier: 1, description: "Scaffold AGENTS.md guidance files.", usage: "/init" },
  { name: "new", tier: 1, description: "Create an empty session.", usage: "/new [id]" },
  { name: "compact", tier: 1, description: "Compact a session to a new tip.", usage: "/compact <session>" },
  { name: "model", tier: 1, description: "Show or set the active model.", usage: "/model [provider/model]" },
  { name: "sessions", tier: 1, description: "List daemon-known sessions.", usage: "/sessions" },
  {
    name: "undo",
    tier: 1,
    description: "Undo the last snapshot-backed file change.",
    usage: "/undo [session]",
  },
  { name: "redo", tier: 1, description: "Redo a snapshot-backed file change.", usage: "/redo [session]" },
  { name: "exit", tier: 1, description: "Ask the client to end this session.", usage: "/exit" },
];

/** Tier 2 rides the team surface: board, inbox, cost, and inspection. */
const TIER_2: BuiltinCommand[] = [
  {
    name: "agents",
    tier: 2,
    description: "List team agents with state and cost.",
    usage: "/agents [session]",
  },
  { name: "team", tier: 2, description: "Team states, todo, and totals.", usage: "/team [session]" },
  { name: "todos", tier: 2, description: "Read persisted session todos.", usage: "/todos <session>" },
  {
    name: "status",
    tier: 2,
    description: "Show a session through the projector view.",
    usage: "/status <session>",
  },
  { name: "stop", tier: 2, description: "Stop a team run and idle its agents.", usage: "/stop [session]" },
  { name: "cost", tier: 2, description: "Per-session and per-agent cost report.", usage: "/cost [session]" },
  {
    name: "plan",
    tier: 2,
    description: "Record a human approval for a plan file.",
    usage: "/plan <path> [approver]",
  },
  {
    name: "approve",
    tier: 2,
    description: "Answer a pending approval ask.",
    usage: "/approve <id> <once|always|reject> [session]",
  },
  {
    name: "inspect",
    tier: 2,
    description: "Timeline, step, or reasoning view over an agent.",
    usage: "/inspect <agent> [timeline|step|reasoning] [n]",
  },
  { name: "graph", tier: 2, description: "Delegation DAG of agents plus tasks.", usage: "/graph [session]" },
  { name: "decisions", tier: 2, description: "Read the shared choice log.", usage: "/decisions" },
  {
    name: "owners",
    tier: 2,
    description: "Resolve path owners from the owners map.",
    usage: "/owners <path>",
  },
  {
    name: "undo-run",
    tier: 2,
    description: "Roll a session back to its pre-turn checkpoint.",
    usage: "/undo-run <session>",
  },
];

/** Tier 3 holds developer utilities over trace, VCS, and daemon state. */
const TIER_3: BuiltinCommand[] = [
  {
    name: "trace",
    tier: 3,
    description: "Load trace spans for a session.",
    usage: "/trace <session> [turn]",
  },
  {
    name: "replay",
    tier: 3,
    description: "Re-run a recorded turn and diff.",
    usage: "/replay <session> <turn> [model]",
  },
  { name: "diff", tier: 3, description: "Workspace git diff and status.", usage: "/diff" },
  { name: "export", tier: 3, description: "Return a session's raw entries.", usage: "/export <session>" },
  { name: "mcp", tier: 3, description: "MCP server failures for a scope.", usage: "/mcp [session]" },
  { name: "lsp", tier: 3, description: "Language server statuses for a scope.", usage: "/lsp [session]" },
  {
    name: "permissions",
    tier: 3,
    description: "Permission maps plus offered tools.",
    usage: "/permissions [session]",
  },
  {
    name: "trust",
    tier: 3,
    description: "Show or change workspace trust.",
    usage: "/trust [allow|deny] [path]",
  },
  { name: "debug", tier: 3, description: "Resolve the effective system prompt.", usage: "/debug [session]" },
  {
    name: "doctor",
    tier: 3,
    description: "Connectivity, catalog, trust, and session checks.",
    usage: "/doctor",
  },
  { name: "goal", tier: 3, description: "Team goal, outcome, and cost.", usage: "/goal [outcome]" },
];

/** Every built-in the runtime resolves, in tier order. */
export const BUILTIN_COMMANDS: readonly BuiltinCommand[] = [...TIER_1, ...TIER_2, ...TIER_3];

export function isBuiltinCommand(name: string): boolean {
  return BUILTIN_COMMANDS.some((c) => c.name === name);
}

/** Split `---` frontmatter into description plus body, for command files. */
export function parseCommandFile(text: string): { description?: string; body: string } {
  const split = splitFrontmatter(text);
  const description =
    split.fields.description !== undefined && split.fields.description.length > 0
      ? split.fields.description
      : undefined;
  return { ...(description === undefined ? {} : { description }), body: split.body };
}

/** Whitespace tokenization for `$1..$9`; quoting stays the caller's job. */
export function splitCommandArgs(args: string): string[] {
  const trimmed = args.trim();
  if (trimmed.length === 0) return [];
  return trimmed.split(/\s+/);
}

/** Fill `$1..$9` plus `$ARGUMENTS`/`$ARGS`/`$@`/`$*`; missing slots go empty. */
export function substituteArgs(body: string, args: string): string {
  const tokens = splitCommandArgs(args);
  let out = body;
  for (let i = 9; i >= 1; i--) out = out.replaceAll(`$${i}`, tokens[i - 1] ?? "");
  out = out.replaceAll("$ARGUMENTS", args);
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${ARGUMENTS} placeholder
  out = out.replaceAll("${ARGUMENTS}", args);
  out = out.replaceAll("$ARGS", args);
  out = out.replaceAll("$@", args);
  out = out.replaceAll("$*", args);
  return out;
}

const SHELL_BLOCK_RE = /!`([^`]+)`/g;

/** Shell blocks awaiting execution, in source order. */
export function extractShellBlocks(body: string): string[] {
  const out: string[] = [];
  SHELL_BLOCK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  for (m = SHELL_BLOCK_RE.exec(body); m !== null; m = SHELL_BLOCK_RE.exec(body)) {
    const cmd = m[1]?.trim();
    if (cmd) out.push(cmd);
  }
  return out;
}

/** Run each `` !`cmd` `` block inline; failures degrade to a marker, never throw. */
export function runShellBlocks(
  body: string,
  opts: { cwd: string; timeoutMs?: number; maxBytes?: number },
): string {
  const timeout = opts.timeoutMs ?? 15_000;
  const cap = opts.maxBytes ?? 8192;
  return body.replace(SHELL_BLOCK_RE, (_m, raw: string) => {
    const cmd = String(raw).trim();
    try {
      const out = execSync(cmd, {
        cwd: opts.cwd,
        timeout,
        windowsHide: true,
        encoding: "utf8",
        maxBuffer: cap * 4,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const trimmed = out.trim();
      return trimmed.length > cap ? `${trimmed.slice(0, cap)}[[truncated]]` : trimmed;
    } catch {
      return `[[shell failed: ${cmd.slice(0, 200)}]]`;
    }
  });
}

const AT_FILE_RE = /(^|\s)@([A-Za-z0-9_][A-Za-z0-9_./~-]*)/g;

/** Inline `@path` for existing in-workspace files; prose `@mentions` pass through. */
export function expandAtFiles(body: string, opts: { workspaceRoot: string; maxBytes?: number }): string {
  const cap = opts.maxBytes ?? 8192;
  const boundary = new SandboxBoundary(opts.workspaceRoot);
  return body.replace(AT_FILE_RE, (m, prefix: string, rel: string) => {
    let filePath: string;
    try {
      filePath = boundary.resolvePath(rel);
    } catch {
      return m;
    }
    let content: string;
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      return m;
    }
    const trimmed = content.length > cap ? `${content.slice(0, cap)}[[truncated]]` : content;
    return `${prefix}${trimmed}`;
  });
}

export type ResolvedCommand =
  | { kind: "builtin"; name: string }
  | { kind: "template"; name: string; template: CommandTemplate }
  | { kind: "plugin"; name: string; command: PluginCommandContribution; pluginId: string }
  | { kind: "unknown"; name: string };

/** Built-ins win, then project files, user files, plugin commands, else unknown. */
export function resolveCommand(
  name: string,
  opts: {
    templates: CommandTemplate[];
    pluginCommands: Array<{ pluginId: string; command: PluginCommandContribution }>;
  },
): ResolvedCommand {
  if (isBuiltinCommand(name)) return { kind: "builtin", name };
  const project = opts.templates.find((t) => t.name === name && t.source === "project");
  if (project) return { kind: "template", name, template: project };
  const user = opts.templates.find((t) => t.name === name && t.source === "user");
  if (user) return { kind: "template", name, template: user };
  const plugin = opts.pluginCommands.find((p) => p.command.name === name);
  if (plugin) return { kind: "plugin", name, command: plugin.command, pluginId: plugin.pluginId };
  return { kind: "unknown", name };
}

/** Typed failure shape for unknown names, shared by every client. */
export function unknownCommandMessage(name: string): string {
  return `unknown command: ${name}`;
}

/** Dual-publish a hook so exact and wildcard plugin subscribers both fire. */
export function announceHook(
  bus: { emit(event: string, payload: unknown): void },
  name: string,
  payload: unknown,
): void {
  try {
    bus.emit(name, payload);
  } catch {}
  try {
    bus.emit("event", { event: name, payload });
  } catch {}
}

/** `/help` body: built-ins by tier, then file templates, then plugin commands. */
export function renderCommandHelp(opts: {
  templates: CommandTemplate[];
  pluginCommands: Array<{ pluginId: string; command: PluginCommandContribution }>;
}): string {
  const lines: string[] = ["Commands (built-in first, then files, then plugins):", ""];
  for (const tier of [1, 2, 3] as const) {
    lines.push(`Tier ${tier}:`);
    for (const c of BUILTIN_COMMANDS.filter((b) => b.tier === tier)) {
      lines.push(`  /${c.name} - ${c.description} (${c.usage})`);
    }
    lines.push("");
  }
  if (opts.templates.length > 0) {
    lines.push("File templates:");
    for (const t of opts.templates) lines.push(`  /${t.name} - ${t.description ?? t.source} [${t.source}]`);
    lines.push("");
  }
  if (opts.pluginCommands.length > 0) {
    lines.push("Plugin commands:");
    for (const p of opts.pluginCommands) {
      lines.push(`  /${p.command.name} - ${p.command.description ?? p.pluginId} [${p.pluginId}]`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

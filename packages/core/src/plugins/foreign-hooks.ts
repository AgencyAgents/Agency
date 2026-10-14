import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import {
  COMMAND_HOOK_EVENTS,
  type CommandHookEvent,
  type CommandHooks,
  CommandHooksSchema,
  mergeCommandHooks,
} from "./command-hooks.ts";

type Raw = Record<string, unknown>;
type Warn = (message: string) => void;
type Group = NonNullable<CommandHooks[CommandHookEvent]>[number];

const record = (value: unknown): Raw =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Raw) : {};

/** The events of Cursor as events here, with the tools that each one is about. */
const CURSOR_EVENTS: Record<string, [CommandHookEvent, string?]> = {
  sessionStart: ["SessionStart"],
  sessionEnd: ["SessionEnd"],
  preToolUse: ["PreToolUse"],
  postToolUse: ["PostToolUse"],
  postToolUseFailure: ["PostToolUseFailure"],
  subagentStart: ["SubagentStart"],
  subagentStop: ["SubagentStop"],
  beforeShellExecution: ["PreToolUse", "bash"],
  afterShellExecution: ["PostToolUse", "bash"],
  beforeReadFile: ["PreToolUse", "read"],
  afterFileEdit: ["PostToolUse", "write|edit"],
  beforeSubmitPrompt: ["UserPromptSubmit"],
  preCompact: ["PreCompact"],
  stop: ["Stop"],
};

const GEMINI_EVENTS: Record<string, CommandHookEvent> = {
  BeforeTool: "PreToolUse",
  AfterTool: "PostToolUse",
  BeforeAgent: "UserPromptSubmit",
  AfterAgent: "Stop",
  SessionStart: "SessionStart",
  SessionEnd: "SessionEnd",
  Notification: "Notification",
  PreCompress: "PreCompact",
};

/** Hooks in the format of Claude Code, which Codex shares. */
function claudeHooks(raw: unknown, file: string, warn: Warn): CommandHooks {
  const hooks: CommandHooks = {};
  for (const [event, groups] of Object.entries(record(raw))) {
    if (!(COMMAND_HOOK_EVENTS as readonly string[]).includes(event)) {
      warn(`the ${event} hooks of ${file} are skipped: the event does not run here`);
      continue;
    }
    const parsed = CommandHooksSchema.safeParse({ [event]: groups });
    if (!parsed.success) {
      warn(
        `the ${event} hooks of ${file} are skipped: they are not command, http, prompt, agent or mcp_tool hooks`,
      );
      continue;
    }
    Object.assign(hooks, parsed.data);
  }
  return hooks;
}

/** Cursor has one list of hooks for each event, each with its own matcher. Its command hooks keep its input and answer. */
function cursorHooks(raw: unknown, file: string, warn: Warn): CommandHooks {
  const hooks: CommandHooks = {};
  for (const [name, entries] of Object.entries(record(raw))) {
    const mapped = CURSOR_EVENTS[name];
    if (mapped === undefined) {
      warn(`the ${name} hooks of ${file} are skipped: the event does not run here`);
      continue;
    }
    const [event, tools] = mapped;
    for (const entry of (Array.isArray(entries) ? entries : []).map(record)) {
      const matcher = typeof entry.matcher === "string" ? entry.matcher : undefined;
      // The matcher of a shell hook of Cursor tests the command line, that of another hook the tool.
      const shell = name === "beforeShellExecution" || name === "afterShellExecution";
      const toolMatcher = tools ?? (shell ? undefined : matcher);
      let hook: Group["hooks"][number];
      if (entry.type === "prompt" && typeof entry.prompt === "string") {
        // The prompt hook of Cursor has the question and answer of a prompt hook here.
        hook = {
          type: "prompt",
          prompt: entry.prompt,
          ...(typeof entry.model === "string" ? { model: entry.model } : {}),
        };
      } else if ((entry.type ?? "command") === "command" && typeof entry.command === "string") {
        hook = {
          type: "command",
          command: entry.command,
          ...(typeof entry.timeout === "number" ? { timeout: entry.timeout } : {}),
          cursor: {
            event: name,
            ...(shell && matcher !== undefined ? { matcher } : {}),
            ...(entry.failClosed === true ? { failClosed: true } : {}),
          },
        };
      } else {
        warn(`a ${name} hook of ${file} is skipped: it is not a command or a prompt`);
        continue;
      }
      hooks[event] = [
        ...(hooks[event] ?? []),
        {
          ...(toolMatcher === undefined ? {} : { matcher: toolMatcher }),
          hooks: [hook],
        },
      ];
    }
  }
  return hooks;
}

/** Gemini CLI has the groups of Claude Code, other event names, and a timeout in milliseconds. */
function geminiHooks(raw: unknown, file: string, warn: Warn): CommandHooks {
  const hooks: CommandHooks = {};
  for (const [name, groups] of Object.entries(record(raw))) {
    const event = GEMINI_EVENTS[name];
    if (event === undefined) {
      warn(`the ${name} hooks of ${file} are skipped: the event does not run here`);
      continue;
    }
    for (const group of (Array.isArray(groups) ? groups : []).map(record)) {
      const entries = (Array.isArray(group.hooks) ? group.hooks : [])
        .map(record)
        .filter((hook) => hook.type === "command" && typeof hook.command === "string")
        .map((hook) => ({
          type: "command" as const,
          command: String(hook.command),
          ...(typeof hook.timeout === "number" ? { timeout: hook.timeout / 1000 } : {}),
        }));
      if (entries.length === 0) continue;
      const matcher = typeof group.matcher === "string" ? { matcher: group.matcher } : {};
      hooks[event] = [...(hooks[event] ?? []), { ...matcher, hooks: entries }];
    }
  }
  return hooks;
}

const SOURCES: Array<[string[], (raw: Raw, file: string, warn: Warn) => CommandHooks]> = [
  [[".claude", "settings.json"], (raw, file, warn) => claudeHooks(raw.hooks, file, warn)],
  [[".claude", "settings.local.json"], (raw, file, warn) => claudeHooks(raw.hooks, file, warn)],
  [[".codex", "hooks.json"], (raw, file, warn) => claudeHooks(raw.hooks, file, warn)],
  [[".cursor", "hooks.json"], (raw, file, warn) => cursorHooks(raw.hooks, file, warn)],
  [[".gemini", "settings.json"], (raw, file, warn) => geminiHooks(raw.hooks, file, warn)],
];

/** The hooks of a Cursor plugin or a Gemini CLI extension in the format here. */
export function convertForeignHooks(
  format: "cursor" | "gemini",
  raw: unknown,
  file: string,
  warn: Warn,
): CommandHooks {
  return format === "cursor" ? cursorHooks(raw, file, warn) : geminiHooks(raw, file, warn);
}

/** Each hook file of another agent that a workspace can have, for the daemon to see a change. */
export function foreignHookPaths(workspaceRoot: string): string[] {
  return SOURCES.map(([parts]) => join(workspaceRoot, ...parts));
}

/** The hooks that other agents keep in a workspace: Claude Code, Codex, Cursor and Gemini CLI, in that order. */
export function loadForeignHooks(workspaceRoot: string, warn: Warn = () => {}): CommandHooks {
  const sets: CommandHooks[] = [];
  for (const [parts, read] of SOURCES) {
    const file = join(workspaceRoot, ...parts);
    if (!existsSync(file)) continue;
    const errors: unknown[] = [];
    const raw = parseJsonc(readFileSync(file, "utf8"), errors as never, { allowTrailingComma: true });
    if (errors.length > 0) {
      warn(`hook file ${file} is not valid JSON: skipped`);
      continue;
    }
    sets.push(read(record(raw), file, warn));
  }
  return mergeCommandHooks(...sets);
}

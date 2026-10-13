import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { type EventBus, HookBlock } from "../events.ts";

export const COMMAND_HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
  "SessionStart",
] as const;
export type CommandHookEvent = (typeof COMMAND_HOOK_EVENTS)[number];

const GroupSchema = z.object({
  /** Regular expression on the tool name, no regard to case. Absent, "" and "*" match every tool. */
  matcher: z.string().optional(),
  hooks: z.array(
    z.object({
      type: z.literal("command"),
      command: z.string().min(1),
      /** Seconds. */
      timeout: z.number().positive().optional(),
    }),
  ),
});

/** The hook format of Claude Code settings: event name to matcher groups of shell commands. */
export const CommandHooksSchema = z.object({
  PreToolUse: z.array(GroupSchema).optional(),
  PostToolUse: z.array(GroupSchema).optional(),
  UserPromptSubmit: z.array(GroupSchema).optional(),
  Stop: z.array(GroupSchema).optional(),
  SessionStart: z.array(GroupSchema).optional(),
});
export type CommandHooks = z.infer<typeof CommandHooksSchema>;

export interface HookOutcome {
  /** The hook refused: this text goes to the model. */
  block?: string;
  /** Text that the hook adds for the model. */
  context?: string;
}

const DEFAULT_TIMEOUT_S = 60;
const MAX_OUTPUT_CHARS = 10_000;

function matches(matcher: string | undefined, toolName: string | undefined): boolean {
  if (matcher === undefined || matcher === "" || matcher === "*" || toolName === undefined) return true;
  try {
    return new RegExp(`^(?:${matcher})$`, "i").test(toolName);
  } catch {
    return false;
  }
}

export interface HookRunOptions {
  cwd: string;
  /** The shell that runs each command: the daemon gives the shell of its bash tool. Absent means the system shell. */
  shell?: { command: string; buildArgs: (command: string) => string[] };
}

function runOne(
  command: string,
  stdin: string,
  opts: HookRunOptions,
  timeoutS: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const { cwd, shell } = opts;
    const spawnOptions = {
      cwd,
      windowsHide: true,
      detached: process.platform !== "win32",
      env: { ...process.env, CLAUDE_PROJECT_DIR: cwd, AGENCY_PROJECT_DIR: cwd },
    };
    const child = shell
      ? spawn(shell.command, shell.buildArgs(command), spawnOptions)
      : spawn(command, { ...spawnOptions, shell: true });
    let stdout = "";
    let stderr = "";
    // The shell is not the command: without the tree, the command lives on and holds the pipes open.
    const killTree = (): void => {
      if (child.pid === undefined) return;
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }
    };
    const timer = setTimeout(killTree, timeoutS * 1000);
    child.stdout.on("data", (d) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < MAX_OUTPUT_CHARS) stderr += String(d);
    });
    const done = (code: number | null) => {
      clearTimeout(timer);
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    };
    child.on("error", () => done(null));
    child.on("close", done);
    // A command that does not read stdin closes the pipe: that is not a failure.
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
}

function parseJson(text: string): Record<string, unknown> | undefined {
  if (!text.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Runs the commands of one event in order, with the event as JSON on stdin. Exit code 2 or a JSON
 * decision of block refuses, and the first refusal ends the run. Another failure does not block.
 */
export async function runCommandHooks(
  hooks: CommandHooks,
  event: CommandHookEvent,
  input: Record<string, unknown>,
  opts: HookRunOptions,
): Promise<HookOutcome> {
  const toolName = typeof input.tool_name === "string" ? input.tool_name : undefined;
  const stdin = JSON.stringify({ hook_event_name: event, cwd: opts.cwd, ...input });
  const context: string[] = [];
  for (const group of hooks[event] ?? []) {
    if (!matches(group.matcher, toolName)) continue;
    for (const entry of group.hooks) {
      const out = await runOne(entry.command, stdin, opts, entry.timeout ?? DEFAULT_TIMEOUT_S);
      if (out.code === 2) return { block: out.stderr || `blocked by a ${event} hook` };
      if (out.code !== 0) continue;
      const json = parseJson(out.stdout);
      const specific = (json?.hookSpecificOutput ?? {}) as Record<string, unknown>;
      if (json?.decision === "block" || specific.permissionDecision === "deny") {
        const reason = json?.reason ?? specific.permissionDecisionReason;
        return { block: typeof reason === "string" && reason ? reason : `blocked by a ${event} hook` };
      }
      if (typeof specific.additionalContext === "string") context.push(specific.additionalContext);
      else if (!json && out.stdout && (event === "UserPromptSubmit" || event === "SessionStart")) {
        context.push(out.stdout);
      }
    }
  }
  return context.length > 0 ? { context: context.join("\n") } : {};
}

/** Connects the tool and stop events of the bus to the command hooks. Returns the function that disconnects them. */
export function attachCommandHooks(bus: EventBus, hooks: CommandHooks, opts: HookRunOptions): () => void {
  type ToolPayload = { tool: string; input: unknown; result?: unknown; sessionId?: string };
  const offs = [
    bus.on("tool.execute.before", async (payload) => {
      const p = payload as ToolPayload;
      const out = await runCommandHooks(
        hooks,
        "PreToolUse",
        { session_id: p.sessionId, tool_name: p.tool, tool_input: p.input },
        opts,
      );
      if (out.block !== undefined) throw new HookBlock(out.block);
    }),
    bus.on("tool.execute.after", async (payload) => {
      const p = payload as ToolPayload;
      const out = await runCommandHooks(
        hooks,
        "PostToolUse",
        { session_id: p.sessionId, tool_name: p.tool, tool_input: p.input, tool_response: p.result },
        opts,
      );
      const text = out.block ?? out.context;
      if (text !== undefined) throw new HookBlock(text);
    }),
    bus.on("turn.stop", async (payload) => {
      const p = payload as { sessionId?: string; taskDepth: number; stopHookActive: boolean };
      // A subagent is not the session: its end is not the end of the user's turn.
      if (p.taskDepth > 0) return;
      const out = await runCommandHooks(
        hooks,
        "Stop",
        { session_id: p.sessionId, stop_hook_active: p.stopHookActive },
        opts,
      );
      if (out.block !== undefined) throw new HookBlock(out.block);
    }),
  ];
  return () => {
    for (const off of offs) off();
  };
}

/** Joins hook sets: each event gets the groups of every set, in order. */
export function mergeCommandHooks(...sets: CommandHooks[]): CommandHooks {
  const merged: CommandHooks = {};
  for (const event of COMMAND_HOOK_EVENTS) {
    const groups = sets.flatMap((set) => set[event] ?? []);
    if (groups.length > 0) merged[event] = groups;
  }
  return merged;
}

/** The hooks of the `*.json` files of a folder: `plugin install` writes one for each plugin. A file that is not valid is skipped. */
export function loadHookFiles(dir: string, warn: (message: string) => void = () => {}): CommandHooks {
  if (!existsSync(dir)) return {};
  const sets: CommandHooks[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(readFileSync(join(dir, entry), "utf8")) as { hooks?: unknown };
      sets.push(CommandHooksSchema.parse(raw.hooks ?? raw));
    } catch (error) {
      warn(
        `hook file ${join(dir, entry)} is not valid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return mergeCommandHooks(...sets);
}

import { spawn, spawnSync } from "node:child_process";
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

function runOne(
  command: string,
  stdin: string,
  cwd: string,
  timeoutS: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      cwd,
      windowsHide: true,
      detached: process.platform !== "win32",
      env: { ...process.env, CLAUDE_PROJECT_DIR: cwd, AGENCY_PROJECT_DIR: cwd },
    });
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
  opts: { cwd: string },
): Promise<HookOutcome> {
  const toolName = typeof input.tool_name === "string" ? input.tool_name : undefined;
  const stdin = JSON.stringify({ hook_event_name: event, cwd: opts.cwd, ...input });
  const context: string[] = [];
  for (const group of hooks[event] ?? []) {
    if (!matches(group.matcher, toolName)) continue;
    for (const entry of group.hooks) {
      const out = await runOne(entry.command, stdin, opts.cwd, entry.timeout ?? DEFAULT_TIMEOUT_S);
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
export function attachCommandHooks(bus: EventBus, hooks: CommandHooks, opts: { cwd: string }): () => void {
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

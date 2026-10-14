import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { globToRegExpSource, splitCommand, unwrapCommand } from "@agency/guard";
import { z } from "zod";
import { type EventBus, HookBlock } from "../events.ts";

export const COMMAND_HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "UserPromptSubmit",
  "UserPromptExpansion",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "Notification",
  "PermissionRequest",
  "SessionStart",
  "SessionEnd",
] as const;
export type CommandHookEvent = (typeof COMMAND_HOOK_EVENTS)[number];

const GroupSchema = z.object({
  /** Regular expression on the subject of the event (the tool name of a tool event), no regard to case. Absent, "" and "*" match all. */
  matcher: z.string().optional(),
  hooks: z.array(
    z.object({
      type: z.literal("command"),
      command: z.string().min(1),
      /** Seconds. */
      timeout: z.number().positive().optional(),
      /** One permission rule on the tool call (`Bash(git *)`, `Edit(*.ts)`): the hook runs only for a call that matches. */
      if: z.string().optional(),
      /** Runs in the background: the event does not wait, and the hook cannot block it. */
      async: z.boolean().optional(),
      asyncRewake: z.boolean().optional(),
    }),
  ),
});

/** The hook format of Claude Code settings: event name to matcher groups of shell commands. */
export const CommandHooksSchema = z.object(
  Object.fromEntries(COMMAND_HOOK_EVENTS.map((event) => [event, z.array(GroupSchema).optional()])) as Record<
    CommandHookEvent,
    z.ZodOptional<z.ZodArray<typeof GroupSchema>>
  >,
);
export type CommandHooks = z.infer<typeof CommandHooksSchema>;

export interface HookOutcome {
  /** The hook refused: this text goes to the model. */
  block?: string;
  /** Text that the hook adds for the model. */
  context?: string;
  /** A PermissionRequest hook answered the ask with allow. */
  allow?: true;
}

const DEFAULT_TIMEOUT_S = 60;
const MAX_OUTPUT_CHARS = 10_000;

function matches(matcher: string | undefined, subject: string | undefined): boolean {
  if (matcher === undefined || matcher === "" || matcher === "*" || subject === undefined) return true;
  try {
    return new RegExp(`^(?:${matcher})$`, "i").test(subject);
  } catch {
    return false;
  }
}

const TOOL_EVENTS: ReadonlySet<CommandHookEvent> = new Set([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
]);

/**
 * True when the tool call matches the `if` rule of a hook. A command line matches when one of its commands does, as
 * for a permission rule; one that the splitter cannot read matches, as in Claude Code.
 */
export function hookIfMatches(rule: string, tool: unknown, toolInput: unknown, cwd: string): boolean {
  const parsed = /^([^()]+?)(?:\(([\s\S]*)\))?$/.exec(rule.trim());
  if (!parsed || typeof tool !== "string" || parsed[1]?.toLowerCase() !== tool.toLowerCase()) return false;
  const pattern = parsed[2]?.replace(/:\*$/, "*");
  if (pattern === undefined || pattern === "" || pattern === "*") return true;
  const input = (toolInput ?? {}) as Record<string, unknown>;
  if (typeof input.command === "string") {
    const { parts, dynamic } = splitCommand(input.command);
    const re = new RegExp(globToRegExpSource(pattern, "command"));
    return dynamic || parts.some((part) => unwrapCommand(part).some((form) => re.test(form)));
  }
  const path = input.file_path ?? input.path;
  if (typeof path !== "string") return true;
  // As in .gitignore: a pattern with no slash names a file at any depth, one with a slash starts at the folder.
  const re = new RegExp(globToRegExpSource(pattern.includes("/") ? pattern : `**/${pattern}`, "path"));
  return re.test(relative(cwd, resolve(cwd, path)).replace(/\\/g, "/"));
}

export interface HookRunOptions {
  cwd: string;
  /** The shell that runs each command: the daemon gives the shell of its bash tool. Absent means the system shell. */
  shell?: { command: string; buildArgs: (command: string) => string[] };
  /** Text for the model from a background hook that ended: the daemon puts it in the inbox of the session. */
  onBackgroundOutput?: (sessionId: string | undefined, text: string) => void;
}

function runOne(
  command: string,
  stdin: string,
  opts: HookRunOptions,
  timeoutS: number | undefined,
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
    const timer = timeoutS === undefined ? undefined : setTimeout(killTree, timeoutS * 1000);
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

/**
 * What a background hook that ended gives the model, as in Claude Code: on exit code 2 of `asyncRewake` its stderr
 * (or stdout), otherwise `additionalContext` and `systemMessage` of a JSON answer, alone on stdout or on a line of its own.
 */
function backgroundOutput(out: { code: number | null; stdout: string; stderr: string }, rewake: boolean) {
  if (rewake && out.code === 2) return out.stderr || out.stdout || undefined;
  if (out.code !== 0) return undefined;
  const json =
    parseJson(out.stdout) ??
    out.stdout
      .split("\n")
      .map((line) => parseJson(line.trim()))
      .findLast(Boolean);
  const specific = (json?.hookSpecificOutput ?? {}) as Record<string, unknown>;
  const parts = [specific.additionalContext, json?.systemMessage].filter(
    (part): part is string => typeof part === "string" && part !== "",
  );
  return parts.length > 0 ? parts.join("\n") : undefined;
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
  // What a matcher tests: the tool, the trigger of a compaction, the agent type, the type of a notification, the
  // typed command, or the type of a provider error.
  const subject = [
    input.tool_name,
    input.trigger,
    input.agent_type,
    input.notification_type,
    input.command_name,
    input.error,
  ].find((value): value is string => typeof value === "string");
  const stdin = JSON.stringify({ hook_event_name: event, cwd: opts.cwd, ...input });
  const context: string[] = [];
  for (const group of hooks[event] ?? []) {
    if (!matches(group.matcher, subject)) continue;
    for (const entry of group.hooks) {
      if (
        entry.if !== undefined &&
        !(TOOL_EVENTS.has(event) && hookIfMatches(entry.if, input.tool_name, input.tool_input, opts.cwd))
      ) {
        continue;
      }
      if (entry.async || entry.asyncRewake) {
        const rewake = entry.asyncRewake === true;
        void runOne(
          entry.command,
          stdin,
          opts,
          rewake ? (entry.timeout ?? DEFAULT_TIMEOUT_S) : entry.timeout,
        ).then((out) => {
          const text = backgroundOutput(out, rewake);
          const sessionId = typeof input.session_id === "string" ? input.session_id : undefined;
          if (text !== undefined) opts.onBackgroundOutput?.(sessionId, text);
        });
        continue;
      }
      const out = await runOne(entry.command, stdin, opts, entry.timeout ?? DEFAULT_TIMEOUT_S);
      if (out.code === 2) return { block: out.stderr || `blocked by a ${event} hook` };
      if (out.code !== 0) continue;
      const json = parseJson(out.stdout);
      const specific = (json?.hookSpecificOutput ?? {}) as Record<string, unknown>;
      // The answer of a PermissionRequest hook, in the form of Claude Code.
      const behavior = (specific.decision as { behavior?: unknown } | undefined)?.behavior;
      if (event === "PermissionRequest" && behavior === "allow") return { allow: true };
      if (json?.decision === "block" || specific.permissionDecision === "deny" || behavior === "deny") {
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
  // The stop event of a subagent has no agent type: the start event gave it.
  const agentTypes = new Map<string, string>();
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
      const result = p.result as { content?: unknown; isError?: boolean } | undefined;
      const base = { session_id: p.sessionId, tool_name: p.tool, tool_input: p.input };
      // As in Claude Code: PostToolUse is for a call that succeeded, and a failed call has its own event.
      const out = result?.isError
        ? await runCommandHooks(hooks, "PostToolUseFailure", { ...base, error: result.content }, opts)
        : await runCommandHooks(hooks, "PostToolUse", { ...base, tool_response: p.result }, opts);
      const text = out.block ?? out.context;
      if (text !== undefined) throw new HookBlock(text);
    }),
    bus.on("turn.stop", async (payload) => {
      const p = payload as { sessionId?: string; taskDepth: number; stopHookActive: boolean };
      // A subagent is not the session: its end has its own event.
      const out = await runCommandHooks(
        hooks,
        p.taskDepth > 0 ? "SubagentStop" : "Stop",
        {
          session_id: p.sessionId,
          stop_hook_active: p.stopHookActive,
          ...(p.taskDepth > 0 && p.sessionId ? { agent_type: agentTypes.get(p.sessionId) } : {}),
        },
        opts,
      );
      if (out.block !== undefined) throw new HookBlock(out.block);
    }),
    bus.on("subagent.start", async (payload) => {
      const p = payload as { sessionId: string; handle: string };
      agentTypes.set(p.sessionId, p.handle);
      await runCommandHooks(hooks, "SubagentStart", { session_id: p.sessionId, agent_type: p.handle }, opts);
    }),
    bus.on("permission.request", async (payload) => {
      const p = payload as {
        sessionId?: string;
        tool: string;
        command?: string;
        path?: string;
        decision?: "allow" | "deny";
      };
      const out = await runCommandHooks(
        hooks,
        "PermissionRequest",
        {
          session_id: p.sessionId,
          tool_name: p.tool,
          tool_input: {
            ...(p.command === undefined ? {} : { command: p.command }),
            ...(p.path === undefined ? {} : { path: p.path }),
          },
        },
        opts,
      );
      // A deny of one hook set holds against an allow of another.
      if (out.block !== undefined) p.decision = "deny";
      else if (out.allow && p.decision === undefined) p.decision = "allow";
    }),
    bus.on("session.compacting", async (payload) => {
      const p = payload as { sessionId: string; trigger: string };
      const out = await runCommandHooks(
        hooks,
        "PreCompact",
        { session_id: p.sessionId, trigger: p.trigger },
        opts,
      );
      if (out.block !== undefined) throw new HookBlock(out.block);
    }),
    bus.on("session.compacted", async (payload) => {
      const p = payload as { sessionId: string; trigger?: string };
      await runCommandHooks(hooks, "PostCompact", { session_id: p.sessionId, trigger: p.trigger }, opts);
    }),
    bus.on("session.end", async (payload) => {
      const p = payload as { sessionId: string; reason: string };
      await runCommandHooks(hooks, "SessionEnd", { session_id: p.sessionId, reason: p.reason }, opts);
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

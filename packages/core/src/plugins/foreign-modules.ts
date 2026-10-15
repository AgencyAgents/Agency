import { z } from "zod";
import type { Logger } from "../logger.ts";
import type { ToolSpec } from "../loop.ts";
import type { HookHandler, PluginDefinition } from "./types.ts";

type Raw = Record<string, unknown>;
type Handler = (...args: unknown[]) => unknown;

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
/** A JSON Schema with the symbols of TypeBox and the `$schema` of zod left out. */
function plainSchema(schema: unknown): Record<string, unknown> {
  const { $schema: _, ...rest } = JSON.parse(JSON.stringify(schema ?? { type: "object" })) as Raw;
  return rest;
}

// ---------------------------------------------------------------------------
// The packages that the code of other agents imports
// ---------------------------------------------------------------------------

const OPTIONAL = Symbol("optional");
type Schema = Record<string | symbol, unknown>;

/** The builders of TypeBox that tool parameters use: each gives the JSON Schema that TypeBox gives. */
const Type = {
  Object: (properties: Record<string, Schema>, options: Raw = {}) => {
    const required = Object.entries(properties)
      .filter(([, schema]) => schema[OPTIONAL] !== true)
      .map(([key]) => key);
    return { type: "object", properties, ...(required.length > 0 ? { required } : {}), ...options };
  },
  String: (options: Raw = {}) => ({ type: "string", ...options }),
  Number: (options: Raw = {}) => ({ type: "number", ...options }),
  Integer: (options: Raw = {}) => ({ type: "integer", ...options }),
  Boolean: (options: Raw = {}) => ({ type: "boolean", ...options }),
  Null: (options: Raw = {}) => ({ type: "null", ...options }),
  Array: (items: Schema, options: Raw = {}) => ({ type: "array", items, ...options }),
  Optional: (schema: Schema) => ({ ...schema, [OPTIONAL]: true }),
  Literal: (value: unknown, options: Raw = {}) => ({ const: value, ...options }),
  Union: (anyOf: Schema[], options: Raw = {}) => ({ anyOf, ...options }),
  Enum: (values: Raw, options: Raw = {}) => ({ enum: Object.values(values), ...options }),
  Record: (_key: Schema, value: Schema, options: Raw = {}) => ({
    type: "object",
    additionalProperties: value,
    ...options,
  }),
  Any: (options: Raw = {}) => ({ ...options }),
  Unknown: (options: Raw = {}) => ({ ...options }),
};
const StringEnum = (values: string[], options: Raw = {}) => ({ type: "string", enum: values, ...options });
const typebox = { ...Type, Type, default: Type };
const piRuntime = { Type, StringEnum, defineTool: <T>(tool: T) => tool };

let registered = false;
/** Gives the imports of OpenCode plugins and Pi extensions: their own packages are not in this program. */
export function registerForeignModules(): void {
  if (registered) return;
  registered = true;
  Bun.plugin({
    name: "agency-foreign-modules",
    setup(build) {
      const module = (name: string, exports: Raw) =>
        build.module(name, () => ({ loader: "object", exports }));
      module("@opencode-ai/plugin", { tool: Object.assign(<T>(def: T) => def, { schema: z }) });
      for (const name of ["typebox", "@sinclair/typebox"]) module(name, typebox);
      for (const scope of ["@earendil-works", "@mariozechner"]) {
        module(`${scope}/pi-coding-agent`, piRuntime);
        module(`${scope}/pi-ai`, piRuntime);
      }
    },
  });
}

/** An object whose methods do nothing: the parts of the API of another agent that have no place here. */
function inert(fixed: Raw = {}): Raw {
  return new Proxy(fixed, {
    get: (target, key) => (key in target ? target[key as string] : () => undefined),
  });
}

/** Joins the hooks of several plugins of one file: they run in order, and the first block wins. */
function joinHooks(sets: Array<Record<string, HookHandler>>): Record<string, HookHandler> {
  const names = new Set(sets.flatMap((set) => Object.keys(set)));
  return Object.fromEntries(
    [...names].map((name) => [
      name,
      (async (payload, ctx) => {
        for (const set of sets) {
          const out = await (set[name] as Handler | undefined)?.(payload, ctx);
          if (typeof (out as { block?: unknown } | undefined)?.block === "string") return out;
        }
        return undefined;
      }) as HookHandler,
    ]),
  );
}

// ---------------------------------------------------------------------------
// OpenCode plugins
// ---------------------------------------------------------------------------

/**
 * The plugins of an OpenCode plugin file, each an exported function that gets `{ directory, worktree, project, $,
 * client }` and gives hooks. `client` talks to an OpenCode server, so here each of its calls fails.
 */
export async function openCodePlugins(
  mod: Raw,
  id: string,
  root: string,
): Promise<PluginDefinition | undefined> {
  const fail = async () => {
    throw new Error("the OpenCode client is not available here");
  };
  const client = new Proxy({}, { get: () => new Proxy(fail, { get: () => fail }) });
  const input = { directory: root, worktree: root, project: { id: root, worktree: root }, $: Bun.$, client };
  const sets: Array<Record<string, HookHandler>> = [];
  const tools: ToolSpec[] = [];
  for (const factory of new Set(Object.values(mod).filter((value) => typeof value === "function"))) {
    const raw = ((await (factory as Handler)(input)) ?? {}) as Raw;
    const hook = (name: string) => (typeof raw[name] === "function" ? (raw[name] as Handler) : undefined);
    const hooks: Record<string, HookHandler> = {};
    const before = hook("tool.execute.before");
    if (before) {
      hooks["tool.execute.before"] = (async (payload: Raw) => {
        try {
          // An OpenCode plugin changes `output.args`, or puts other args there.
          const output = { args: payload.input };
          await before({ tool: payload.tool, sessionID: payload.sessionId, callID: "" }, output);
          payload.input = output.args;
        } catch (error) {
          // A throw is how an OpenCode plugin refuses a call.
          return { block: message(error) };
        }
        return undefined;
      }) as HookHandler;
    }
    const after = hook("tool.execute.after");
    if (after) {
      hooks["tool.execute.after"] = (async (payload: Raw) => {
        const result = (payload.result ?? {}) as Raw;
        const output = { title: "", output: result.content, metadata: {} };
        await after(
          { tool: payload.tool, sessionID: payload.sessionId, callID: "", args: payload.input },
          output,
        );
        if (typeof output.output === "string" && output.output !== result.content)
          payload.output = output.output;
      }) as HookHandler;
    }
    const env = hook("shell.env");
    if (env)
      hooks["shell.env"] = (async (payload: Raw) => void (await env({ cwd: root }, payload))) as HookHandler;
    const event = hook("event");
    if (event) {
      hooks.event = (async (payload: Raw) =>
        void (await event({ event: { type: payload.event, properties: payload.payload } }))) as HookHandler;
    }
    const ask = hook("permission.ask");
    if (ask) {
      hooks["permission.request"] = (async (payload: Raw) => {
        const title = payload.command ?? payload.path ?? payload.tool;
        const output = { status: "ask" };
        await ask({ type: payload.tool, pattern: title, title, sessionID: payload.sessionId }, output);
        if (output.status === "allow" || output.status === "deny") payload.decision ??= output.status;
      }) as HookHandler;
    }
    sets.push(hooks);
    for (const [name, def] of Object.entries((raw.tool ?? {}) as Record<string, Raw>)) {
      const execute = def.execute as Handler;
      tools.push({
        name,
        description: String(def.description ?? name),
        inputSchema: plainSchema(z.toJSONSchema(z.object((def.args ?? {}) as z.ZodRawShape))),
        handler: async (args, ctx) => {
          const context = {
            sessionID: ctx.sessionId ?? "",
            messageID: "",
            agent: "agency",
            abort: ctx.signal ?? new AbortController().signal,
            directory: root,
            worktree: root,
          };
          return { content: String(await execute(args, context)) };
        },
      });
    }
  }
  const hooks = joinHooks(sets);
  if (Object.keys(hooks).length === 0 && tools.length === 0) return undefined;
  return { id, ...(Object.keys(hooks).length > 0 ? { hooks } : {}), ...(tools.length > 0 ? { tools } : {}) };
}

// ---------------------------------------------------------------------------
// Pi extensions
// ---------------------------------------------------------------------------

/** The Pi events that have an event here, with the event object that a handler of Pi gets. */
const PI_EVENTS: Record<string, [string, (payload: Raw) => Raw]> = {
  tool_call: [
    "tool.execute.before",
    (p) => ({ type: "tool_call", toolCallId: "", toolName: p.tool, input: p.input }),
  ],
  tool_result: [
    "tool.execute.after",
    (p) => {
      const result = (p.result ?? {}) as Raw;
      const content = [{ type: "text", text: String(result.content ?? "") }];
      return {
        type: "tool_result",
        toolCallId: "",
        toolName: p.tool,
        input: p.input,
        content,
        isError: !!result.isError,
      };
    },
  ],
  session_start: ["session.start", () => ({ type: "session_start", reason: "startup" })],
  before_agent_start: [
    "prompt.submit",
    (p) => ({ type: "before_agent_start", messageType: "user", prompt: p.prompt }),
  ],
  agent_end: ["turn.stop", () => ({ type: "agent_end", messages: [] })],
};

/**
 * Runs Pi extensions with the parts of their API that have a place here: `registerTool`, the events of `PI_EVENTS`,
 * and `exec`. A command, a shortcut, a renderer or a UI call does nothing, and the extension is told that no UI exists.
 */
export async function piExtensions(
  factories: unknown[],
  id: string,
  root: string,
  logger?: Logger,
): Promise<PluginDefinition | undefined> {
  const handlers = new Map<string, Handler[]>();
  const tools: ToolSpec[] = [];
  const ctx = inert({
    cwd: root,
    hasUI: false,
    mode: "print",
    signal: undefined,
    model: undefined,
    ui: inert({
      notify: (text: unknown) => logger?.info(`[pi:${id}] ${String(text)}`),
      confirm: async () => false,
    }),
    sessionManager: inert({ getBranch: () => [], getEntries: () => [] }),
    modelRegistry: inert(),
    tools: [],
    isIdle: () => true,
    executeTool: async () => {
      throw new Error("executeTool is not available here");
    },
  });
  const api = inert({
    on: (name: string, handler: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      return () =>
        handlers.set(
          name,
          (handlers.get(name) ?? []).filter((h) => h !== handler),
        );
    },
    registerTool: (def: Raw) => {
      const execute = def.execute as Handler;
      tools.push({
        name: String(def.name),
        description: String(def.description ?? def.label ?? def.name),
        inputSchema: plainSchema(def.parameters),
        handler: async (input, toolCtx) => {
          try {
            const result = ((await execute(
              toolCtx.toolCallId ?? "",
              input,
              toolCtx.signal,
              undefined,
              ctx,
            )) ?? {}) as Raw;
            const parts = Array.isArray(result.content) ? (result.content as Raw[]) : [];
            const text = parts.filter((part) => part.type === "text").map((part) => String(part.text));
            return { content: text.join("\n"), isError: result.isError === true };
          } catch (error) {
            return { content: message(error), isError: true };
          }
        },
      });
    },
    registerCommand: (name: string) => logger?.warn(`[pi:${id}] the command /${name} does not run here`),
    exec: async (command: string, args: string[] = []) => {
      const child = Bun.spawn([command, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { stdout, stderr, code, killed: false };
    },
    events: inert({ on: () => () => {} }),
    getActiveTools: () => [],
    getAllTools: () => [],
    getCommands: () => [],
    getMcpServers: () => [],
  });
  for (const factory of factories) {
    if (typeof factory === "function") await (factory as Handler)(api);
  }
  const hooks: Record<string, HookHandler> = {};
  for (const [name, list] of handlers) {
    const mapped = PI_EVENTS[name];
    if (mapped === undefined) continue;
    const [hookName, toEvent] = mapped;
    hooks[hookName] = (async (payload: Raw) => {
      for (const handler of list) {
        let out: unknown;
        try {
          out = await handler(toEvent(payload), ctx);
        } catch (error) {
          // As in Pi: a tool_call handler that throws blocks the call.
          if (name === "tool_call") return { block: message(error) };
          throw error;
        }
        const result = (out ?? {}) as Raw;
        if (name === "tool_call" && result.block === true) {
          return {
            block: typeof result.reason === "string" ? result.reason : `blocked by the Pi extension ${id}`,
          };
        }
        // As in Pi: a tool_result handler gives the content that the model gets in place of the result.
        if (name === "tool_result" && Array.isArray(result.content)) {
          const parts = (result.content as Raw[]).filter((part) => part.type === "text");
          payload.output = parts.map((part) => String(part.text)).join("\n");
        }
      }
      return undefined;
    }) as HookHandler;
  }
  if (Object.keys(hooks).length === 0 && tools.length === 0) return undefined;
  return { id, ...(Object.keys(hooks).length > 0 ? { hooks } : {}), ...(tools.length > 0 ? { tools } : {}) };
}

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EventBus, HookBlock } from "../src/events.ts";
import type { ToolSpec } from "../src/loop.ts";
import { importClaudePlugin } from "../src/plugins/importer.ts";
import { loadPlugins } from "../src/plugins/loader.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "agency-foreign-mod-"));
  dirs.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

class Registry {
  readonly tools = new Map<string, ToolSpec>();
  register(spec: ToolSpec): void {
    this.tools.set(spec.name, spec);
  }
  has(name: string): boolean {
    return this.tools.has(name);
  }
}

/** The reason of the block of a bash call, or undefined when the hooks let it run. */
async function blockOf(bus: EventBus, command: string): Promise<string | undefined> {
  const { errors } = await bus.emitCollect("tool.execute.before", {
    tool: "bash",
    input: { command },
    sessionId: "s",
  });
  const block = errors.find((e) => e instanceof HookBlock);
  return block instanceof HookBlock ? block.message : undefined;
}

const OPENCODE_PLUGIN = `import { tool } from "@opencode-ai/plugin";
export const Guard = async ({ directory, $ }) => ({
  "tool.execute.before": async (input, output) => {
    if (input.tool === "bash" && String(output.args.command).startsWith("rm")) throw new Error("no rm in " + typeof directory);
  },
  tool: {
    hello: tool({
      description: "Says hi",
      args: { name: tool.schema.string().describe("who") },
      async execute(args, context) { return "hi " + args.name + " " + typeof context.abort; },
    }),
  },
});
`;

const PI_EXTENSION = `import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({
    name: "greet",
    label: "Greet",
    description: "Greets",
    parameters: Type.Object({ name: Type.String(), loud: Type.Optional(Type.Boolean()) }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return { content: [{ type: "text", text: "hello " + params.name + " in " + typeof ctx.cwd }], details: undefined };
    },
  });
  pi.on("tool_call", async (event) =>
    event.toolName === "bash" && event.input.command.startsWith("rm") ? { block: true, reason: "pi says no" } : undefined,
  );
  pi.registerCommand("stats", { description: "Stats", handler: async () => {} });
  pi.registerShortcut("ctrl+x", { handler: () => {} });
}
`;

test("an OpenCode plugin of .opencode/plugins runs: its hook blocks, and its tool works", async () => {
  const ws = folder({ ".opencode/plugins/guard.ts": OPENCODE_PLUGIN });
  const bus = new EventBus();
  const registry = new Registry();
  const result = await loadPlugins({ workspaceRoot: ws, bus, registry, configDirOverride: folder({}) });
  expect(result.errors).toEqual([]);
  expect(await blockOf(bus, "rm -rf x")).toBe("no rm in string");
  expect(await blockOf(bus, "ls")).toBeUndefined();
  const hello = registry.tools.get("guard_hello");
  expect(hello?.inputSchema).toMatchObject({
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  });
  expect(await hello?.handler({ name: "Bob" }, {} as never)).toEqual({ content: "hi Bob object" });
});

test("a Pi extension of .pi/extensions runs: its tool has the TypeBox schema, and tool_call blocks", async () => {
  const ws = folder({ ".pi/extensions/safe.ts": PI_EXTENSION });
  const bus = new EventBus();
  const registry = new Registry();
  const result = await loadPlugins({ workspaceRoot: ws, bus, registry, configDirOverride: folder({}) });
  expect(result.errors).toEqual([]);
  const greet = registry.tools.get("safe_greet");
  expect(greet?.inputSchema).toEqual({
    type: "object",
    properties: { name: { type: "string" }, loud: { type: "boolean" } },
    required: ["name"],
  });
  expect(await greet?.handler({ name: "Bob" }, {} as never)).toEqual({
    content: "hello Bob in string",
    isError: false,
  });
  expect(await blockOf(bus, "rm x")).toBe("pi says no");
});

test("the code of other agents does not load in a workspace that is not trusted", async () => {
  const ws = folder({
    ".opencode/plugins/guard.ts": OPENCODE_PLUGIN,
    ".pi/extensions/safe.ts": PI_EXTENSION,
  });
  const registry = new Registry();
  const result = await loadPlugins({
    workspaceRoot: ws,
    bus: new EventBus(),
    registry,
    configDirOverride: folder({}),
    projectTrusted: false,
  });
  expect(result.plugins).toEqual([]);
  expect(registry.tools.size).toBe(0);
});

test("a Pi package installs its extensions, and they load from the copy of the package", async () => {
  const src = folder({
    "package.json": JSON.stringify({
      name: "@me/pi-tools",
      keywords: ["pi-package"],
      pi: { extensions: ["./ext.ts"] },
    }),
    "ext.ts": PI_EXTENSION,
  });
  const ws = folder({});
  const report = importClaudePlugin(src, { sourceDir: src, workspaceRoot: ws });
  expect(report.partsSkipped).toEqual([]);
  expect(report.modulesInstalled).toEqual(["pi-tools.ts"]);
  rmSync(src, { recursive: true, force: true });
  const registry = new Registry();
  const result = await loadPlugins({
    workspaceRoot: ws,
    bus: new EventBus(),
    registry,
    configDirOverride: folder({}),
  });
  expect(result.errors).toEqual([]);
  expect(registry.has("pi-tools_greet")).toBe(true);
});

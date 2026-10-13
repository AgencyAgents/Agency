import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FULL_CAPABILITIES } from "@agency/guard";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, StreamEvent } from "@agency/providers";
import { Scheduler } from "@agency/providers";
import { EventBus, HookBlock } from "../src/events.ts";
import { runTurn, type ToolSpec } from "../src/loop.ts";
import { attachCommandHooks, type CommandHooks, runCommandHooks } from "../src/plugins/command-hooks.ts";
import { loadPlugins, unloadPlugins } from "../src/plugins/loader.ts";

const dir = mkdtempSync(join(tmpdir(), "agency-cmdhooks-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A hook command that runs `body` as a script with the test's own runtime. */
function hook(name: string, body: string): string {
  const file = join(dir, `${name}.js`);
  writeFileSync(file, body);
  return `"${process.execPath}" "${file}"`;
}

function on(event: keyof CommandHooks, command: string, matcher?: string): CommandHooks {
  return {
    [event]: [{ ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: "command", command }] }],
  };
}

const run = (hooks: CommandHooks, event: keyof CommandHooks, input: Record<string, unknown> = {}) =>
  runCommandHooks(hooks, event, input, { cwd: dir });

describe("runCommandHooks", () => {
  test("exit code 2 blocks with the stderr text", async () => {
    const cmd = hook("deny", 'console.error("no rm here"); process.exit(2);');
    expect(await run(on("PreToolUse", cmd), "PreToolUse", { tool_name: "bash" })).toEqual({
      block: "no rm here",
    });
  });

  test("a JSON decision of block on stdout blocks with its reason", async () => {
    const cmd = hook("json", 'console.log(JSON.stringify({ decision: "block", reason: "tests are red" }));');
    expect(await run(on("Stop", cmd), "Stop")).toEqual({ block: "tests are red" });
  });

  test("plain stdout of a prompt hook is context for the model", async () => {
    const cmd = hook("ctx", 'console.log("branch: dev");');
    expect(await run(on("UserPromptSubmit", cmd), "UserPromptSubmit", { prompt: "hi" })).toEqual({
      context: "branch: dev",
    });
  });

  test("another exit code does not block", async () => {
    const cmd = hook("fail", 'console.error("broken hook"); process.exit(1);');
    expect(await run(on("PreToolUse", cmd), "PreToolUse", { tool_name: "bash" })).toEqual({});
  });

  test("the matcher selects tools by name without regard to case", async () => {
    const cmd = hook("deny2", 'console.error("blocked"); process.exit(2);');
    const hooks = on("PreToolUse", cmd, "Edit|Write");
    expect((await run(hooks, "PreToolUse", { tool_name: "edit" })).block).toBe("blocked");
    expect(await run(hooks, "PreToolUse", { tool_name: "bash" })).toEqual({});
  });

  test("the command reads the event as JSON on stdin", async () => {
    const out = join(dir, "stdin.json");
    const cmd = hook(
      "stdin",
      `let s = ""; process.stdin.on("data", (d) => (s += d)); process.stdin.on("end", () => require("node:fs").writeFileSync(${JSON.stringify(out)}, s));`,
    );
    await run(on("PreToolUse", cmd), "PreToolUse", { tool_name: "bash", tool_input: { command: "ls" } });
    expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({
      hook_event_name: "PreToolUse",
      cwd: dir,
      tool_name: "bash",
      tool_input: { command: "ls" },
    });
  });

  test("a command that runs past its timeout does not block", async () => {
    const cmd = hook("slow", "setTimeout(() => process.exit(2), 30000);");
    const hooks: CommandHooks = { Stop: [{ hooks: [{ type: "command", command: cmd, timeout: 1 }] }] };
    expect(await run(hooks, "Stop")).toEqual({});
  });
});

const noopHttp: HttpClient = { fetch: async () => new Response() };
const usage = { inputTokens: 1, outputTokens: 1 };

/** Calls the tool `calls` times, then answers with text for each later request. */
function scripted(calls: number): { adapter: ProviderAdapter; requests: () => number } {
  let n = 0;
  return {
    requests: () => n,
    adapter: {
      family: "fake",
      async *stream(): AsyncIterable<StreamEvent> {
        n += 1;
        if (n <= calls) {
          yield { type: "tool_call_start", id: `c${n}`, name: "bash" };
          yield { type: "tool_call_delta", id: `c${n}`, inputJsonDelta: '{"command":"ls"}' };
          yield { type: "tool_call_end", id: `c${n}` };
          yield { type: "message_stop", stopReason: "tool_use", usage };
        } else {
          yield { type: "text_delta", text: `answer ${n}` };
          yield { type: "message_stop", stopReason: "end_turn", usage };
        }
      },
    },
  };
}

function bashTool(ran: string[]): ToolSpec {
  return {
    name: "bash",
    description: "runs a command",
    inputSchema: {},
    handler: async () => {
      ran.push("bash");
      return { content: "listing" };
    },
  };
}

const turn = (adapter: ProviderAdapter, bus: EventBus, tools: ToolSpec[]) =>
  runTurn(adapter, new Scheduler(), noopHttp, {
    identity: { type: "user" },
    capabilities: FULL_CAPABILITIES,
    systemPrompt: "sys",
    tools,
    model: "m",
    apiKey: "k",
    session: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    eventBus: bus,
    sessionId: "s1",
  });

const resultText = (messages: Awaited<ReturnType<typeof turn>>["messages"]): string[] =>
  messages.flatMap((m) => m.content.flatMap((b) => (b.type === "tool_result" ? [b.content] : [])));

describe("hooks in the loop", () => {
  test("a PreToolUse command hook refuses the call and the tool does not run", async () => {
    const bus = new EventBus();
    const cmd = hook("pre", 'console.error("bash is off"); process.exit(2);');
    attachCommandHooks(bus, on("PreToolUse", cmd, "Bash"), { cwd: dir });
    const ran: string[] = [];
    const result = await turn(scripted(1).adapter, bus, [bashTool(ran)]);
    expect(ran).toEqual([]);
    expect(resultText(result.messages)).toEqual(["bash is off"]);
  });

  test("a PostToolUse command hook adds its text to the tool result", async () => {
    const bus = new EventBus();
    const cmd = hook("post", 'console.error("lint: 2 errors"); process.exit(2);');
    attachCommandHooks(bus, on("PostToolUse", cmd), { cwd: dir });
    const ran: string[] = [];
    const result = await turn(scripted(1).adapter, bus, [bashTool(ran)]);
    expect(ran).toEqual(["bash"]);
    expect(resultText(result.messages)[0]).toContain("listing");
    expect(resultText(result.messages)[0]).toContain("lint: 2 errors");
  });

  test("a stop hook that blocks sends its reason to the model and the turn goes on", async () => {
    const bus = new EventBus();
    let stops = 0;
    bus.on("turn.stop", () => {
      stops += 1;
      if (stops === 1) throw new HookBlock("the tests did not run");
    });
    const script = scripted(0);
    const result = await turn(script.adapter, bus, []);
    expect(script.requests()).toBe(2);
    expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(result.messages[2]?.content).toEqual([{ type: "text", text: "the tests did not run" }]);
    expect(result.stopReason).toBe("end_turn");
  });

  test("a stop hook does not run for a subagent", async () => {
    const bus = new EventBus();
    const cmd = hook("stop", 'console.error("go on"); process.exit(2);');
    attachCommandHooks(bus, on("Stop", cmd), { cwd: dir });
    const script = scripted(0);
    await runTurn(script.adapter, new Scheduler(), noopHttp, {
      identity: { type: "user" },
      capabilities: FULL_CAPABILITIES,
      systemPrompt: "sys",
      tools: [],
      model: "m",
      apiKey: "k",
      session: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      eventBus: bus,
      taskDepth: 1,
    });
    expect(script.requests()).toBe(1);
  });

  test("a plugin hook that returns a block refuses the tool call", async () => {
    const root = mkdtempSync(join(dir, "ws-"));
    const pluginDir = join(root, ".agency", "plugins");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, "guard.js"),
      'export default { hooks: { "tool.execute.before": (p) => (p.tool === "bash" ? { block: "plugin says no" } : undefined) } };',
    );
    const bus = new EventBus();
    const loaded = await loadPlugins({
      workspaceRoot: root,
      configDirOverride: join(root, "cfg"),
      bus,
      capabilities: FULL_CAPABILITIES,
      identity: { type: "user" },
    });
    const ran: string[] = [];
    const result = await turn(scripted(1).adapter, bus, [bashTool(ran)]);
    unloadPlugins(loaded.plugins);
    expect(ran).toEqual([]);
    expect(resultText(result.messages)).toEqual(["plugin says no"]);
  });
});

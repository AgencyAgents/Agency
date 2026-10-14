import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FULL_CAPABILITIES, PermissionsGate } from "@agency/guard";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, StreamEvent } from "@agency/providers";
import { createApproximateTokenizer, Scheduler } from "@agency/providers";
import { EventBus, HookBlock } from "../src/events.ts";
import { runTurn, type ToolSpec } from "../src/loop.ts";
import {
  attachCommandHooks,
  type CommandHooks,
  CommandHooksSchema,
  runCommandHooks,
} from "../src/plugins/command-hooks.ts";
import { loadPlugins, unloadPlugins } from "../src/plugins/loader.ts";
import { compact } from "../src/sessions/compaction.ts";
import { SessionStore } from "../src/sessions/store.ts";

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

  test("`if` runs a hook only for a tool call that matches its permission rule", async () => {
    const cmd = hook("if-deny", 'console.error("matched"); process.exit(2);');
    const when = (rule: string, event: keyof CommandHooks = "PreToolUse"): CommandHooks => ({
      [event]: [{ hooks: [{ type: "command", command: cmd, if: rule }] }],
    });
    const bash = (command: string) => ({ tool_name: "bash", tool_input: { command } });
    expect(await run(when("Bash(git push *)"), "PreToolUse", bash("git push origin dev"))).toEqual({
      block: "matched",
    });
    // Any part of the command line, also behind a wrapper.
    expect(
      (await run(when("Bash(git push *)"), "PreToolUse", bash("cd app && sudo git push origin"))).block,
    ).toBe("matched");
    expect(await run(when("Bash(git push *)"), "PreToolUse", bash("git status"))).toEqual({});
    expect(await run(when("Bash(npm run test:*)"), "PreToolUse", bash("npm run test -- -x"))).toEqual({
      block: "matched",
    });
    // A command that the splitter cannot read runs the hook, as in Claude Code.
    expect((await run(when("Bash(rm *)"), "PreToolUse", bash("echo $(ls)"))).block).toBe("matched");

    const edit = (path: string) => ({ tool_name: "edit", tool_input: { path } });
    expect((await run(when("Edit(*.ts)"), "PreToolUse", edit("src/deep/a.ts"))).block).toBe("matched");
    expect(await run(when("Edit(*.ts)"), "PreToolUse", edit("src/a.js"))).toEqual({});
    expect((await run(when("Edit(src/**)"), "PreToolUse", edit(join(dir, "src", "a.js")))).block).toBe(
      "matched",
    );
    expect(await run(when("Edit(src/**)"), "PreToolUse", edit("lib/src/a.js"))).toEqual({});
    expect(await run(when("Edit(*.ts)"), "PreToolUse", bash("a.ts"))).toEqual({});

    // On an event that is not a tool event, a hook with `if` never runs.
    expect(await run(when("Bash(*)", "Stop"), "Stop", {})).toEqual({});
  });

  test("an async hook does not hold the event, and cannot block it", async () => {
    const done = join(dir, "async-done.txt");
    const cmd = hook(
      "async",
      `setTimeout(() => { require("fs").writeFileSync(${JSON.stringify(done)}, "x"); process.exit(2); }, 1500);`,
    );
    for (const flag of [{ async: true }, { asyncRewake: true }]) {
      rmSync(done, { force: true });
      const hooks: CommandHooks = { Stop: [{ hooks: [{ type: "command", command: cmd, ...flag }] }] };
      const started = Date.now();
      expect(await run(hooks, "Stop")).toEqual({});
      expect(Date.now() - started).toBeLessThan(1000);
      for (let i = 0; i < 100 && !existsSync(done); i++) await Bun.sleep(50);
      expect(existsSync(done)).toBe(true);
    }
  }, 20_000);

  test("a background hook gives the model its additionalContext, or the stderr of asyncRewake with exit code 2", async () => {
    const got: [string | undefined, string][] = [];
    const opts = {
      cwd: dir,
      onBackgroundOutput: (sessionId: string | undefined, text: string) => got.push([sessionId, text]),
    };
    const background = (name: string, body: string, flag: object): CommandHooks => ({
      Stop: [{ hooks: [{ type: "command", command: hook(name, body), ...flag }] }],
    });
    const json = JSON.stringify({
      hookSpecificOutput: { additionalContext: "tests passed" },
      systemMessage: "note",
    });
    await runCommandHooks(
      background("bg-json", `console.log("log line"); console.log(${JSON.stringify(json)});`, {
        async: true,
      }),
      "Stop",
      { session_id: "s1" },
      opts,
    );
    await runCommandHooks(
      background("bg-wake", 'console.error("build broke"); process.exit(2);', { asyncRewake: true }),
      "Stop",
      { session_id: "s2" },
      opts,
    );
    // Neither plain output nor exit code 2 of a hook that does not ask to wake reaches the model.
    await runCommandHooks(
      background("bg-plain", 'console.log("plain"); process.exit(2);', { async: true }),
      "Stop",
      { session_id: "s3" },
      opts,
    );
    for (let i = 0; i < 100 && got.length < 2; i++) await Bun.sleep(50);
    await Bun.sleep(500);
    expect(got.sort()).toEqual([
      ["s1", "tests passed\nnote"],
      ["s2", "build broke"],
    ]);
  }, 20_000);

  test("an http hook gets the event as a JSON POST, its JSON answer blocks, and a header takes only an allowed variable", async () => {
    const seen: {
      method: string;
      type: string | null;
      auth: string | null;
      other: string | null;
      body: unknown;
    }[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        seen.push({
          method: req.method,
          type: req.headers.get("content-type"),
          auth: req.headers.get("authorization"),
          other: req.headers.get("x-other"),
          body: await req.json(),
        });
        return Response.json({ decision: "block", reason: "no deploys today" });
      },
    });
    process.env.AGENCY_TEST_HOOK_TOKEN = "t1";
    process.env.AGENCY_TEST_HOOK_OTHER = "secret";
    try {
      const hooks = CommandHooksSchema.parse({
        PreToolUse: [
          {
            matcher: "bash",
            hooks: [
              {
                type: "http",
                url: `http://127.0.0.1:${server.port}/hook`,
                headers: {
                  Authorization: "Bearer $AGENCY_TEST_HOOK_TOKEN",
                  "X-Other": "${AGENCY_TEST_HOOK_OTHER}",
                },
                allowedEnvVars: ["AGENCY_TEST_HOOK_TOKEN"],
              },
            ],
          },
        ],
      });
      const out = await run(hooks, "PreToolUse", { tool_name: "bash", tool_input: { command: "deploy" } });
      expect(out).toEqual({ block: "no deploys today" });
      expect(seen).toEqual([
        {
          method: "POST",
          type: "application/json",
          auth: "Bearer t1",
          other: "",
          body: {
            hook_event_name: "PreToolUse",
            cwd: dir,
            tool_name: "bash",
            tool_input: { command: "deploy" },
          },
        },
      ]);
    } finally {
      delete process.env.AGENCY_TEST_HOOK_TOKEN;
      delete process.env.AGENCY_TEST_HOOK_OTHER;
      server.stop(true);
    }
  });

  test("an http hook that fails does not block: an error status, a text body, or no server", async () => {
    let reply: () => Response = () => new Response("down", { status: 500 });
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => reply() });
    const at = (url: string): CommandHooks => ({ UserPromptSubmit: [{ hooks: [{ type: "http", url }] }] });
    const url = `http://127.0.0.1:${server.port}/`;
    try {
      expect(await run(at(url), "UserPromptSubmit", { prompt: "p" })).toEqual({});
      reply = () => new Response("plain text is not context");
      expect(await run(at(url), "UserPromptSubmit", { prompt: "p" })).toEqual({});
      reply = () => Response.json({ hookSpecificOutput: { additionalContext: "from the hook" } });
      expect(await run(at(url), "UserPromptSubmit", { prompt: "p" })).toEqual({ context: "from the hook" });
    } finally {
      server.stop(true);
    }
    expect(await run(at(url), "UserPromptSubmit", { prompt: "p" })).toEqual({});
  });

  test("a prompt hook asks the model with the event in place of $ARGUMENTS, and ok false blocks with the reason", async () => {
    const asked: { prompt: string; model: string | undefined }[] = [];
    let reply = '{"ok": false, "reason": "the tests did not run"}';
    const opts = {
      cwd: dir,
      askModel: async (prompt: string, model: string | undefined) => {
        asked.push({ prompt, model });
        return reply;
      },
    };
    const hooks = CommandHooksSchema.parse({
      Stop: [
        { hooks: [{ type: "prompt", prompt: "Did the agent run the tests? $ARGUMENTS", model: "or/small" }] },
      ],
    });
    const stop = () => runCommandHooks(hooks, "Stop", { session_id: "s1", stop_hook_active: false }, opts);
    expect(await stop()).toEqual({ block: "the tests did not run" });
    expect(asked[0]?.model).toBe("or/small");
    expect(asked[0]?.prompt).toStartWith(
      `Did the agent run the tests? {"hook_event_name":"Stop","cwd":${JSON.stringify(dir)},"session_id":"s1"`,
    );
    expect(asked[0]?.prompt).toContain('{"ok": true}');

    // The model says the condition can never hold: the stop goes on.
    reply = 'Sure: {"ok": false, "reason": "no tests exist", "impossible": true}';
    expect(await stop()).toEqual({});
    reply = '{"ok": true}';
    expect(await stop()).toEqual({});
    reply = "I think it is fine";
    expect(await stop()).toEqual({});
    // A failed model call, or no model at all, does not block.
    expect(await runCommandHooks(hooks, "Stop", {}, { cwd: dir })).toEqual({});
    expect(
      await runCommandHooks(
        hooks,
        "Stop",
        {},
        { cwd: dir, askModel: () => Promise.reject(new Error("down")) },
      ),
    ).toEqual({});

    // As in Claude Code: no effect on a PermissionRequest, and no run on an event without prompt hooks.
    reply = '{"ok": false, "reason": "no"}';
    const on = (event: keyof CommandHooks) =>
      CommandHooksSchema.parse({ [event]: [{ hooks: [{ type: "prompt", prompt: "x" }] }] });
    expect(
      await runCommandHooks(on("PermissionRequest"), "PermissionRequest", { tool_name: "bash" }, opts),
    ).toEqual({});
    const before = asked.length;
    expect(await runCommandHooks(on("SessionStart"), "SessionStart", {}, opts)).toEqual({});
    expect(asked.length).toBe(before);
  });

  test("the matcher of a compaction hook tests the trigger, and that of a notification hook its type", async () => {
    const cmd = hook("deny3", 'console.error("blocked"); process.exit(2);');
    const compaction = on("PreCompact", cmd, "manual");
    expect(await run(compaction, "PreCompact", { trigger: "manual" })).toEqual({ block: "blocked" });
    expect(await run(compaction, "PreCompact", { trigger: "auto" })).toEqual({});
    const notification = on("Notification", cmd, "permission_prompt");
    expect(await run(notification, "Notification", { notification_type: "idle_prompt" })).toEqual({});
    expect(await run(notification, "Notification", { notification_type: "permission_prompt" })).toEqual({
      block: "blocked",
    });
  });
});

/** A hook command that writes the event that it got on stdin to a file. */
function capture(name: string): { cmd: string; read: () => Promise<Record<string, unknown>> } {
  const out = join(dir, `${name}.json`);
  const cmd = hook(
    name,
    `let s = ""; process.stdin.on("data", (d) => (s += d)); process.stdin.on("end", () => require("node:fs").writeFileSync(${JSON.stringify(out)}, s));`,
  );
  const read = async (): Promise<Record<string, unknown>> => {
    // The bus does not wait for a hook that cannot block: the file comes a moment later.
    for (let i = 0; i < 100 && !existsSync(out); i++) await new Promise((r) => setTimeout(r, 50));
    return JSON.parse(readFileSync(out, "utf8")) as Record<string, unknown>;
  };
  return { cmd, read };
}

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

  test("a stop hook gets the text of the last reply as last_assistant_message", async () => {
    const bus = new EventBus();
    const { cmd, read } = capture("stop-last");
    attachCommandHooks(bus, on("Stop", cmd), { cwd: dir });
    await turn(scripted(0).adapter, bus, []);
    expect(await read()).toMatchObject({ hook_event_name: "Stop", last_assistant_message: "answer 1" });
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

  test("a SubagentStop hook that blocks keeps the subagent at work", async () => {
    const bus = new EventBus();
    const marker = JSON.stringify(join(dir, "substop.marker"));
    const cmd = hook(
      "substop",
      `const fs = require("node:fs"); if (!fs.existsSync(${marker})) { fs.writeFileSync(${marker}, ""); console.error("check the result again"); process.exit(2); }`,
    );
    attachCommandHooks(bus, on("SubagentStop", cmd), { cwd: dir });
    const script = scripted(0);
    const result = await runTurn(script.adapter, new Scheduler(), noopHttp, {
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
    expect(script.requests()).toBe(2);
    expect(result.messages[2]?.content).toEqual([{ type: "text", text: "check the result again" }]);
  });

  /** One reply that calls bash twice, then text. */
  const twoCalls = (): { adapter: ProviderAdapter; requests: () => number } => {
    let n = 0;
    return {
      requests: () => n,
      adapter: {
        family: "fake",
        async *stream(): AsyncIterable<StreamEvent> {
          n += 1;
          if (n === 1) {
            for (const id of ["c1", "c2"]) {
              yield { type: "tool_call_start", id, name: "bash" };
              yield { type: "tool_call_delta", id, inputJsonDelta: `{"command":"ls ${id}"}` };
              yield { type: "tool_call_end", id };
            }
            yield { type: "message_stop", stopReason: "tool_use", usage };
          } else {
            yield { type: "text_delta", text: "done" };
            yield { type: "message_stop", stopReason: "end_turn", usage };
          }
        },
      },
    };
  };

  test("a PostToolBatch hook runs once for all calls of a reply, and its context goes once to the model", async () => {
    const out = join(dir, "batch.json");
    const cmd = hook(
      "batch",
      `let s = ""; process.stdin.on("data", (d) => (s += d)); process.stdin.on("end", () => { require("node:fs").writeFileSync(${JSON.stringify(out)}, s); console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolBatch", additionalContext: "batch checked" } })); });`,
    );
    const bus = new EventBus();
    attachCommandHooks(bus, on("PostToolBatch", cmd), { cwd: dir });
    const script = twoCalls();
    const result = await turn(script.adapter, bus, [bashTool([])]);
    expect(script.requests()).toBe(2);
    expect(resultText(result.messages)).toEqual(["listing", "listing\n\nbatch checked"]);
    const input = JSON.parse(readFileSync(out, "utf8")) as Record<string, unknown>;
    expect(input).toMatchObject({
      hook_event_name: "PostToolBatch",
      session_id: "s1",
      tool_calls: [
        {
          tool_name: "bash",
          tool_input: { command: "ls c1" },
          tool_use_id: "c1",
          tool_response: { content: "listing", isError: false },
        },
        { tool_name: "bash", tool_input: { command: "ls c2" }, tool_use_id: "c2" },
      ],
    });
  });

  test("a PostToolBatch hook that blocks ends the turn with its reason", async () => {
    const bus = new EventBus();
    attachCommandHooks(
      bus,
      on("PostToolBatch", hook("batch-stop", 'console.error("tests fail"); process.exit(2);')),
      {
        cwd: dir,
      },
    );
    const script = twoCalls();
    const result = await turn(script.adapter, bus, [bashTool([])]);
    expect(script.requests()).toBe(1);
    expect(resultText(result.messages)).toEqual(["listing", "listing"]);
    expect(result.error).toEqual({
      code: "hook_stop",
      message: "a PostToolBatch hook ended the turn: tests fail",
    });
  });

  test("a failed tool call runs PostToolUseFailure, and a call that succeeded runs PostToolUse", async () => {
    const hooks: CommandHooks = {
      ...on("PostToolUse", hook("post-ok", 'console.error("hook: it worked"); process.exit(2);')),
      ...on("PostToolUseFailure", hook("post-fail", 'console.error("hook: it failed"); process.exit(2);')),
    };
    const texts = async (tool: ToolSpec): Promise<string> => {
      const bus = new EventBus();
      attachCommandHooks(bus, hooks, { cwd: dir });
      return resultText((await turn(scripted(1).adapter, bus, [tool])).messages).join("\n");
    };
    const failed = await texts({
      ...bashTool([]),
      handler: async () => ({ content: "no such file", isError: true }),
    });
    expect(failed).toContain("hook: it failed");
    expect(failed).not.toContain("hook: it worked");
    const worked = await texts(bashTool([]));
    expect(worked).toContain("hook: it worked");
    expect(worked).not.toContain("hook: it failed");
  });

  test("a PreCompact hook refuses a compaction, and a PostCompact hook gets the trigger", async () => {
    const compactWith = async (hooks: CommandHooks): Promise<boolean> => {
      const bus = new EventBus();
      attachCommandHooks(bus, hooks, { cwd: dir });
      const store = new SessionStore(mkdtempSync(join(dir, "sessions-")), { bus });
      const meta = store.create("s1");
      let parentId: string | null = null;
      for (const text of ["x", "y", "z"]) {
        const message = {
          role: "user" as const,
          content: [{ type: "text" as const, text: text.repeat(50) }],
        };
        parentId = (await store.append(meta.id, { type: "message", message, parentId })).id;
      }
      const outcome = await compact(
        store,
        meta.id,
        parentId ?? "",
        createApproximateTokenizer(1),
        { contextWindow: 100, proactiveRatio: 0.5 },
        async () => "summary of old messages",
        1,
        { trigger: "manual" },
      );
      return outcome.compacted;
    };
    const deny = hook("precompact", 'console.error("not now"); process.exit(2);');
    expect(await compactWith(on("PreCompact", deny, "manual"))).toBe(false);
    expect(await compactWith(on("PreCompact", deny, "auto"))).toBe(true);
    const after = capture("postcompact");
    expect(await compactWith(on("PostCompact", after.cmd))).toBe(true);
    expect(await after.read()).toMatchObject({ hook_event_name: "PostCompact", trigger: "manual" });
  });

  test("a SubagentStart hook gets the type of the agent", async () => {
    const bus = new EventBus();
    const started = capture("substart");
    attachCommandHooks(bus, on("SubagentStart", started.cmd, "reviewer"), { cwd: dir });
    bus.emit("subagent.start", { sessionId: "child-1", handle: "reviewer", parentSessionId: "s1" });
    expect(await started.read()).toMatchObject({
      hook_event_name: "SubagentStart",
      session_id: "child-1",
      agent_type: "reviewer",
    });
  });

  test("a PermissionRequest hook answers an ask: allow runs the tool, deny refuses it, no answer goes to the user", async () => {
    const ask = {
      check: async (_request: unknown, approve?: (r: never) => Promise<string>) =>
        approve && (await approve({ tool: "bash", title: "ls", command: "ls" } as never)) !== "reject"
          ? ("allow" as const)
          : ("deny" as const),
    };
    const cases: Array<[string, string, string[]]> = [
      [
        'console.log(JSON.stringify({ hookSpecificOutput: { decision: { behavior: "allow" } } }));',
        "hook",
        ["bash"],
      ],
      [
        'console.log(JSON.stringify({ hookSpecificOutput: { decision: { behavior: "deny" } } }));',
        "hook",
        [],
      ],
      ["process.exit(2);", "hook", []],
      ["", "user", ["bash"]],
    ];
    for (const [index, [body, who, expected]] of cases.entries()) {
      const bus = new EventBus();
      const seen = capture(`perm-seen-${index}`);
      attachCommandHooks(
        bus,
        {
          PermissionRequest: [
            {
              matcher: "Bash",
              hooks: [
                { type: "command", command: seen.cmd },
                { type: "command", command: hook(`perm-${index}`, body) },
              ],
            },
          ],
        },
        { cwd: dir },
      );
      const ran: string[] = [];
      let asked = 0;
      await runTurn(scripted(1).adapter, new Scheduler(), noopHttp, {
        identity: { type: "user" },
        capabilities: FULL_CAPABILITIES,
        systemPrompt: "sys",
        tools: [bashTool(ran)],
        model: "m",
        apiKey: "k",
        session: [{ role: "user", content: [{ type: "text", text: "go" }] }],
        eventBus: bus,
        sessionId: "s1",
        toolPolicy: ask,
        requestApproval: async () => {
          asked += 1;
          return "once";
        },
      });
      expect(ran).toEqual(expected);
      expect(asked).toBe(who === "user" ? 1 : 0);
      expect(await seen.read()).toMatchObject({
        hook_event_name: "PermissionRequest",
        session_id: "s1",
        tool_name: "bash",
        tool_input: { command: "ls" },
      });
    }
  });

  test("auto mode: the reviewer answers a default ask, a block gives the reason and runs PermissionDenied", async () => {
    const cases: Array<{
      verdict: { allow: boolean; reason?: string } | undefined;
      permissions?: Record<string, "ask">;
      ran: string[];
      reviewed: number;
      asked: number;
    }> = [
      { verdict: { allow: true }, ran: ["bash"], reviewed: 1, asked: 0 },
      { verdict: { allow: false, reason: "the user said no shell" }, ran: [], reviewed: 1, asked: 0 },
      // No verdict: the user answers. An ask rule of the config also goes to the user, not to the reviewer.
      { verdict: undefined, ran: ["bash"], reviewed: 1, asked: 1 },
      { verdict: { allow: true }, permissions: { bash: "ask" }, ran: ["bash"], reviewed: 0, asked: 1 },
    ];
    for (const [index, c] of cases.entries()) {
      const bus = new EventBus();
      const denied = capture(`auto-denied-${index}`);
      const retry = hook(
        `auto-retry-${index}`,
        'console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionDenied", retry: true } }));',
      );
      attachCommandHooks(
        bus,
        {
          PermissionDenied: [
            {
              matcher: "Bash",
              hooks: [
                { type: "command", command: denied.cmd },
                { type: "command", command: retry },
              ],
            },
          ],
        },
        { cwd: dir },
      );
      const ran: string[] = [];
      let reviewed = 0;
      let asked = 0;
      const result = await runTurn(scripted(1).adapter, new Scheduler(), noopHttp, {
        identity: { type: "user" },
        capabilities: FULL_CAPABILITIES,
        systemPrompt: "sys",
        tools: [{ ...bashTool(ran), riskTier: "dangerous" }],
        model: "m",
        apiKey: "k",
        session: [{ role: "user", content: [{ type: "text", text: "go" }] }],
        eventBus: bus,
        sessionId: "s1",
        toolPolicy: new PermissionsGate({
          workspaceRoot: dir,
          permissionMode: "auto",
          ...(c.permissions ? { permissions: c.permissions } : {}),
        }),
        reviewApproval: async (request, transcript) => {
          reviewed += 1;
          expect(request).toMatchObject({ tool: "bash", command: "ls" });
          expect(transcript?.[0]).toMatchObject({ role: "user" });
          return c.verdict;
        },
        requestApproval: async () => {
          asked += 1;
          return "once";
        },
      });
      expect({ ran, reviewed, asked }).toEqual({ ran: c.ran, reviewed: c.reviewed, asked: c.asked });
      if (c.verdict?.allow !== false) {
        expect(existsSync(join(dir, `auto-denied-${index}.json`))).toBe(false);
        continue;
      }
      const [text = ""] = resultText(result.messages);
      expect(text).toContain("the user said no shell");
      expect(text).toContain("may retry");
      expect(await denied.read()).toMatchObject({
        hook_event_name: "PermissionDenied",
        session_id: "s1",
        tool_name: "bash",
        tool_input: { command: "ls" },
        tool_use_id: "c1",
        reason: "the user said no shell",
      });
    }
  });

  test("auto mode allows edits without the reviewer, and a run with no approval surface still gets the reviewer", async () => {
    const gate = new PermissionsGate({ workspaceRoot: dir, permissionMode: "auto" });
    let reviewed = 0;
    const review = async () => {
      reviewed += 1;
      return { allow: true };
    };
    expect(await gate.check({ tool: "write", riskTier: "moderate", path: "a.txt" }, undefined)).toBe("allow");
    const ran: string[] = [];
    await runTurn(scripted(1).adapter, new Scheduler(), noopHttp, {
      identity: { type: "user" },
      capabilities: FULL_CAPABILITIES,
      systemPrompt: "sys",
      tools: [{ ...bashTool(ran), riskTier: "dangerous" }],
      model: "m",
      apiKey: "k",
      session: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      toolPolicy: gate,
      reviewApproval: review,
    });
    expect({ ran, reviewed }).toEqual({ ran: ["bash"], reviewed: 1 });
  });

  test("a SubagentStop hook gets the type of the agent, and its matcher tests it", async () => {
    const bus = new EventBus();
    const stopped = capture("substop-type");
    const other = capture("substop-other");
    attachCommandHooks(
      bus,
      {
        SubagentStop: [
          { matcher: "reviewer", hooks: [{ type: "command", command: stopped.cmd }] },
          { matcher: "planner", hooks: [{ type: "command", command: other.cmd }] },
        ],
      },
      { cwd: dir },
    );
    bus.emit("subagent.start", { sessionId: "child-9", handle: "reviewer", parentSessionId: "s1" });
    await bus.emitCollect("turn.stop", { sessionId: "child-9", taskDepth: 1, stopHookActive: false });
    expect(await stopped.read()).toMatchObject({ hook_event_name: "SubagentStop", agent_type: "reviewer" });
    expect(existsSync(join(dir, "substop-other.json"))).toBe(false);
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

describe("the SessionEnd hook", () => {
  test("runs when a session ends, with the reason", async () => {
    const bus = new EventBus();
    const ended = capture("sessionend");
    attachCommandHooks(bus, on("SessionEnd", ended.cmd), { cwd: dir });
    bus.emit("session.end", { sessionId: "s9", reason: "other" });
    expect(await ended.read()).toMatchObject({
      hook_event_name: "SessionEnd",
      session_id: "s9",
      reason: "other",
    });
  });
});

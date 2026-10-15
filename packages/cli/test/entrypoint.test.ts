import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheDir, dataDir, OUTPUT_CUT_NOTE, SessionStore } from "@agency/core";
import { createFileTrustStore } from "@agency/guard";
import { createFileFallbackBackend } from "@agency/providers";
import type { DaemonClient } from "@agency/rpc";
import { DEFAULT_SYSTEM_PROMPT, type RunTurnRpcResult } from "../src/daemon.ts";
import type { EntrypointDeps } from "../src/entrypoint.ts";
import { parseArgv, runEntrypoint } from "../src/entrypoint.ts";
import type { RunHeadlessOptions } from "../src/headless.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** Env sandbox for commands that touch the machine's data/cache dirs. Covers
 *  the env knobs of win32 and Linux; macOS has none (paths under ~/Library),
 *  so tests that DELETE through these layers skip there. */
function sandboxEnv(): NodeJS.ProcessEnv {
  return {
    LOCALAPPDATA: tempDir("agency-ep-data-"),
    XDG_DATA_HOME: join(tempDir("agency-ep-xdg-"), "data"),
    XDG_CACHE_HOME: join(tempDir("agency-ep-xdg-"), "cache"),
  };
}

const pruneIfDeletable = test.skipIf(process.platform === "darwin");

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const deps: EntrypointDeps = {
    out: (line: string) => {
      out.push(line);
    },
    err: (line: string) => {
      err.push(line);
    },
  };
  return { out, err, deps };
}

const TURN_RESULT: RunTurnRpcResult = {
  messages: [
    { role: "user", content: [{ type: "text", text: "hello" }] },
    { role: "assistant", content: [{ type: "text", text: "hi from the fake daemon" }] },
  ],
  stopReason: "end_turn",
  usage: { inputTokens: 3, outputTokens: 2 },
  budgetExceeded: false,
  cancelled: false,
};

function fakeRunHeadless(result: RunTurnRpcResult = TURN_RESULT) {
  const calls: RunHeadlessOptions[] = [];
  return {
    calls,
    runHeadless: async (options: RunHeadlessOptions) => {
      calls.push(options);
      return result;
    },
  };
}

function fakeClient(result: RunTurnRpcResult = TURN_RESULT) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const sessionResult = { ...result, sessionId: "s", turnId: "t", tipId: "tip-1", compacted: false };
  const client: DaemonClient = {
    call: async (method, params) => {
      calls.push({ method, params });
      return method === "session_send" ? sessionResult : result;
    },
    on: () => () => {},
    subscribe: () => {},
    unsubscribe: () => {},
    close: async () => {},
  };
  return { calls, client };
}

function entry(id: string, parentId: string | null, text: string, createdAt: string) {
  return {
    id,
    schemaVersion: 1,
    createdAt,
    parentId,
    type: "message",
    message: { role: "user", content: [{ type: "text", text }] },
  };
}

function writeSessionFile(dir: string, id: string, lines: unknown[]) {
  writeFileSync(join(dir, `${id}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

describe("parseArgv", () => {
  test("splits command, subcommand, and positional args", () => {
    const parsed = parseArgv(["session", "delete", "abc", "--format", "json"]);
    expect(parsed.command).toBe("session");
    expect(parsed.subcommand).toBe("delete");
    expect(parsed.args).toEqual(["abc"]);
    expect(parsed.format).toBe("json");
  });

  test("accepts inline --flag=value and short forms", () => {
    const parsed = parseArgv(["-p=hi there", "--model=openai/gpt-5.2", "--continue"]);
    expect(parsed.print).toBe("hi there");
    expect(parsed.model).toBe("openai/gpt-5.2");
    expect(parsed.continueLast).toBe(true);
  });

  test("parses retention flags into a policy", () => {
    const parsed = parseArgv(["storage", "prune", "--max-age-days", "30", "--max-total-mb", "500"]);
    expect(parsed.retention).toEqual({ maxAgeDays: 30, maxTotalBytes: 500 * 1024 * 1024 });
  });

  test("update takes --rollback, as the help text and the docs say", () => {
    expect(parseArgv(["update", "--rollback"])).toMatchObject({ command: "update", rollback: true });
    expect(parseArgv(["update"]).rollback).toBe(false);
  });

  test("-- terminates flag parsing", () => {
    const parsed = parseArgv(["auth", "login", "--", "--weird-provider"]);
    expect(parsed.args).toEqual(["--weird-provider"]);
  });

  test("rejects unknown options, missing values, and bad formats", () => {
    expect(() => parseArgv(["--bogus"])).toThrow("Unknown option");
    expect(() => parseArgv(["--model"])).toThrow("needs a value");
    expect(() => parseArgv(["--format", "yaml"])).toThrow("text");
    expect(() => parseArgv(["--max-age-days", "-3"])).toThrow("non-negative");
  });
});

describe("help and version", () => {
  test("--help lists the headless flags and real commands", async () => {
    const { out, deps } = capture();
    const code = await runEntrypoint(["--help"], deps);
    expect(code).toBe(0);
    const help = out.join("\n");
    expect(help).toContain("-p, --print");
    expect(help).toContain("--format");
    expect(help).toContain("storage prune");
    expect(help).toContain("auth login <provider>");
    expect(help).toContain("--continue");
    expect(help).toContain("--session <id>");
  });

  test("--version prints the version", async () => {
    const { out, deps } = capture();
    const code = await runEntrypoint(["--version"], deps);
    expect(code).toBe(0);
    expect(out[0]).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("an unknown command is an error, not a silent fallback", async () => {
    const { out, err, deps } = capture();
    const code = await runEntrypoint(["frobnicate"], deps);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("frobnicate");
    expect(out).toEqual([]);
  });
});

describe("where and storage", () => {
  test("where prints the real path list, or JSON with --format json", async () => {
    const text = capture();
    expect(await runEntrypoint(["where"], text.deps)).toBe(0);
    expect(text.out.join("\n")).toContain("config:");

    const json = capture();
    expect(await runEntrypoint(["where", "--format", "json"], json.deps)).toBe(0);
    const paths = JSON.parse(json.out.join(""));
    expect(typeof paths.sessionsDir).toBe("string");
    expect(typeof paths.configPath).toBe("string");
    for (const key of ["config", "data", "cache", "logs"]) {
      expect(typeof paths[key]).toBe("string");
    }
  });

  test("storage reports sizes by category", async () => {
    const { out, deps } = capture();
    deps.env = sandboxEnv();
    expect(await runEntrypoint(["storage"], deps)).toBe(0);
    expect(out.join("\n")).toContain("safe to delete");
  });

  pruneIfDeletable("storage prune clears the cache dir", async () => {
    const env = sandboxEnv();
    const junk = join(cacheDir(env), "junk.txt");
    mkdirSync(cacheDir(env), { recursive: true });
    writeFileSync(junk, "x");

    const { out, deps } = capture();
    deps.env = env;
    expect(await runEntrypoint(["storage", "prune"], deps)).toBe(0);
    expect(out.join("\n")).toContain("cache: cleared");
    expect(existsSync(junk)).toBe(false);
  });

  pruneIfDeletable("storage prune applies session retention only when asked", async () => {
    const env = sandboxEnv();
    const sessions = join(dataDir(env), "sessions", "ws1");
    mkdirSync(sessions, { recursive: true });
    const old = join(sessions, "old.jsonl");
    const fresh = join(sessions, "fresh.jsonl");
    writeFileSync(old, "x");
    writeFileSync(fresh, "x");
    const longAgo = new Date(Date.now() - 40 * 86_400_000);
    utimesSync(old, longAgo, longAgo);

    const { out, deps } = capture();
    deps.env = env;
    expect(await runEntrypoint(["storage", "prune", "--max-age-days", "30"], deps)).toBe(0);
    expect(out.join("\n")).toContain("sessions: deleted 1");
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
});

describe("session commands", () => {
  test("session list shows ids newest-first, or a JSON array", async () => {
    const sessionsDir = tempDir("agency-ep-sessions-");
    writeSessionFile(sessionsDir, "a-first", [entry("e1", null, "older", "2026-01-01T00:00:00.000Z")]);
    writeSessionFile(sessionsDir, "b-second", [entry("e2", null, "newer", "2026-01-02T00:00:00.000Z")]);

    const text = capture();
    text.deps.sessionsDir = sessionsDir;
    expect(await runEntrypoint(["session", "list"], text.deps)).toBe(0);
    const lines = text.out.join("\n");
    expect(lines).toContain("b-second");
    expect(lines).toContain("a-first");
    expect(lines.indexOf("b-second")).toBeLessThan(lines.indexOf("a-first"));

    const json = capture();
    json.deps.sessionsDir = sessionsDir;
    await runEntrypoint(["session", "list", "--format", "json"], json.deps);
    const rows = JSON.parse(json.out.join(""));
    expect(Array.isArray(rows)).toBe(true);
    expect(rows[0].id).toBe("b-second");
    expect(rows[0].entries).toBe(1);
  });

  test("session delete removes the file and rejects unknown ids", async () => {
    const sessionsDir = tempDir("agency-ep-sessions-");
    const store = new SessionStore(sessionsDir);
    await store.append("gone-soon", {
      type: "message",
      parentId: null,
      message: { role: "user", content: [] },
    });

    const ok = capture();
    expect(await runEntrypoint(["session", "delete", "gone-soon"], { sessionsDir, ...ok.deps })).toBe(0);
    expect(existsSync(join(sessionsDir, "gone-soon.jsonl"))).toBe(false);

    const missing = capture();
    expect(await runEntrypoint(["session", "delete", "nope"], { sessionsDir, ...missing.deps })).toBe(1);
    expect(missing.err.join("\n")).toContain("nope");

    const noArg = capture();
    expect(await runEntrypoint(["session", "delete"], { sessionsDir, ...noArg.deps })).toBe(1);
    expect(noArg.err.join("\n")).toContain("usage");
  });

  test("session fork copies entries under a new id and rejects unknown ids", async () => {
    const sessionsDir = tempDir("agency-ep-sessions-");
    const store = new SessionStore(sessionsDir);
    await store.append("source", {
      type: "message",
      parentId: null,
      message: { role: "user", content: [] },
    });

    const ok = capture();
    expect(await runEntrypoint(["session", "fork", "source"], { sessionsDir, ...ok.deps })).toBe(0);
    expect(ok.out.join("\n")).toContain("Forked session source as");
    const forked = store.list().find((id) => id !== "source");
    expect(forked).toBeDefined();
    expect(new SessionStore(sessionsDir).load(forked!).length).toBe(1);

    const json = capture();
    expect(
      await runEntrypoint(["session", "fork", "source", "--format", "json"], { sessionsDir, ...json.deps }),
    ).toBe(0);
    expect(JSON.parse(json.out.join("")).sourceId).toBe("source");

    const missing = capture();
    expect(await runEntrypoint(["session", "fork", "nope"], { sessionsDir, ...missing.deps })).toBe(1);
    expect(missing.err.join("\n")).toContain("nope");

    const noArg = capture();
    expect(await runEntrypoint(["session", "fork"], { sessionsDir, ...noArg.deps })).toBe(1);
    expect(noArg.err.join("\n")).toContain("usage");
  });

  test("session clone copies the file under the given id, or a generated one", async () => {
    const sessionsDir = tempDir("agency-ep-sessions-");
    const store = new SessionStore(sessionsDir);
    await store.append("source", {
      type: "message",
      parentId: null,
      message: { role: "user", content: [] },
    });

    const ok = capture();
    expect(await runEntrypoint(["session", "clone", "source", "copy"], { sessionsDir, ...ok.deps })).toBe(0);
    expect(ok.out.join("\n")).toContain("Cloned session source as copy");
    expect(new SessionStore(sessionsDir).load("copy").length).toBe(1);

    const generated = capture();
    expect(await runEntrypoint(["session", "clone", "source"], { sessionsDir, ...generated.deps })).toBe(0);
    expect(store.list().length).toBe(3);

    const missing = capture();
    expect(await runEntrypoint(["session", "clone", "nope"], { sessionsDir, ...missing.deps })).toBe(1);
    expect(missing.err.join("\n")).toContain("nope");

    const noArg = capture();
    expect(await runEntrypoint(["session", "clone"], { sessionsDir, ...noArg.deps })).toBe(1);
    expect(noArg.err.join("\n")).toContain("usage");
  });

  test("session show reports entries and rejects unknown ids", async () => {
    const sessionsDir = tempDir("agency-ep-sessions-");
    const store = new SessionStore(sessionsDir);
    await store.append("shown", {
      type: "message",
      parentId: null,
      message: { role: "user", content: [] },
    });

    const text = capture();
    expect(await runEntrypoint(["session", "show", "shown"], { sessionsDir, ...text.deps })).toBe(0);
    expect(text.out.join("\n")).toContain("1 entries");

    const json = capture();
    expect(
      await runEntrypoint(["session", "show", "shown", "--format", "json"], { sessionsDir, ...json.deps }),
    ).toBe(0);
    expect(JSON.parse(json.out.join("")).entries).toBe(1);

    const missing = capture();
    expect(await runEntrypoint(["session", "show", "nope"], { sessionsDir, ...missing.deps })).toBe(1);
    expect(missing.err.join("\n")).toContain("nope");
  });
});

describe("auth commands", () => {
  test("auth login stores the key in the keychain", async () => {
    const keysDir = tempDir("agency-ep-keys-");
    const { out, deps } = capture();
    deps.keychain = createFileFallbackBackend(keysDir);
    deps.keyReader = async () => "sk-test-key-123";

    expect(await runEntrypoint(["auth", "login", "openai"], deps)).toBe(0);
    expect(out.join("\n")).toContain("openai");
    expect(await createFileFallbackBackend(keysDir).get("openai")).toBe("sk-test-key-123");
  });

  test("auth login without a provider or with an empty key fails and stores nothing", async () => {
    const keysDir = tempDir("agency-ep-keys-");
    const backend = createFileFallbackBackend(keysDir);

    const noProvider = capture();
    noProvider.deps.keychain = backend;
    expect(await runEntrypoint(["auth", "login"], noProvider.deps)).toBe(1);
    expect(noProvider.err.join("\n")).toContain("usage");

    const emptyKey = capture();
    emptyKey.deps.keychain = backend;
    emptyKey.deps.keyReader = async () => "";
    expect(await runEntrypoint(["auth", "login", "openai"], emptyKey.deps)).toBe(1);
    expect(emptyKey.err.join("\n")).toContain("No key entered");
    expect(await backend.get("openai")).toBeUndefined();
  });

  test("auth list reports each provider's connection state", async () => {
    const keysDir = tempDir("agency-ep-keys-");
    const backend = createFileFallbackBackend(keysDir);
    await backend.set("anthropic", "sk-anthropic");

    const deps: EntrypointDeps = {
      keychain: backend,
      env: { AGENCY_OPENAI_API_KEY: "sk-openai", OPENROUTER_API_KEY: "sk-openrouter" },
      configDir: tempDir("agency-ep-config-"),
    };

    const json = capture();
    await runEntrypoint(["auth", "list", "--format", "json"], { ...deps, ...json.deps });
    const states = JSON.parse(json.out.join(""));
    expect(states).toEqual({
      anthropic: true,
      chatgpt: false,
      deepseek: false,
      google: false,
      groq: false,
      openai: true,
      openrouter: true,
      xai: false,
    });

    const text = capture();
    await runEntrypoint(["auth", "list"], { ...deps, ...text.deps });
    const lines = text.out.join("\n");
    expect(lines).toContain("anthropic: connected");
    expect(lines).toContain("google: not connected");
  });

  test("auth login --oauth runs the OAuth flow for a supported provider", async () => {
    const keysDir = tempDir("agency-ep-keys-");
    const { out, deps } = capture();
    deps.keychain = createFileFallbackBackend(keysDir);
    deps.configDir = tempDir("agency-ep-config-");
    let flowed: string | undefined;
    deps.oauthFlow = async (provider) => {
      flowed = provider;
    };

    expect(await runEntrypoint(["auth", "login", "google", "--oauth"], deps)).toBe(0);
    expect(flowed).toBe("google");
    expect(out.join("\n")).toContain("google");
  });

  test("auth login --oauth rejects providers without an OAuth registry entry", async () => {
    const { err, deps } = capture();
    deps.keychain = createFileFallbackBackend(tempDir("agency-ep-keys-"));
    deps.configDir = tempDir("agency-ep-config-");
    deps.oauthFlow = async () => {};

    expect(await runEntrypoint(["auth", "login", "my-gateway", "--oauth"], deps)).toBe(1);
    expect(err.join("\n")).toContain("my-gateway");
  });

  test("auth login --oauth surfaces a provisioning failure instead of storing", async () => {
    const { err, deps } = capture();
    deps.keychain = createFileFallbackBackend(tempDir("agency-ep-keys-"));
    deps.configDir = tempDir("agency-ep-config-");
    deps.oauthFlow = async () => {
      throw new Error('OAuth not configured for provider "google"');
    };

    expect(await runEntrypoint(["auth", "login", "google", "--oauth"], deps)).toBe(1);
    expect(err.join("\n")).toContain("OAuth not configured");
  });
});

function baseDeps(overrides: Partial<EntrypointDeps> = {}): Partial<EntrypointDeps> {
  return {
    env: { AGENCY_OPENAI_API_KEY: "sk-test" },
    configDir: tempDir("agency-ep-config-"),
    keychain: createFileFallbackBackend(tempDir("agency-ep-keys-")),
    cwd: tempDir("agency-ep-ws-"),
    ...overrides,
  };
}

describe("-p headless mode", () => {
  test("a reply that continued after the output limit prints all its parts, not only the last one", async () => {
    const text = (value: string) => [{ type: "text" as const, text: value }];
    const fake = fakeRunHeadless({
      ...TURN_RESULT,
      messages: [
        { role: "user", content: text("count") },
        { role: "assistant", content: text("1 2 3 ") },
        { role: "user", content: text(OUTPUT_CUT_NOTE) },
        { role: "assistant", content: text("4 5 6") },
      ],
    });
    const { out, deps } = capture();
    const code = await runEntrypoint(["-p", "count", "--model", "openai/fake-1"], {
      ...baseDeps(),
      ...deps,
      runHeadless: fake.runHeadless,
    });

    expect(code).toBe(0);
    expect(out.join("").split(/\s+/)).toEqual(["1", "2", "3", "4", "5", "6"]);
  });

  test("text mode prints the answer, not the sentence that the model wrote before a tool call", async () => {
    const text = (value: string) => [{ type: "text" as const, text: value }];
    const toolRound = [
      { role: "user" as const, content: text("list") },
      {
        role: "assistant" as const,
        content: [
          ...text("Let me generate this with a script"),
          { type: "tool_use" as const, id: "c1", name: "bash", input: { command: "seq 3" } },
        ],
      },
      {
        role: "user" as const,
        content: [
          { type: "tool_result" as const, toolUseId: "c1", content: "permission denied", isError: true },
        ],
      },
    ];
    const printed = async (result: Record<string, unknown>) => {
      const fake = fakeRunHeadless({ ...TURN_RESULT, ...result } as typeof TURN_RESULT);
      const { out, deps } = capture();
      await runEntrypoint(["-p", "list", "--model", "openai/fake-1"], {
        ...baseDeps(),
        ...deps,
        runHeadless: fake.runHeadless,
      });
      return out.join("\n");
    };

    expect({
      finished: await printed({
        messages: [
          ...toolRound,
          { role: "assistant", content: text("one\ntwo ") },
          { role: "user", content: text(OUTPUT_CUT_NOTE) },
          { role: "assistant", content: text("three") },
        ],
      }),
      // A turn that stopped before an answer still shows the text that it has.
      stoppedEarly: await printed({
        messages: toolRound,
        stopReason: "tool_use",
        error: { code: "iteration_limit", message: "stopped after 25 tool steps" },
      }),
    }).toEqual({ finished: "one\ntwo \nthree", stoppedEarly: "Let me generate this with a script" });
  });

  test("a reply that streams in small parts shows as whole lines of progress, not one part per line", async () => {
    const { err, deps } = capture();
    const code = await runEntrypoint(["-p", "hello", "--model", "openai/fake-1"], {
      ...baseDeps(),
      ...deps,
      runHeadless: async (options: RunHeadlessOptions) => {
        for (const text of ["The", " note", " says", " hello", ".", "\n", "Second", " line"]) {
          options.onEvent?.({ type: "text_delta", text });
        }
        options.onEvent?.({ type: "tool_start", name: "read" });
        options.onEvent?.({ type: "text_delta", text: "Done" });
        options.onEvent?.({ type: "turn_complete", stopReason: "end_turn" });
        return TURN_RESULT;
      },
    });

    expect(code).toBe(0);
    expect(err).toEqual([
      "The note says hello.",
      "Second line",
      "Tool: read",
      "Done",
      "Turn complete (end_turn).",
    ]);
  });

  test("an image file that cannot be read stops the run: the prompt does not go out with no image", async () => {
    const fake = fakeRunHeadless();
    const { err, deps } = capture();
    const argv = ["-p", "what colour is this?", "--image", "no-such-file.png", "--model", "openai/fake-1"];
    const code = await runEntrypoint(argv, { ...baseDeps(), ...deps, runHeadless: fake.runHeadless });

    expect(code).toBe(1);
    expect(err.join(" ")).toContain("Cannot read the image file no-such-file.png");
    expect(fake.calls).toHaveLength(0);
  });

  test("a retry shows as a line of progress, so a wait for a rate limit is not silent", async () => {
    const { err, deps } = capture();
    await runEntrypoint(["-p", "hello", "--model", "openai/fake-1"], {
      ...baseDeps(),
      ...deps,
      runHeadless: async (options: RunHeadlessOptions) => {
        options.onEvent?.({ type: "retry", attempt: 2, message: "Rate limit exceeded" });
        options.onEvent?.({ type: "turn_complete", stopReason: "end_turn" });
        return TURN_RESULT;
      },
    });

    expect(err).toEqual(["Retry 2: Rate limit exceeded", "Turn complete (end_turn)."]);
  });

  test("runs one turn through runHeadless and prints the assistant text", async () => {
    const fake = fakeRunHeadless();
    const { out, deps } = capture();
    const code = await runEntrypoint(["-p", "hello", "--model", "openai/fake-1"], {
      ...baseDeps(),
      ...deps,
      runHeadless: fake.runHeadless,
    });

    expect(code).toBe(0);
    expect(out).toEqual(["hi from the fake daemon"]);
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect(call.provider).toBe("openai");
    expect(call.model).toBe("fake-1");
    // A3: the key no longer travels to the daemon; it resolves it itself.
    expect((call as unknown as Record<string, unknown>).apiKey).toBeUndefined();
    expect(call.prompt).toBe("hello");
    expect(call.systemPrompt.length).toBeGreaterThan(0);
  });

  test("--format json emits the full turn result as valid JSON", async () => {
    const fake = fakeRunHeadless();
    const { out, deps } = capture();
    const code = await runEntrypoint(["--print", "hello", "--model", "openai/fake-1", "--format", "json"], {
      ...baseDeps(),
      ...deps,
      runHeadless: fake.runHeadless,
    });

    expect(code).toBe(0);
    const payload = JSON.parse(out.join(""));
    expect(payload.stopReason).toBe("end_turn");
    expect(payload.usage).toEqual({ inputTokens: 3, outputTokens: 2 });
    expect(payload.messages).toHaveLength(2);
  });

  test("a failed turn exits non-zero and names its cause on stderr", async () => {
    const fake = fakeRunHeadless({
      ...TURN_RESULT,
      stopReason: "error",
      error: { code: "network", message: "connection reset" },
    });
    const { err, deps } = capture();
    const code = await runEntrypoint(["-p", "hello", "--model", "openai/fake-1"], {
      ...baseDeps(),
      ...deps,
      runHeadless: fake.runHeadless,
    });
    expect(code).toBe(1);
    expect(err).toContain("network: connection reset");
  });

  test("a run that stops at the step limit exits non-zero and says so", async () => {
    const fake = fakeRunHeadless({
      ...TURN_RESULT,
      stopReason: "tool_use",
      error: { code: "iteration_limit", message: "stopped after 25 tool steps: the task is not finished" },
    });
    const { err, deps } = capture();
    const code = await runEntrypoint(["-p", "hello", "--model", "openai/fake-1"], {
      ...baseDeps(),
      ...deps,
      runHeadless: fake.runHeadless,
    });
    expect(code).toBe(1);
    expect(err).toContain("iteration_limit: stopped after 25 tool steps: the task is not finished");
  });

  test("--format stream-json prints each event as one JSON line, and the result as the last line", async () => {
    const { out, err, deps } = capture();
    const code = await runEntrypoint(["-p", "hello", "--model", "openai/fake-1", "--format", "stream-json"], {
      ...baseDeps(),
      ...deps,
      runHeadless: async (options: RunHeadlessOptions) => {
        options.onEvent?.({ type: "tool_start", id: "c1", name: "read" });
        options.onEvent?.({ type: "text_delta", text: "Done" });
        return TURN_RESULT;
      },
    });
    expect(code).toBe(0);
    expect(err).toEqual([]);
    const lines = out.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.map((line) => line.type)).toEqual(["tool_start", "text_delta", "result"]);
    expect(lines[2]?.stopReason).toBe("end_turn");
    expect(lines[2]?.messages).toEqual(TURN_RESULT.messages);
  });

  test("--max-cost sends the cost limit with the turn", async () => {
    const fake = fakeRunHeadless();
    const { deps } = capture();
    await runEntrypoint(["-p", "hello", "--model", "openai/fake-1", "--max-cost", "0.5"], {
      ...baseDeps(),
      ...deps,
      runHeadless: fake.runHeadless,
    });
    expect(fake.calls[0]?.budget).toEqual({ maxCostUsd: 0.5 });
  });

  test("--system-prompt replaces the base prompt and --append-system-prompt adds to it", async () => {
    const prompts = async (...flags: string[]): Promise<string | undefined> => {
      const fake = fakeRunHeadless();
      await runEntrypoint(["-p", "hello", "--model", "openai/fake-1", ...flags], {
        ...baseDeps(),
        ...capture().deps,
        runHeadless: fake.runHeadless,
      });
      return fake.calls[0]?.systemPrompt;
    };
    expect(await prompts()).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(await prompts("--system-prompt", "You are a reviewer.")).toBe("You are a reviewer.");
    expect(await prompts("--append-system-prompt", "Answer in French.")).toBe(
      `${DEFAULT_SYSTEM_PROMPT}\n\nAnswer in French.`,
    );
    expect(
      await prompts("--system-prompt", "You are a reviewer.", "--append-system-prompt", "Answer in French."),
    ).toBe("You are a reviewer.\n\nAnswer in French.");
  });

  test("--json-schema sends the schema and prints the structured answer, or fails with no answer", async () => {
    const schema = { type: "object", properties: { count: { type: "number" } }, required: ["count"] };
    const run = async (result: RunTurnRpcResult, ...flags: string[]) => {
      const fake = fakeRunHeadless(result);
      const { out, err, deps } = capture();
      const code = await runEntrypoint(
        ["-p", "count", "--model", "openai/fake-1", "--json-schema", JSON.stringify(schema), ...flags],
        { ...baseDeps(), ...deps, runHeadless: fake.runHeadless },
      );
      return { code, call: fake.calls[0], out, err: err.join("\n") };
    };
    const answered: RunTurnRpcResult = {
      ...TURN_RESULT,
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_call", id: "c1", name: "structured_output", input: { count: 7 } }],
        },
        { role: "assistant", content: [{ type: "text", text: "Done." }] },
      ],
    };
    const text = await run(answered);
    expect(text.call?.outputSchema).toEqual(schema);
    expect(text.call?.prompt).toContain("structured_output");
    expect(text.out).toEqual(['{"count":7}']);
    expect(text.code).toBe(0);
    const json = await run(answered, "--format", "json");
    expect(JSON.parse(json.out.join("\n")).structuredOutput).toEqual({ count: 7 });
    const none = await run(TURN_RESULT);
    expect(none.code).toBe(1);
    expect(none.err).toContain("no structured answer");
    expect((await run(answered, "--session", "s1")).code).not.toBe(0);
  });

  test("review sends the diff of the workspace in a turn that cannot change files", async () => {
    const cwd = tempDir("agency-ep-review-");
    const git = (...args: string[]) => {
      const done = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t.invalid", ...args], {
        cwd,
      });
      if (done.exitCode !== 0) throw new Error(done.stderr.toString());
    };
    git("init", "-q", ".");
    writeFileSync(join(cwd, "calc.js"), "export const add = (a, b) => a + b;\n");
    git("add", "calc.js");
    git("commit", "-q", "-m", "start");
    const run = async (...args: string[]) => {
      const fake = fakeRunHeadless();
      const { out, deps } = capture();
      const code = await runEntrypoint(["review", ...args, "--model", "openai/fake-1"], {
        ...baseDeps({ cwd }),
        ...deps,
        runHeadless: fake.runHeadless,
      });
      return { code, call: fake.calls[0], out: out.join("\n") };
    };
    const clean = await run();
    expect(clean.call).toBeUndefined();
    expect(clean.out).toContain("no changes");

    writeFileSync(join(cwd, "calc.js"), "export const add = (a, b) => a - b;\n");
    writeFileSync(join(cwd, "new.js"), "export const x = 1;\n");
    const dirty = await run();
    expect(dirty.code).toBe(0);
    expect(dirty.call?.prompt).toContain("+export const add = (a, b) => a - b;");
    expect(dirty.call?.prompt).toContain("new.js");
    expect(dirty.call?.permissionMode).toBe("ask");

    git("add", "calc.js", "new.js");
    git("commit", "-q", "-m", "change");
    const against = await run("HEAD~1");
    expect(against.call?.prompt).toContain("+export const add = (a, b) => a - b;");
    expect((await run("no-such-ref")).code).not.toBe(0);
  });

  test("--max-cost refuses a value that is not a positive number", async () => {
    const { err, deps } = capture();
    const code = await runEntrypoint(["-p", "hello", "--model", "openai/fake-1", "--max-cost", "free"], {
      ...baseDeps(),
      ...deps,
    });
    expect(code).not.toBe(0);
    expect(err.join("\n")).toContain("--max-cost");
  });

  test("a run that the cost limit stopped exits non-zero and says so", async () => {
    const fake = fakeRunHeadless({ ...TURN_RESULT, budgetExceeded: true });
    const { err, deps } = capture();
    const code = await runEntrypoint(["-p", "hello", "--model", "openai/fake-1", "--max-cost", "0.01"], {
      ...baseDeps(),
      ...deps,
      runHeadless: fake.runHeadless,
    });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("budget_exceeded");
  });

  test("--format json prints a failed run as JSON on stdout: a script must not get empty output", async () => {
    const { out, err, deps } = capture();
    const code = await runEntrypoint(["-p", "hello", "--model", "openai/fake-1", "--format", "json"], {
      ...baseDeps(),
      ...deps,
      runHeadless: async () => {
        throw Object.assign(new Error("Internal Server Error"), { code: "transient" });
      },
    });

    expect(code).toBe(1);
    expect(JSON.parse(out.join(""))).toEqual({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "Internal Server Error",
      error: { code: "transient", message: "Internal Server Error" },
    });
    expect(err).toEqual(["Internal Server Error"]);

    const stream = capture();
    const failing = async () => {
      throw new Error("down");
    };
    const argv = ["-p", "--output-format", "stream-json", "--model", "openai/fake-1", "hello"];
    expect(await runEntrypoint(argv, { ...baseDeps(), ...stream.deps, runHeadless: failing })).toBe(1);
    expect(stream.out).toHaveLength(1);
    expect(JSON.parse(stream.out[0] as string)).toMatchObject({
      type: "result",
      is_error: true,
      result: "down",
    });
  });

  test("-p - takes the prompt from stdin, and an empty stdin is an error", async () => {
    const fake = fakeRunHeadless();
    const { err, deps } = capture();
    const run = (stdin: string) =>
      runEntrypoint(["-p", "-", "--model", "openai/fake-1"], {
        ...baseDeps(),
        ...deps,
        runHeadless: fake.runHeadless,
        stdin: async () => stdin,
      });

    expect(await run("a long prompt\nfrom a pipe\n")).toBe(0);
    expect(fake.calls.map((call) => call.prompt)).toEqual(["a long prompt\nfrom a pipe"]);

    expect(await run("  \n")).toBe(1);
    expect(fake.calls).toHaveLength(1);
    expect(err.join(" ")).toContain("stdin");
  });

  test("--model overrides config.model through the flags layer", async () => {
    const fake = fakeRunHeadless();
    const configDir = tempDir("agency-ep-config-");
    writeFileSync(join(configDir, "config.jsonc"), `{ "schemaVersion": 2, "model": "openai/stale-model" }`);

    const { deps } = capture();
    await runEntrypoint(["-p", "hello", "--model", "anthropic/new-model"], {
      ...baseDeps({ env: { AGENCY_ANTHROPIC_API_KEY: "sk-anthropic" } }),
      ...deps,
      configDir,
      runHeadless: fake.runHeadless,
    });
    expect(fake.calls[0]!.provider).toBe("anthropic");
    expect(fake.calls[0]!.model).toBe("new-model");
  });

  test("--provider overrides only the provider part of config.model", async () => {
    const fake = fakeRunHeadless();
    const configDir = tempDir("agency-ep-config-");
    writeFileSync(join(configDir, "config.jsonc"), `{ "schemaVersion": 2, "model": "openai/gpt-x" }`);

    const { deps } = capture();
    await runEntrypoint(["-p", "hello", "--provider", "anthropic"], {
      ...baseDeps({ env: { AGENCY_ANTHROPIC_API_KEY: "sk-anthropic" } }),
      ...deps,
      configDir,
      runHeadless: fake.runHeadless,
    });
    expect(fake.calls[0]!.provider).toBe("anthropic");
    expect(fake.calls[0]!.model).toBe("gpt-x");
  });

  test("a bare --provider with no config model falls back to the catalog default", async () => {
    const fake = fakeRunHeadless();
    const configDir = tempDir("agency-ep-config-");

    const { deps } = capture();
    await runEntrypoint(["-p", "hello", "--provider", "anthropic"], {
      ...baseDeps({ env: { AGENCY_ANTHROPIC_API_KEY: "sk-anthropic" } }),
      ...deps,
      configDir,
      runHeadless: fake.runHeadless,
    });
    expect(fake.calls[0]!.provider).toBe("anthropic");
    expect(typeof fake.calls[0]!.model).toBe("string");
    expect(fake.calls[0]!.model.length).toBeGreaterThan(0);
  });

  test("a bare --provider for an unknown family still needs --model", async () => {
    const fake = fakeRunHeadless();
    const configDir = tempDir("agency-ep-config-");

    const { err, deps } = capture();
    const code = await runEntrypoint(["-p", "hello", "--provider", "no-such-family"], {
      ...baseDeps(),
      ...deps,
      configDir,
      runHeadless: fake.runHeadless,
    });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("no-such-family");
    expect(fake.calls).toHaveLength(0);
  });

  test("a bare --model id without --provider is rejected, and so is no model at all", async () => {
    const fake = fakeRunHeadless();
    const { err, deps } = capture();
    const code = await runEntrypoint(["-p", "hello", "--model", "just-a-model"], {
      ...baseDeps(),
      ...deps,
      runHeadless: fake.runHeadless,
    });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("provider/model");

    const noModel = capture();
    const code2 = await runEntrypoint(["-p", "hello"], {
      ...baseDeps(),
      ...noModel.deps,
      runHeadless: fake.runHeadless,
    });
    expect(code2).toBe(1);
    expect(noModel.err.join("\n")).toContain("No model configured");
  });

  test("a missing API key is rejected before any daemon work", async () => {
    const fake = fakeRunHeadless();
    const { err, deps } = capture();
    const code = await runEntrypoint(["-p", "hello", "--model", "openai/fake-1"], {
      ...baseDeps({ env: {} }),
      ...deps,
      runHeadless: fake.runHeadless,
    });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("No API key for openai");
    expect(fake.calls).toHaveLength(0);
  });

  test("--session sends text via session_send; the daemon owns persistence", async () => {
    const fake = fakeClient();
    const sessionsDir = tempDir("agency-ep-sessions-");
    const { out, deps } = capture();
    const code = await runEntrypoint(
      ["-p", "new question", "--model", "openai/fake-1", "--session", "target-session", "--format", "json"],
      {
        ...baseDeps(),
        ...deps,
        sessionsDir,
        ensureClient: async () => fake.client,
      },
    );

    expect(code).toBe(0);
    const payload = JSON.parse(out.join(""));
    expect(payload.sessionId).toBe("target-session");
    expect(payload.stopReason).toBe("end_turn");
    expect(payload.tipId).toBe("tip-1");
    const send = fake.calls.find((c) => c.method === "session_send");
    expect(send).toBeDefined();
    expect((send!.params as { sessionId: string }).sessionId).toBe("target-session");
    expect((send!.params as { userText: string }).userText).toBe("new question");
    expect((send!.params as { nonInteractive: boolean }).nonInteractive).toBe(true);
  });

  test("--fork-session runs the turn in a copy of the session, and needs a session", async () => {
    const fake = fakeClient();
    const sessionsDir = tempDir("agency-ep-sessions-");
    const store = new SessionStore(sessionsDir);
    await store.append("base", {
      type: "message",
      parentId: null,
      message: { role: "user", content: [{ type: "text", text: "first" }] },
    });
    const { out, deps } = capture();
    const argv = [
      "-p",
      "-r",
      "base",
      "--fork-session",
      "--model",
      "openai/fake-1",
      "--output-format",
      "json",
      "next",
    ];
    expect(
      await runEntrypoint(argv, {
        ...baseDeps(),
        ...deps,
        sessionsDir,
        ensureClient: async () => fake.client,
      }),
    ).toBe(0);
    const forkId = JSON.parse(out.join("")).session_id as string;
    expect(forkId).toStartWith("base-fork-");
    const send = fake.calls.find((c) => c.method === "session_send");
    expect((send?.params as { sessionId?: string } | undefined)?.sessionId).toBe(forkId);
    expect(store.load(forkId)).toHaveLength(1);
    expect(store.load("base")).toHaveLength(1);
    expect(() => parseArgv(["-p", "x", "--fork-session"])).not.toThrow();
    const bad = capture();
    expect(
      await runEntrypoint(["-p", "x", "--model", "openai/fake-1", "--fork-session"], {
        ...baseDeps(),
        ...bad.deps,
      }),
    ).toBe(1);
    expect(bad.err.join("\n")).toContain("--fork-session needs");
  });

  test("--permission-mode parses, defaults to ask, and reaches the headless call", async () => {
    expect(parseArgv(["-p", "hi"]).permissionMode).toBe("ask");
    expect(parseArgv(["-p", "hi", "--permission-mode", "allow-edits"]).permissionMode).toBe("allow-edits");
    expect(parseArgv(["-p", "hi", "--permission-mode", "allow-all"]).permissionMode).toBe("allow-all");
    expect(parseArgv(["-p", "hi", "--permission-mode", "auto"]).permissionMode).toBe("auto");
    expect(() => parseArgv(["-p", "hi", "--permission-mode", "yes"])).toThrow("permission-mode");
    const fake = fakeRunHeadless();
    const { deps } = capture();
    const code = await runEntrypoint(["-p", "hi", "--model", "openai/fake-1", "--permission-mode", "deny"], {
      ...baseDeps(),
      ...deps,
      runHeadless: fake.runHeadless,
    });
    expect(code).toBe(0);
    expect(fake.calls[0]?.permissionMode).toBe("deny");
  });

  test("--allowed-tools and --disallowedTools become the permission rules of the turn; an unknown rule fails", async () => {
    const parsed = parseArgv([
      "-p",
      "hi",
      "--allowed-tools",
      "Bash(git log,diff *),Read",
      "--disallowedTools=Bash(rm *)",
    ]);
    expect(parsed.allowedTools).toEqual(["Bash(git log,diff *)", "Read"]);
    expect(parsed.disallowedTools).toEqual(["Bash(rm *)"]);
    const headless = fakeRunHeadless();
    const { deps } = capture();
    const code = await runEntrypoint(
      [
        "-p",
        "hi",
        "--model",
        "openai/fake-1",
        "--allowed-tools",
        "Bash(git *),Read",
        "--disallowed-tools",
        "Bash(rm *)",
      ],
      { ...baseDeps(), ...deps, runHeadless: headless.runHeadless },
    );
    expect(code).toBe(0);
    expect(headless.calls[0]?.permissions).toEqual({
      bash: { "git *": "allow", "rm *": "deny" },
      read: "allow",
    });
    const session = fakeClient();
    await runEntrypoint(
      ["-p", "hi", "--model", "openai/fake-1", "--session", "rules", "--allowed-tools", "Edit"],
      {
        ...baseDeps(),
        ...deps,
        sessionsDir: tempDir("agency-ep-sessions-"),
        ensureClient: async () => session.client,
      },
    );
    expect(session.calls.find((call) => call.method === "session_send")?.params).toMatchObject({
      permissions: { edit: "allow" },
    });
    const bad = capture();
    const badCode = await runEntrypoint(
      ["-p", "hi", "--model", "openai/fake-1", "--disallowed-tools", "Read(~/.ssh/**)"],
      { ...baseDeps(), ...bad.deps, runHeadless: headless.runHeadless },
    );
    expect(badCode).toBe(1);
    expect(bad.err.join("\n")).toContain("Read(~/.ssh/**)");
    expect(headless.calls).toHaveLength(1);
  });

  test("--mcp-config gives the MCP servers of a file and of JSON text to the turn; a bad one fails", async () => {
    const cwd = tempDir("agency-ep-mcp-");
    writeFileSync(join(cwd, "servers.json"), JSON.stringify({ mcpServers: { fs: { command: "fs-srv" } } }));
    const headless = fakeRunHeadless();
    const { deps } = capture();
    const json = JSON.stringify({
      docs: { url: "https://d.test/mcp", headers: { "X-Key": `\${DOCS_KEY}` } },
    });
    const argv = [
      "-p",
      "hi",
      "--model",
      "openai/fake-1",
      "--mcp-config",
      "servers.json",
      "--mcp-config",
      json,
    ];
    const env = { ...baseDeps().env, DOCS_KEY: "k-1" };
    expect(
      await runEntrypoint([...argv, "--strict-mcp-config"], {
        ...baseDeps({ cwd, env }),
        ...deps,
        ...headless,
      }),
    ).toBe(0);
    expect(headless.calls[0]?.mcp).toEqual({
      servers: {
        fs: { command: "fs-srv" },
        docs: { url: "https://d.test/mcp", headers: { "X-Key": "k-1" } },
      },
      strict: true,
    });
    await runEntrypoint(["-p", "hi", "--model", "openai/fake-1"], { ...baseDeps(), ...deps, ...headless });
    expect(headless.calls[1]?.mcp).toBeUndefined();
    const bad = capture();
    const code = await runEntrypoint(
      ["-p", "hi", "--model", "openai/fake-1", "--mcp-config", "missing.json"],
      {
        ...baseDeps({ cwd }),
        ...bad.deps,
        ...headless,
      },
    );
    expect(code).toBe(1);
    expect(bad.err.join("\n")).toContain("--mcp-config is not valid");
    expect(headless.calls).toHaveLength(2);
  });

  test("-o writes the answer, or the structured answer, to a file", async () => {
    const file = join(tempDir("agency-ep-last-"), "last.txt");
    const { deps } = capture();
    const argv = ["-p", "hi", "--model", "openai/fake-1", "-o", file];
    expect(await runEntrypoint(argv, { ...baseDeps(), ...deps, ...fakeRunHeadless() })).toBe(0);
    expect(readFileSync(file, "utf8")).toBe("hi from the fake daemon\n");
    const structured = fakeRunHeadless({
      ...TURN_RESULT,
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_call", id: "s1", name: "structured_output", input: { ok: true } }],
        },
      ],
    });
    const schema = JSON.stringify({ type: "object" });
    expect(
      await runEntrypoint([...argv, "--json-schema", schema], { ...baseDeps(), ...deps, ...structured }),
    ).toBe(0);
    expect(readFileSync(file, "utf8")).toBe('{"ok":true}\n');
  });

  test("--tools gives the turn the built-in tools by their names here; default is all, and empty is none", async () => {
    const headless = fakeRunHeadless();
    const { deps } = capture();
    for (const value of ["Bash, Read,TodoWrite", "default", ""]) {
      const argv = ["-p", "hi", "--model", "openai/fake-1", "--tools", value];
      expect(await runEntrypoint(argv, { ...baseDeps(), ...deps, ...headless })).toBe(0);
    }
    expect(headless.calls.map((call) => call.tools)).toEqual([["bash", "read", "todo_write"], undefined, []]);
  });

  test("--thinking reaches the turn, and a level that is not one fails", async () => {
    const headless = fakeRunHeadless();
    const { deps } = capture();
    const argv = ["-p", "hi", "--model", "openai/fake-1", "--thinking", "high"];
    expect(await runEntrypoint(argv, { ...baseDeps(), ...deps, ...headless })).toBe(0);
    expect(headless.calls[0]?.thinkingLevel).toBe("high");
    expect(() => parseArgv(["-p", "hi", "--thinking", "huge"])).toThrow("--thinking must be one of");
  });

  test("the -p flags of Claude Code, codex exec and Pi parse as the flags here", async () => {
    const cc = parseArgv(["-p", "--output-format", "stream-json", "--verbose", "--max-turns", "3", "fix it"]);
    expect([cc.print, cc.streamJson, cc.maxSteps, cc.command]).toEqual(["fix it", true, 3, undefined]);
    expect(parseArgv(["--print"]).print).toBe("-");
    expect(parseArgv(["-p", "-"]).print).toBe("-");
    expect(parseArgv(["-p", "hi"]).print).toBe("hi");
    expect(parseArgv(["-p", "--", "-x y"]).print).toBe("-x y");
    expect(parseArgv(["-p=-x y"]).print).toBe("-x y");
    expect(parseArgv(["-c", "-p", "go on"]).continueLast).toBe(true);
    expect(parseArgv(["-p", "-r", "s-1", "go on"]).session).toBe("s-1");
    expect(parseArgv(["-p", "x", "--session-id", "s-2"]).session).toBe("s-2");
    expect(parseArgv(["-p", "x", "--dangerously-skip-permissions"]).permissionMode).toBe("allow-all");
    const modes = ["default", "dontAsk", "acceptEdits", "plan", "bypassPermissions"].map(
      (mode) => parseArgv(["-p", "x", "--permission-mode", mode]).permissionMode,
    );
    expect(modes).toEqual(["ask", "ask", "allow-edits", "deny", "allow-all"]);
    const codex = parseArgv(["-p", "x", "-C", "repo", "--output-schema", "s.json", "--skip-git-repo-check"]);
    expect([codex.workspace, codex.jsonSchema]).toEqual(["repo", "s.json"]);
    expect(parseArgv(["-p", "x", "--no-tools"]).tools).toBe("");
    const file = join(tempDir("agency-ep-prompt-"), "extra.md");
    writeFileSync(file, "From the file.");
    const prompts = parseArgv([
      "-p",
      "x",
      "--append-system-prompt",
      "Text.",
      "--append-system-prompt-file",
      file,
    ]);
    expect(prompts.appendSystemPrompt).toBe("From the file.\n\nText.");
    expect(parseArgv(["-p", "x", "--system-prompt-file", file]).systemPrompt).toBe("From the file.");
    expect(() => parseArgv(["-p", "x", "--system-prompt-file", `${file}.none`])).toThrow("cannot read");
    const more = parseArgv([
      "-p",
      "x",
      "--max-budget-usd",
      "2.5",
      "--effort",
      "ultracode",
      "--input-format",
      "text",
    ]);
    expect([more.maxCost, more.thinking]).toEqual([2.5, "xhigh"]);
    expect(parseArgv(["-p", "x", "--permission-mode", "manual"]).permissionMode).toBe("ask");
    expect(() => parseArgv(["-p", "x", "--input-format", "stream-json"])).toThrow("--input-format");

    const headless = fakeRunHeadless();
    const { deps, out } = capture();
    const argv = ["-p", "--model", "openai/fake-1", "--output-format", "json", "say hi"];
    expect(await runEntrypoint(argv, { ...baseDeps(), ...deps, ...headless })).toBe(0);
    expect(headless.calls[0]?.prompt).toBe("say hi");
    const payload = JSON.parse(out.join("\n"));
    expect(payload).toMatchObject({ type: "result", subtype: "success", is_error: false, num_turns: 1 });
    expect([payload.result, payload.stopReason]).toEqual(["hi from the fake daemon", "end_turn"]);
  });

  test("codex exec and the flags of codex and pi run as -p", async () => {
    const exec = parseArgv(["exec", "--skip-git-repo-check", "-m", "openai/fake-1", "fix it"]);
    expect([exec.print, exec.command, exec.model]).toEqual(["fix it", undefined, "openai/fake-1"]);
    const last = parseArgv(["exec", "resume", "--last", "go on"]);
    expect([last.print, last.continueLast, last.session]).toEqual(["go on", true, undefined]);
    const byId = parseArgv(["exec", "resume", "s-1", "go on"]);
    expect([byId.print, byId.session, byId.forkSession]).toEqual(["go on", "s-1", false]);
    const fork = parseArgv(["exec", "fork", "s-1", "try"]);
    expect([fork.print, fork.session, fork.forkSession]).toEqual(["try", "s-1", true]);
    expect(() => parseArgv(["exec", "resume"])).toThrow("needs a session id");
    expect(parseArgv(["exec"]).print).toBe("-");
    const codex = parseArgv([
      "-p",
      "x",
      "--json",
      "-i",
      "a.png",
      "--yolo",
      "--ephemeral",
      "--exclude-tools",
      "bash, grep",
    ]);
    expect([codex.streamJson, codex.images, codex.permissionMode, codex.disallowedTools]).toEqual([
      true,
      ["a.png"],
      "allow-all",
      ["bash", "grep"],
    ]);
    const pi = parseArgv(["-p", "x", "--mode", "json", "--no-session", "--fork", "s-2", "-nt"]);
    expect([pi.streamJson, pi.session, pi.forkSession, pi.tools, pi.strictMcpConfig]).toEqual([
      true,
      "s-2",
      true,
      "",
      true,
    ]);

    const headless = fakeRunHeadless();
    const { deps } = capture();
    expect(
      await runEntrypoint(["exec", "--model", "openai/fake-1", "say hi"], {
        ...baseDeps(),
        ...deps,
        ...headless,
      }),
    ).toBe(0);
    expect(headless.calls[0]?.prompt).toBe("say hi");
  });

  test("--fallback-model reaches the turn", async () => {
    const headless = fakeRunHeadless();
    const { deps } = capture();
    const argv = ["-p", "hi", "--model", "openai/fake-1", "--fallback-model", "openai/fake-2"];
    expect(await runEntrypoint(argv, { ...baseDeps(), ...deps, ...headless })).toBe(0);
    expect(headless.calls[0]?.fallbackModel).toBe("openai/fake-2");
    expect(parseArgv(["-p", "x", "--fallback-model", "openai/a, openai/b"]).fallbackModel).toBe("openai/a");
  });

  test("--worktree runs the turn in a git worktree, uses it again, and refuses a bad name", async () => {
    const repo = tempDir("agency-ep-wt-");
    const git = (...args: string[]) =>
      Bun.spawnSync(["git", ...args], { cwd: repo })
        .stdout.toString()
        .trim();
    git("init", "-q");
    git("-c", "user.name=t", "-c", "user.email=t@t.test", "commit", "-q", "--allow-empty", "-m", "init");
    const headless = fakeRunHeadless();
    const { deps, err } = capture();
    const argv = ["-p", "hi", "--model", "openai/fake-1", "-w", "fix-1"];
    expect(await runEntrypoint(argv, { ...baseDeps({ cwd: repo }), ...deps, ...headless })).toBe(0);
    const dir = join(realpathSync(repo), ".agency", "worktrees", "fix-1");
    expect(headless.calls[0]?.workspaceRoot).toBe(dir);
    expect(git("-C", dir, "branch", "--show-current")).toBe("agency/fix-1");
    expect(err.join("\n")).toContain("agency/fix-1");
    expect(await runEntrypoint(argv, { ...baseDeps({ cwd: repo }), ...deps, ...headless })).toBe(0);
    expect(headless.calls[1]?.workspaceRoot).toBe(dir);
    expect(git("status", "--porcelain")).toBe("");

    const bad = capture();
    const code = await runEntrypoint(["-p", "hi", "--model", "openai/fake-1", "--worktree", "../x"], {
      ...baseDeps({ cwd: repo }),
      ...bad.deps,
      ...headless,
    });
    expect(code).toBe(1);
    expect(bad.err.join("\n")).toContain("--worktree name is not valid");
    expect(headless.calls).toHaveLength(2);
  });

  test("--max-steps parses, rejects a bad value, and reaches both kinds of turn", async () => {
    expect(parseArgv(["-p", "hi"]).maxSteps).toBeUndefined();
    expect(parseArgv(["-p", "hi", "--max-steps", "80"]).maxSteps).toBe(80);
    for (const bad of ["0", "-3", "2.5", "many"]) {
      expect(() => parseArgv(["-p", "hi", "--max-steps", bad])).toThrow("--max-steps");
    }

    const headless = fakeRunHeadless();
    const { deps } = capture();
    await runEntrypoint(["-p", "hi", "--model", "openai/fake-1", "--max-steps", "80"], {
      ...baseDeps(),
      ...deps,
      runHeadless: headless.runHeadless,
    });
    expect(headless.calls[0]?.maxToolIterations).toBe(80);

    const session = fakeClient();
    await runEntrypoint(["-p", "hi", "--model", "openai/fake-1", "--session", "steps", "--max-steps", "80"], {
      ...baseDeps(),
      ...deps,
      sessionsDir: tempDir("agency-ep-sessions-"),
      ensureClient: async () => session.client,
    });
    const send = session.calls.find((call) => call.method === "session_send");
    expect(send?.params).toMatchObject({ maxToolIterations: 80 });
  });

  test("a session-backed turn compacts daemon-side; the client sends text only", async () => {
    const fake = fakeClient();
    const sessionsDir = tempDir("agency-ep-sessions-");
    const seed = new SessionStore(sessionsDir);
    seed.create("big-session");
    let parentId: string | null = null;
    for (let i = 0; i < 2; i++) {
      const appended = await seed.append("big-session", {
        type: "message",
        parentId,
        message: { role: "user", content: [{ type: "text", text: `message-${i}` }] },
      });
      parentId = appended.id;
    }
    const { deps } = capture();
    const code = await runEntrypoint(
      ["-p", "follow-up", "--model", "google/fake-1", "--session", "big-session", "--format", "json"],
      {
        ...baseDeps({ env: { AGENCY_GOOGLE_API_KEY: "sk-test" } }),
        ...deps,
        sessionsDir,
        ensureClient: async () => fake.client,
      },
    );

    expect(code).toBe(0);
    const send = fake.calls.find((c) => c.method === "session_send");
    expect(send).toBeDefined();
    expect((send!.params as { sessionId: string }).sessionId).toBe("big-session");
    expect((send!.params as { userText: string }).userText).toBe("follow-up");
  });

  test("--continue resumes the most recent session", async () => {
    const fake = fakeClient();
    const sessionsDir = tempDir("agency-ep-sessions-");
    writeSessionFile(sessionsDir, "older", [entry("e1", null, "older marker", "2026-01-01T00:00:00.000Z")]);
    writeSessionFile(sessionsDir, "newer", [entry("e2", null, "newer marker", "2026-01-02T00:00:00.000Z")]);

    const { deps } = capture();
    const code = await runEntrypoint(["-p", "follow-up", "--model", "openai/fake-1", "--continue"], {
      ...baseDeps(),
      ...deps,
      sessionsDir,
      ensureClient: async () => fake.client,
    });

    expect(code).toBe(0);
    const send = fake.calls.find((c) => c.method === "session_send");
    expect(send).toBeDefined();
    expect((send!.params as { sessionId: string }).sessionId).toBe("newer");
    expect((send!.params as { userText: string }).userText).toBe("follow-up");
  });

  test("a resumed run prints this turn's reply only, not the earlier replies", async () => {
    const text = (role: "user" | "assistant", value: string) => ({
      role,
      content: [{ type: "text" as const, text: value }],
    });
    const fake = fakeClient({
      ...TURN_RESULT,
      messages: [
        text("user", "first question"),
        text("assistant", "first reply"),
        text("user", "follow-up"),
        { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "read", input: {} }] },
        {
          role: "user",
          content: [{ type: "tool_result", toolCallId: "c1", content: "data", isError: false }],
        },
        text("assistant", "second reply"),
      ],
    });
    const sessionsDir = tempDir("agency-ep-sessions-");
    writeSessionFile(sessionsDir, "s", [entry("e1", null, "first question", "2026-01-01T00:00:00.000Z")]);

    const { out, deps } = capture();
    const code = await runEntrypoint(["-p", "follow-up", "--model", "openai/fake-1", "--continue"], {
      ...baseDeps(),
      ...deps,
      sessionsDir,
      ensureClient: async () => fake.client,
    });

    expect(code).toBe(0);
    expect(out).toEqual(["second reply"]);
  });

  test("a command group with no subcommand says that it needs one", async () => {
    // `daemon` is not here: with no subcommand it shows the status.
    for (const group of ["session", "auth", "plugin"]) {
      const { err, deps } = capture();
      const code = await runEntrypoint([group], { ...baseDeps(), ...deps });
      expect(code).toBe(1);
      expect(err.join("\n")).toContain(`"${group}" needs a subcommand`);
      expect(err.join("\n")).not.toContain("(none)");
    }
  });

  test("--continue with no sessions, conflicting session flags, and missing -p all fail clearly", async () => {
    const emptyDir = tempDir("agency-ep-sessions-");
    const none = capture();
    const code = await runEntrypoint(["-p", "hi", "--model", "openai/fake-1", "--continue"], {
      ...baseDeps(),
      ...none.deps,
      sessionsDir: emptyDir,
      ensureClient: async () => fakeClient().client,
    });
    expect(code).toBe(1);
    expect(none.err.join("\n")).toContain("No sessions to continue");
    // A plain -p run keeps no session, so the message says how to get one.
    expect(none.err.join("\n")).toContain("--session <name>");

    const both = capture();
    const code2 = await runEntrypoint(["-p", "hi", "--continue", "--session", "x"], {
      ...baseDeps(),
      ...both.deps,
      sessionsDir: emptyDir,
    });
    expect(code2).toBe(1);
    expect(both.err.join("\n")).toContain("not both");

    const noPrint = capture();
    const code3 = await runEntrypoint(["--continue"], { ...baseDeps(), ...noPrint.deps });
    expect(code3).toBe(1);
    expect(noPrint.err.join("\n")).toContain("-p/--print");
  });

  test("-p combined with a command is rejected", async () => {
    const { err, deps } = capture();
    const code = await runEntrypoint(["where", "-p", "hi"], { ...baseDeps(), ...deps });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("not both");
  });
});

describe("trust", () => {
  test("`agency trust` records the workspace so its instructions load", async () => {
    const home = tempDir("agency-ep-home-");
    const cwd = tempDir("agency-ep-ws-");
    const { out, deps } = capture();
    const code = await runEntrypoint(["trust"], { env: { AGENCY_HOME: home }, cwd, ...deps });
    expect(code).toBe(0);
    expect(out.join(" ")).toContain(cwd);
    expect(createFileTrustStore(join(home, "data", "trust.json")).isTrusted(cwd)).toBe(true);
  });
});

describe("bare agency", () => {
  test("bare `agency` exits 0 with health summary", async () => {
    const { out, deps } = capture();
    const code = await runEntrypoint([], {
      ...baseDeps({ env: { AGENCY_OPENAI_API_KEY: "sk-test" } }),
      ...deps,
    });
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("Agency");
    expect(text).toContain("Model");
    expect(text).toContain("Providers: 1 connected");
    expect(text).toContain("Sessions");
    expect(text).toContain("agency -p");
  });

  test("bare `agency` counts only providers with a resolvable key, as `auth list` does", async () => {
    const shared = baseDeps({ env: {} });
    const bare = capture();
    await runEntrypoint([], { ...shared, ...bare.deps });
    expect(bare.out.join("\n")).toContain("Providers: 0 connected");

    const list = capture();
    await runEntrypoint(["auth", "list", "--format", "json"], { ...shared, ...list.deps });
    expect(Object.values(JSON.parse(list.out.join("\n")))).toEqual(Array(8).fill(false));
  });
});

describe("session fork/show/rename", () => {
  test("session show displays session details", async () => {
    const sessionsDir = tempDir("agency-ep-sessions-");
    writeSessionFile(sessionsDir, "test-sesh", [entry("e1", null, "hello", "2026-01-01T00:00:00.000Z")]);
    const { out, deps } = capture();
    const code = await runEntrypoint(["session", "show", "test-sesh"], { sessionsDir, ...deps });
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("1 entries");
  });

  test("session show with missing id prints usage", async () => {
    const { err, deps } = capture();
    const code = await runEntrypoint(["session", "show"], deps);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("usage: agency session show");
  });

  test("session show with unknown id fails", async () => {
    const { err, deps } = capture();
    const code = await runEntrypoint(["session", "show", "nope"], deps);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("nope");
  });

  test("session rename changes the session title", async () => {
    const sessionsDir = tempDir("agency-ep-sessions-");
    writeSessionFile(sessionsDir, "test-sesh", [entry("e1", null, "hello", "2026-01-01T00:00:00.000Z")]);
    const renameCalls = capture();
    const code = await runEntrypoint(["session", "rename", "test-sesh", "New Title"], {
      sessionsDir,
      ...renameCalls.deps,
    });
    expect(code).toBe(0);
    expect(renameCalls.out.join("\n")).toContain("renamed");
    // Verify the session now has a title
    const store = new (await import("@agency/core")).SessionStore(sessionsDir);
    const entries = store.load("test-sesh");
    expect((await import("@agency/core")).getSessionTitle(entries)).toBe("New Title");
  });

  test("session rename with missing args prints usage", async () => {
    const { err, deps } = capture();
    const code = await runEntrypoint(["session", "rename", "solo"], deps);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("usage: agency session rename");
  });

  test("session rename with empty title is rejected", async () => {
    const sessionsDir = tempDir("agency-ep-sessions-");
    writeSessionFile(sessionsDir, "test-sesh", [entry("e1", null, "hello", "2026-01-01T00:00:00.000Z")]);
    const { err, deps } = capture();
    const code = await runEntrypoint(["session", "rename", "test-sesh", ""], { sessionsDir, ...deps });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("cannot");
  });

  test("session forks a session under a new id", async () => {
    const sessionsDir = tempDir("agency-ep-sessions-");
    writeSessionFile(sessionsDir, "src-sesh", [entry("e1", null, "hello", "2026-01-01T00:00:00.000Z")]);
    const forkCalls = capture();
    const code = await runEntrypoint(["session", "fork", "src-sesh"], { sessionsDir, ...forkCalls.deps });
    expect(code).toBe(0);
    const store = new (await import("@agency/core")).SessionStore(sessionsDir);
    const all = store.list();
    expect(all.length).toBe(2);
    const forkId = all.find((id) => id !== "src-sesh");
    expect(forkId).toBeDefined();
    expect(forkId).toContain("fork");
  });

  test("session fork with missing id prints usage", async () => {
    const { err, deps } = capture();
    const code = await runEntrypoint(["session", "fork"], deps);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("usage: agency session fork");
  });

  test("session --help prints subcommand help", async () => {
    const { out, deps } = capture();
    const code = await runEntrypoint(["session", "--help"], deps);
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("show");
    expect(text).toContain("rename");
    expect(text).toContain("fork");
    expect(text).toContain("delete");
    expect(text).toContain("list");
  });
});

describe("subcommand --help", () => {
  test("storage --help prints storage subcommand list", async () => {
    const { out, deps } = capture();
    const code = await runEntrypoint(["storage", "--help"], deps);
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("prune");
  });

  test("auth --help prints auth subcommand list", async () => {
    const { out, deps } = capture();
    const code = await runEntrypoint(["auth", "--help"], deps);
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("login");
    expect(text).toContain("list");
  });

  test("daemon --help prints daemon subcommand list", async () => {
    const { out, deps } = capture();
    const code = await runEntrypoint(["daemon", "--help"], deps);
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("status");
  });
});

describe("daemon status", () => {
  test("daemon status returns not_running when no daemon", async () => {
    const { out, deps } = capture();
    const ws = tempDir("agency-ep-daemon-");
    deps.cwd = ws;
    const code = await runEntrypoint(["daemon", "status"], deps);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("not running");
  });
});

describe("mcp serve", () => {
  test("serves the agency tool over JSON-RPC: a call is a session turn with the permission mode of the server", async () => {
    const fake = fakeClient();
    const { out, deps } = capture();
    const requests = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "agency", arguments: { prompt: "fix it", model: "openai/fake-2" } },
      },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "agency", arguments: { prompt: "x", session: "../up" } },
      },
      { jsonrpc: "2.0", id: 5, method: "resources/list" },
      { jsonrpc: "2.0", id: 6, method: "initialize", params: { protocolVersion: "1999-01-01" } },
    ];
    const code = await runEntrypoint(
      ["mcp", "serve", "--model", "openai/fake-1", "--permission-mode", "allow-edits"],
      {
        ...baseDeps(),
        ...deps,
        sessionsDir: tempDir("agency-ep-sessions-"),
        ensureClient: async () => fake.client,
        mcpInput: (async function* () {
          for (const request of requests) yield JSON.stringify(request);
        })(),
      },
    );
    expect(code).toBe(0);
    const replies = new Map(out.map((line) => JSON.parse(line)).map((reply) => [reply.id, reply]));
    expect(replies.size).toBe(6);
    expect(replies.get(1).result).toMatchObject({
      protocolVersion: "2025-06-18",
      serverInfo: { name: "agency" },
    });
    expect(replies.get(6).result.protocolVersion).toBe("2025-11-25");
    expect(replies.get(2).result.tools.map((tool: { name: string }) => tool.name)).toEqual(["agency"]);
    const call = replies.get(3).result;
    expect(call.isError).toBe(false);
    expect(call.structuredContent.text).toBe("hi from the fake daemon");
    expect(call.structuredContent.session).toMatch(/^mcp-/);
    expect(replies.get(4).error.code).toBe(-32602);
    expect(replies.get(5).error.code).toBe(-32601);
    const sends = fake.calls.filter((c) => c.method === "session_send");
    expect(sends).toHaveLength(1);
    expect(sends[0]?.params).toMatchObject({
      sessionId: call.structuredContent.session,
      userText: "fix it",
      model: "fake-2",
      permissionMode: "allow-edits",
      nonInteractive: true,
    });
  });

  test("a turn that fails is a tool result with isError, and the server goes on", async () => {
    const { out, deps } = capture();
    const call = (id: number) => ({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "agency", arguments: { prompt: "hi", session: "s1" } },
    });
    await runEntrypoint(["mcp", "serve", "--model", "openai/fake-1"], {
      ...baseDeps({ env: {} }),
      ...deps,
      mcpInput: (async function* () {
        yield JSON.stringify(call(1));
        yield "not json";
        yield JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" });
      })(),
    });
    const replies = out.map((line) => JSON.parse(line));
    expect(replies.find((r) => r.id === 1).result).toMatchObject({
      isError: true,
      structuredContent: { session: "s1" },
    });
    expect(replies.find((r) => r.id === 1).result.content[0].text).toContain("No API key for openai");
    expect(replies.find((r) => r.id === null).error.code).toBe(-32700);
    expect(replies.find((r) => r.id === 2).result).toEqual({});
  });
});

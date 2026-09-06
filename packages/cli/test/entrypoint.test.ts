import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheDir, dataDir, SessionStore } from "@agency/core";
import { createFileFallbackBackend } from "@agency/providers";
import type { DaemonClient } from "@agency/rpc";
import type { RunTurnRpcResult } from "../src/daemon.ts";
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
      env: { AGENCY_OPENAI_API_KEY: "sk-openai" },
      configDir: tempDir("agency-ep-config-"),
    };

    const json = capture();
    await runEntrypoint(["auth", "list", "--format", "json"], { ...deps, ...json.deps });
    const states = JSON.parse(json.out.join(""));
    expect(states).toEqual({ anthropic: true, google: false, openai: true });

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

    expect(await runEntrypoint(["auth", "login", "anthropic", "--oauth"], deps)).toBe(0);
    expect(flowed).toBe("anthropic");
    expect(out.join("\n")).toContain("anthropic");
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
      throw new Error('OAuth not configured for provider "openai"');
    };

    expect(await runEntrypoint(["auth", "login", "openai", "--oauth"], deps)).toBe(1);
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

  test("a failed turn exits non-zero", async () => {
    const fake = fakeRunHeadless({ ...TURN_RESULT, stopReason: "error" });
    const { deps } = capture();
    const code = await runEntrypoint(["-p", "hello", "--model", "openai/fake-1"], {
      ...baseDeps(),
      ...deps,
      runHeadless: fake.runHeadless,
    });
    expect(code).toBe(1);
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

  test("--permission-mode parses, defaults to ask, and reaches the headless call", async () => {
    expect(parseArgv(["-p", "hi"]).permissionMode).toBe("ask");
    expect(parseArgv(["-p", "hi", "--permission-mode", "allow-edits"]).permissionMode).toBe("allow-edits");
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
    expect(text).toContain("Providers");
    expect(text).toContain("Sessions");
    expect(text).toContain("agency -p");
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

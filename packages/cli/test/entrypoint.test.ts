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
  const client: DaemonClient = {
    call: async (method, params) => {
      calls.push({ method, params });
      return result;
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
});

describe("-p headless mode", () => {
  function baseDeps(overrides: Partial<EntrypointDeps> = {}): Partial<EntrypointDeps> {
    return {
      env: { AGENCY_OPENAI_API_KEY: "sk-test" },
      configDir: tempDir("agency-ep-config-"),
      keychain: createFileFallbackBackend(tempDir("agency-ep-keys-")),
      cwd: tempDir("agency-ep-ws-"),
      ...overrides,
    };
  }

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
    expect((call as Record<string, unknown>).apiKey).toBeUndefined();
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

  test("--session persists the turn to the SessionStore", async () => {
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
    expect(typeof payload.tipId).toBe("string");

    const entries = new SessionStore(sessionsDir).load("target-session");
    expect(entries).toHaveLength(2); // user + appended assistant
    const runTurn = fake.calls.find((c) => c.method === "run_turn");
    expect(runTurn).toBeDefined();
    expect((runTurn!.params as { session: unknown[] }).session).toHaveLength(1);
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
    const runTurn = fake.calls.find((c) => c.method === "run_turn");
    const session = JSON.stringify((runTurn!.params as { session: unknown }).session);
    expect(session).toContain("newer marker");
    expect(session).not.toContain("older marker");
    expect(session).toContain("follow-up");
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

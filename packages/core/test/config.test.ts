import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionsGate } from "@agency/guard";
import { configFlags, loadConfig } from "../src/config/loader.ts";
import { type AgentConfig, DEFAULT_ROSTER, parseModelRef } from "../src/config/schema.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "agency-config-test-"));
}

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  test("falls back to defaults with no layers present", () => {
    const dir = tempDir();
    cleanup.push(dir);
    const config = loadConfig({ globalDir: dir, env: {} });
    expect(config.logLevel).toBe("info");
    expect(config.locale).toBe("en");
  });

  test("project config overrides global config", () => {
    const globalDir = tempDir();
    const projectRoot = tempDir();
    cleanup.push(globalDir, projectRoot);

    writeFileSync(join(globalDir, "config.jsonc"), `{ "schemaVersion": 1, "logLevel": "warn" }`);
    mkdirSync(join(projectRoot, ".agency"));
    writeFileSync(
      join(projectRoot, ".agency", "config.jsonc"),
      `{ "schemaVersion": 1, "logLevel": "debug" }`,
    );

    const config = loadConfig({ globalDir, projectRoot, env: {} });
    expect(config.logLevel).toBe("debug");
  });

  test("env var overrides project config", () => {
    const globalDir = tempDir();
    const projectRoot = tempDir();
    cleanup.push(globalDir, projectRoot);

    mkdirSync(join(projectRoot, ".agency"));
    writeFileSync(
      join(projectRoot, ".agency", "config.jsonc"),
      `{ "schemaVersion": 1, "logLevel": "debug" }`,
    );

    const config = loadConfig({
      globalDir,
      projectRoot,
      env: { AGENCY_LOG_LEVEL: "error" },
    });
    expect(config.logLevel).toBe("error");
  });

  test("CLI flags override env vars", () => {
    const globalDir = tempDir();
    cleanup.push(globalDir);

    const config = loadConfig({
      globalDir,
      env: { AGENCY_LOG_LEVEL: "error" },
      flags: { logLevel: "debug" },
    });
    expect(config.logLevel).toBe("debug");
  });

  test("flags.model overrides the global config's model", () => {
    const globalDir = tempDir();
    cleanup.push(globalDir);
    writeFileSync(join(globalDir, "config.jsonc"), `{ "schemaVersion": 2, "model": "openai/gpt-5.2" }`);

    const config = loadConfig({ globalDir, env: {}, flags: { model: "anthropic/claude-haiku-4" } });
    expect(config.model).toBe("anthropic/claude-haiku-4");
  });

  test("configFlags drops unknown keys and undefined values", () => {
    const flags = configFlags({
      model: "openai/gpt-5.2",
      logLevel: undefined,
      notAConfigKey: "noise",
    } as never);
    expect(flags).toEqual({ model: "openai/gpt-5.2" });
  });

  test("AGENCY_GIT_WRITE maps into permissions.git_write; flags layer carries it", () => {
    const globalDir = tempDir();
    cleanup.push(globalDir);
    const fromEnv = loadConfig({ globalDir, env: { AGENCY_GIT_WRITE: "ask" } });
    expect(fromEnv.permissions.git_write).toBe("ask");
    const fromFlags = loadConfig({
      globalDir,
      env: {},
      flags: { permissions: { git_write: "allow" } },
    });
    expect(fromFlags.permissions.git_write).toBe("allow");
  });

  test("AGENCY_GIT_WRITE with an unknown value fails load", () => {
    const globalDir = tempDir();
    cleanup.push(globalDir);
    expect(() => loadConfig({ globalDir, env: { AGENCY_GIT_WRITE: "sometimes" } })).toThrow();
  });

  test("managed config overrides even CLI flags", () => {
    const globalDir = tempDir();
    cleanup.push(globalDir);
    const managedPath = join(globalDir, "managed.jsonc");
    writeFileSync(managedPath, `{ "schemaVersion": 1, "logLevel": "error" }`);

    const config = loadConfig({
      globalDir,
      managedPath,
      env: {},
      flags: { logLevel: "debug" },
    });
    expect(config.logLevel).toBe("error");
  });

  test("migrates a v0 global config forward transparently", () => {
    const globalDir = tempDir();
    cleanup.push(globalDir);
    // v0 predates `locale` entirely, and has no schemaVersion field at all.
    writeFileSync(join(globalDir, "config.jsonc"), `{ "logLevel": "warn" }`);

    const config = loadConfig({ globalDir, env: {} });
    expect(config.schemaVersion).toBe(2);
    expect(config.locale).toBe("en");
    expect(config.logLevel).toBe("warn");
  });

  test("migrates a v1 config to v2, materializing the provider collections", () => {
    const globalDir = tempDir();
    cleanup.push(globalDir);
    writeFileSync(join(globalDir, "config.jsonc"), `{ "schemaVersion": 1, "logLevel": "debug" }`);

    const config = loadConfig({ globalDir, env: {} });
    expect(config.schemaVersion).toBe(2);
    expect(config.provider).toEqual({});
    expect(config.disabled_providers).toEqual([]);
    expect(config.logLevel).toBe("debug");
  });

  test("parses v2 provider config with model overrides and provider sets", () => {
    const globalDir = tempDir();
    cleanup.push(globalDir);
    writeFileSync(
      join(globalDir, "config.jsonc"),
      `{
        "schemaVersion": 2,
        "provider": {
          "openai": { "baseUrl": "https://gateway.internal/v1", "headers": { "x-team": "core" } },
          "my-gateway": {
            "family": "openai-compatible",
            "baseUrl": "http://localhost:8080/v1",
            "models": { "llama-4": { "name": "Llama 4", "contextWindow": 128000 } }
          }
        },
        "model": "openai/gpt-5.2",
        "small_model": "anthropic/claude-haiku-4",
        "disabled_providers": ["google"],
        "enabled_providers": ["openai", "my-gateway"]
      }`,
    );

    const config = loadConfig({ globalDir, env: {} });
    expect(config.provider.openai?.baseUrl).toBe("https://gateway.internal/v1");
    expect(config.provider.openai?.headers).toEqual({ "x-team": "core" });
    expect(config.provider["my-gateway"]?.models?.["llama-4"]?.contextWindow).toBe(128000);
    expect(config.model).toBe("openai/gpt-5.2");
    expect(config.small_model).toBe("anthropic/claude-haiku-4");
    expect(config.disabled_providers).toEqual(["google"]);
    expect(config.enabled_providers).toEqual(["openai", "my-gateway"]);
  });

  test("parseModelRef splits on the first slash only", () => {
    expect(parseModelRef("openai/gpt-5.2")).toEqual({ provider: "openai", model: "gpt-5.2" });
    expect(parseModelRef("openrouter/openai/gpt-5.2")).toEqual({
      provider: "openrouter",
      model: "openai/gpt-5.2",
    });
    expect(parseModelRef("no-slash")).toBeUndefined();
    expect(parseModelRef("/leading")).toBeUndefined();
  });

  test("tolerates JSONC comments", () => {
    const globalDir = tempDir();
    cleanup.push(globalDir);
    writeFileSync(
      join(globalDir, "config.jsonc"),
      `{
        // house style
        "schemaVersion": 1,
        "logLevel": "debug", // trailing comma below is fine too
      }`,
    );

    const config = loadConfig({ globalDir, env: {} });
    expect(config.logLevel).toBe("debug");
  });

  test("a project config's provider record deep-merges over the global one instead of replacing it", () => {
    const globalDir = tempDir();
    const projectRoot = tempDir();
    cleanup.push(globalDir, projectRoot);

    writeFileSync(
      join(globalDir, "config.jsonc"),
      `{
        "schemaVersion": 2,
        "provider": {
          "openai": { "baseUrl": "https://global.example/v1", "headers": { "x-team": "core" } },
          "google": { "baseUrl": "https://google.example/v1" }
        }
      }`,
    );
    mkdirSync(join(projectRoot, ".agency"));
    writeFileSync(
      join(projectRoot, ".agency", "config.jsonc"),
      `{
        "schemaVersion": 2,
        "provider": {
          "openai": { "baseUrl": "https://project.example/v1" }
        }
      }`,
    );

    const config = loadConfig({ globalDir, projectRoot, env: {} });
    // The project's openai override wins per-key...
    expect(config.provider.openai?.baseUrl).toBe("https://project.example/v1");
    // ...but the global openai headers and the whole google entry survive.
    expect(config.provider.openai?.headers).toEqual({ "x-team": "core" });
    expect(config.provider.google?.baseUrl).toBe("https://google.example/v1");
  });

  test("arrays in a higher layer replace lower-layer arrays wholesale", () => {
    const globalDir = tempDir();
    const projectRoot = tempDir();
    cleanup.push(globalDir, projectRoot);

    writeFileSync(
      join(globalDir, "config.jsonc"),
      `{ "schemaVersion": 2, "provider": { "openai": { "whitelist": ["gpt-5.2", "o4"] } } }`,
    );
    mkdirSync(join(projectRoot, ".agency"));
    writeFileSync(
      join(projectRoot, ".agency", "config.jsonc"),
      `{ "schemaVersion": 2, "provider": { "openai": { "whitelist": ["gpt-5.2"] } } }`,
    );

    const config = loadConfig({ globalDir, projectRoot, env: {} });
    expect(config.provider.openai?.whitelist).toEqual(["gpt-5.2"]);
  });

  test("maps additional env vars: model, small model, theme, telemetry, crash reports, provider sets", () => {
    const globalDir = tempDir();
    cleanup.push(globalDir);

    const config = loadConfig({
      globalDir,
      env: {
        AGENCY_MODEL: "anthropic/claude-sonnet-5",
        AGENCY_SMALL_MODEL: "anthropic/claude-haiku-4",
        AGENCY_THEME: "high-contrast",
        AGENCY_TELEMETRY: "1",
        AGENCY_CRASH_REPORTS: "false",
        AGENCY_DISABLED_PROVIDERS: "google, my-gateway",
        AGENCY_ENABLED_PROVIDERS: "openai",
      },
    });
    expect(config.model).toBe("anthropic/claude-sonnet-5");
    expect(config.small_model).toBe("anthropic/claude-haiku-4");
    expect(config.theme).toBe("high-contrast");
    expect(config.telemetryEnabled).toBe(true);
    expect(config.crashReportsEnabled).toBe(false);
    expect(config.disabled_providers).toEqual(["google", "my-gateway"]);
    expect(config.enabled_providers).toEqual(["openai"]);
  });
});

describe("DEFAULT_ROSTER", () => {
  const EXPECTED_HANDLES = [
    "leader",
    "planner",
    "plan-reviewer",
    "coder",
    "executor",
    "explorer",
    "researcher",
    "code-reviewer",
  ];

  /** Mirrors daemon.ts gateForAgent: per-agent map with absentToolsDenied. */
  function gateFor(entry: AgentConfig, workspaceRoot: string): PermissionsGate {
    return new PermissionsGate({
      permissions: (entry.permissions ?? {}) as Record<string, "allow" | "ask" | "deny">,
      workspaceRoot,
      absentToolsDenied: true,
    });
  }

  test("ships the 8-agent starter roster", () => {
    expect(Object.keys(DEFAULT_ROSTER).sort()).toEqual([...EXPECTED_HANDLES].sort());
  });

  test("every roster entry is an enabled {role, provider, model, effort} entry with permissions", () => {
    for (const handle of EXPECTED_HANDLES) {
      const entry = DEFAULT_ROSTER[handle];
      expect(entry).toBeDefined();
      expect(entry!.role).toBe(handle);
      expect(typeof entry!.provider).toBe("string");
      expect(typeof entry!.model).toBe("string");
      expect(typeof entry!.effort).toBe("string");
      expect(entry!.enabled).toBe(true);
      expect(entry!.permissions).toBeDefined();
      expect(Object.keys(entry!.permissions!)).not.toEqual([]);
    }
  });

  test("starter roster spreads providers across vendors", () => {
    const providers = new Set(Object.values(DEFAULT_ROSTER).map((entry) => entry.provider));
    expect(providers.size).toBeGreaterThan(1);
    expect(DEFAULT_ROSTER.leader!.provider).toBe("anthropic");
    expect(DEFAULT_ROSTER.coder!.provider).toBe("anthropic");
  });

  test("fresh config with no agents key gets the 8-agent default roster on load", () => {
    const dir = tempDir();
    cleanup.push(dir);
    const config = loadConfig({ globalDir: dir, env: {} });
    expect(config.agents).toBeDefined();
    expect(Object.keys(config.agents!).sort()).toEqual([...EXPECTED_HANDLES].sort());
    expect(config.agents!.leader?.enabled).toBe(true);
  });

  test("default roster passes validation (leader present and enabled)", () => {
    const dir = tempDir();
    cleanup.push(dir);
    const config = loadConfig({ globalDir: dir, env: {} });
    expect(config.agents!.leader).toBeDefined();
    expect(config.agents!.leader?.enabled).toBe(true);
  });

  test("leader gets full access (Phase 2 gate offers every core + orchestration tool)", () => {
    const dir = tempDir();
    cleanup.push(dir);
    const gate = gateFor(DEFAULT_ROSTER.leader!, dir);
    for (const tool of [
      "read",
      "write",
      "edit",
      "bash",
      "glob",
      "grep",
      "fetch",
      "websearch",
      "dispatch",
      "task",
      "todo_read",
      "todo_write",
      "process_output",
      "process_list",
      "process_kill",
    ]) {
      expect(gate.toolOffered(tool)).toBe(true);
    }
  });

  test("planner gets read/glob/grep plus plans-dir writes, no bash", () => {
    const dir = tempDir();
    cleanup.push(dir);
    const gate = gateFor(DEFAULT_ROSTER.planner!, dir);
    expect(gate.toolOffered("read")).toBe(true);
    expect(gate.toolOffered("glob")).toBe(true);
    expect(gate.toolOffered("grep")).toBe(true);
    expect(gate.toolOffered("bash")).toBe(false);
    expect(gate.toolOffered("edit")).toBe(true);
    expect(gate.decisionFor({ tool: "write", path: ".agency/plans/topic.md" })).toBe("allow");
    expect(gate.decisionFor({ tool: "write", path: "src/a.ts" })).toBe("deny");
    expect(gate.decisionFor({ tool: "edit", path: ".agency/plans/topic.md" })).toBe("allow");
    expect(gate.decisionFor({ tool: "edit", path: "src/a.ts" })).toBe("deny");
  });

  test("planner allow and coder deny maps cover all plan dir spellings", () => {
    expect(DEFAULT_ROSTER.planner!.permissions!.write).toMatchObject({
      "*": "deny",
      ".agency/plans/**": "allow",
      ".opencode/plans/**": "allow",
      ".omo/plans/**": "allow",
    });
    expect(DEFAULT_ROSTER.coder!.permissions!.write).toMatchObject({
      "*": "allow",
      ".agency/plans/**": "deny",
      ".opencode/plans/**": "deny",
      ".omo/plans/**": "deny",
    });
  });

  test("plan-reviewer gets read/glob/grep only", () => {
    const dir = tempDir();
    cleanup.push(dir);
    const gate = gateFor(DEFAULT_ROSTER["plan-reviewer"]!, dir);
    expect(gate.toolOffered("read")).toBe(true);
    expect(gate.toolOffered("glob")).toBe(true);
    expect(gate.toolOffered("grep")).toBe(true);
    expect(gate.toolOffered("bash")).toBe(false);
    expect(gate.toolOffered("write")).toBe(false);
    expect(gate.toolOffered("edit")).toBe(false);
  });

  test("coder gets read/write/edit/bash minus the plans directory", () => {
    const dir = tempDir();
    cleanup.push(dir);
    const gate = gateFor(DEFAULT_ROSTER.coder!, dir);
    for (const tool of ["read", "write", "edit", "bash", "glob", "grep"]) {
      expect(gate.toolOffered(tool)).toBe(true);
    }
    expect(gate.decisionFor({ tool: "write", path: "src/a.ts" })).toBe("allow");
    expect(gate.decisionFor({ tool: "write", path: ".agency/plans/topic.md" })).toBe("deny");
    expect(gate.decisionFor({ tool: "edit", path: "src/a.ts" })).toBe("allow");
    expect(gate.decisionFor({ tool: "edit", path: ".agency/plans/topic.md" })).toBe("deny");
  });

  test("executor gets bash plus background-process tools, no write/edit", () => {
    const dir = tempDir();
    cleanup.push(dir);
    const gate = gateFor(DEFAULT_ROSTER.executor!, dir);
    expect(gate.toolOffered("bash")).toBe(true);
    expect(gate.toolOffered("process_output")).toBe(true);
    expect(gate.toolOffered("process_list")).toBe(true);
    expect(gate.toolOffered("process_kill")).toBe(true);
    expect(gate.toolOffered("write")).toBe(false);
    expect(gate.toolOffered("edit")).toBe(false);
  });

  test("explorer gets read/glob/grep only", () => {
    const dir = tempDir();
    cleanup.push(dir);
    const gate = gateFor(DEFAULT_ROSTER.explorer!, dir);
    expect(gate.toolOffered("read")).toBe(true);
    expect(gate.toolOffered("glob")).toBe(true);
    expect(gate.toolOffered("grep")).toBe(true);
    expect(gate.toolOffered("bash")).toBe(false);
    expect(gate.toolOffered("write")).toBe(false);
    expect(gate.toolOffered("edit")).toBe(false);
  });

  test("researcher gets fetch/websearch only, no codebase read", () => {
    const dir = tempDir();
    cleanup.push(dir);
    const gate = gateFor(DEFAULT_ROSTER.researcher!, dir);
    expect(gate.toolOffered("fetch")).toBe(true);
    expect(gate.toolOffered("websearch")).toBe(true);
    expect(gate.toolOffered("read")).toBe(false);
    expect(gate.toolOffered("bash")).toBe(false);
    expect(gate.toolOffered("write")).toBe(false);
    expect(gate.toolOffered("edit")).toBe(false);
    expect(gate.toolOffered("glob")).toBe(false);
    expect(gate.toolOffered("grep")).toBe(false);
  });

  test("code-reviewer gets read/glob/grep plus bash, no write/edit", () => {
    const dir = tempDir();
    cleanup.push(dir);
    const gate = gateFor(DEFAULT_ROSTER["code-reviewer"]!, dir);
    expect(gate.toolOffered("read")).toBe(true);
    expect(gate.toolOffered("glob")).toBe(true);
    expect(gate.toolOffered("grep")).toBe(true);
    expect(gate.toolOffered("bash")).toBe(true);
    expect(gate.toolOffered("write")).toBe(false);
    expect(gate.toolOffered("edit")).toBe(false);
  });

  test("user-supplied agents in config are NOT overridden by DEFAULT_ROSTER", () => {
    const dir = tempDir();
    cleanup.push(dir);
    writeFileSync(
      join(dir, "config.jsonc"),
      JSON.stringify({
        schemaVersion: 2,
        agents: {
          leader: { role: "leader", provider: "openai", model: "gpt-5.2", effort: "high", enabled: true },
        },
      }),
    );
    const config = loadConfig({ globalDir: dir, env: {} });
    expect(config.agents).toBeDefined();
    expect(Object.keys(config.agents!)).toEqual(["leader"]);
    expect(config.agents!.leader?.role).toBe("leader");
  });

  test("enabled defaults to false when not specified", () => {
    const dir = tempDir();
    cleanup.push(dir);
    writeFileSync(
      join(dir, "config.jsonc"),
      JSON.stringify({
        schemaVersion: 2,
        agents: {
          leader: { role: "leader", provider: "anthropic", effort: "high", enabled: true },
          helper: { role: "helper", provider: "openai", effort: "low" },
        },
      }),
    );
    const config = loadConfig({ globalDir: dir, env: {} });
    expect(config.agents!.leader?.enabled).toBe(true);
    expect(config.agents!.helper?.enabled).toBe(false);
  });

  test("disabled agent is not registered in team (config still has it)", () => {
    const dir = tempDir();
    cleanup.push(dir);
    writeFileSync(
      join(dir, "config.jsonc"),
      JSON.stringify({
        schemaVersion: 2,
        agents: {
          leader: { role: "leader", provider: "anthropic", effort: "high", enabled: true },
          helper: { role: "helper", provider: "openai", effort: "low", enabled: false },
        },
      }),
    );
    const config = loadConfig({ globalDir: dir, env: {} });
    expect(config.agents!.leader?.enabled).toBe(true);
    expect(config.agents!.helper?.enabled).toBe(false);
  });

  test("leader disabled causes validation error", () => {
    const dir = tempDir();
    cleanup.push(dir);
    writeFileSync(
      join(dir, "config.jsonc"),
      JSON.stringify({
        schemaVersion: 2,
        agents: {
          leader: { role: "leader", provider: "anthropic", effort: "high", enabled: false },
        },
      }),
    );
    expect(() => loadConfig({ globalDir: dir, env: {} })).toThrow("leader agent must be enabled");
  });

  test("missing leader causes validation error when agents are configured", () => {
    const dir = tempDir();
    cleanup.push(dir);
    writeFileSync(
      join(dir, "config.jsonc"),
      JSON.stringify({
        schemaVersion: 2,
        agents: {
          helper: { role: "helper", provider: "openai", effort: "low", enabled: true },
        },
      }),
    );
    expect(() => loadConfig({ globalDir: dir, env: {} })).toThrow("leader agent is required");
  });

  test("zero enabled agents causes validation error", () => {
    const dir = tempDir();
    cleanup.push(dir);
    writeFileSync(
      join(dir, "config.jsonc"),
      JSON.stringify({
        schemaVersion: 2,
        agents: {
          leader: { role: "leader", provider: "anthropic", effort: "high", enabled: false },
          helper: { role: "helper", provider: "openai", effort: "low", enabled: false },
        },
      }),
    );
    expect(() => loadConfig({ globalDir: dir, env: {} })).toThrow("at least one agent must be enabled");
  });

  test("default roster passes validation (leader present and enabled)", () => {
    const dir = tempDir();
    cleanup.push(dir);
    const config = loadConfig({ globalDir: dir, env: {} });
    expect(config.agents).toBeDefined();
    expect(Object.keys(config.agents!).length).toBe(8);
  });

  test("provider is optional — agent can be defined without provider", () => {
    const dir = tempDir();
    cleanup.push(dir);
    writeFileSync(
      join(dir, "config.jsonc"),
      JSON.stringify({
        schemaVersion: 2,
        agents: {
          leader: { role: "leader", provider: "anthropic", effort: "high", enabled: true },
          helper: { role: "helper" },
        },
      }),
    );
    const config = loadConfig({ globalDir: dir, env: {} });
    expect(config.agents!.leader?.provider).toBe("anthropic");
    expect(config.agents!.helper?.provider).toBeUndefined();
  });
});

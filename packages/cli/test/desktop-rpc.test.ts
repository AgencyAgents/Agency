import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileTrustStore } from "@agency/guard";
import type { HttpClient } from "@agency/net";
import type { KeychainBackend, ProviderAdapter, StreamEvent } from "@agency/providers";
import { hashWorkspaceRoot } from "@agency/rpc";
import { type AgentDaemon, createAgentDaemon } from "../src/daemon.ts";

interface SkillRow {
  name: string;
  body: string;
  origin: string;
  [key: string]: unknown;
}

const daemons: AgentDaemon[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `agency-desktop-rpc-${name}-`));
  dirs.push(dir);
  return dir;
}

function memoryKeychain(): KeychainBackend & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    name: "memory",
    store,
    isAvailable: async () => true,
    set: async (account, secret) => void store.set(account, secret),
    get: async (account) => store.get(account),
    delete: async (account) => void store.delete(account),
  };
}

let release: () => void = () => {};
const gatedAdapter: ProviderAdapter = {
  family: "fake",
  async *stream(): AsyncIterable<StreamEvent> {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    yield { type: "text_delta", text: "ok" };
    yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
  },
};

async function start(
  extra: {
    status?: number;
    onIdleShutdown?: () => void;
    configText?: string;
    project?: Record<string, string>;
    user?: Record<string, string>;
    untrusted?: boolean;
  } = {},
) {
  const workspaceRoot = tmp("ws");
  const configDir = tmp("config");
  const keychain = memoryKeychain();
  const trustStorePath = join(tmp("trust"), "trust.json");
  if (!extra.untrusted) createFileTrustStore(trustStorePath).trust(workspaceRoot);
  if (extra.configText !== undefined) writeFileSync(join(configDir, "config.jsonc"), extra.configText);
  for (const [name, text] of Object.entries(extra.project ?? {})) {
    mkdirSync(join(workspaceRoot, ".agency", "skills", name), { recursive: true });
    writeFileSync(join(workspaceRoot, ".agency", "skills", name, "SKILL.md"), text);
  }
  for (const [name, text] of Object.entries(extra.user ?? {})) {
    mkdirSync(join(configDir, "skills", name), { recursive: true });
    writeFileSync(join(configDir, "skills", name, "SKILL.md"), text);
  }
  const http: HttpClient = { fetch: async () => new Response("{}", { status: extra.status ?? 200 }) };
  const daemon = await createAgentDaemon({
    workspaceRoot,
    configDir,
    instanceFile: join(tmp("instances"), `${hashWorkspaceRoot(workspaceRoot)}.json`),
    sessionsDir: tmp("sess"),
    approvalsDir: tmp("approvals"),
    trustStorePath,
    adapterFor: () => gatedAdapter,
    http,
    keychain,
    tools: [],
    ...(extra.onIdleShutdown ? { onIdleShutdown: extra.onIdleShutdown } : {}),
  });
  daemons.push(daemon);
  const base = `http://127.0.0.1:${daemon.httpPort}`;
  const call = async (method: string, params: unknown = {}) => {
    const res = await fetch(`${base}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${daemon.server.token}` },
      body: JSON.stringify({ id: 1, method, params }),
    });
    return (await res.json()) as { result?: Record<string, unknown>; error?: { message: string } };
  };
  return { daemon, workspaceRoot, configDir, keychain, call, configFile: join(configDir, "config.jsonc") };
}

test("config_write creates the user config, keeps a comment, and null removes the key", async () => {
  const { call, configFile } = await start({
    configText: '{\n  // keep me\n  "sandbox": { "backend": "software" },\n  "logLevel": "info"\n}\n',
  });
  const written = await call("config_write", { key: "sandbox.backend", value: "os" });
  expect(written.result).toEqual({ key: "sandbox.backend", value: "os", file: configFile });
  const text = readFileSync(configFile, "utf8");
  expect(text).toContain("// keep me");
  expect(text).toContain('"backend": "os"');
  expect(text).toContain('"logLevel": "info"');

  await call("config_write", { key: "logLevel", value: null });
  expect(readFileSync(configFile, "utf8")).not.toContain("logLevel");
  expect(readFileSync(configFile, "utf8")).toContain("// keep me");
});

test("config_write makes the file when it is absent", async () => {
  const { call, configFile } = await start();
  expect(existsSync(configFile)).toBe(false);
  await call("config_write", { key: "skills.disabled", value: ["a"] });
  expect(JSON.parse(readFileSync(configFile, "utf8"))).toEqual({ skills: { disabled: ["a"] } });
});

test("config_write restores the file when the value breaks the config", async () => {
  const original = '{\n  // keep me\n  "logLevel": "info"\n}\n';
  const { call, configFile } = await start({ configText: original });
  const bad = await call("config_write", { key: "sandbox.backend", value: "bogus" });
  expect(bad.error?.message).toContain("config is not valid");
  expect(readFileSync(configFile, "utf8")).toBe(original);
});

test("config_write on an absent file leaves none after a bad value", async () => {
  const { call, configFile } = await start();
  const bad = await call("config_write", { key: "sandbox.backend", value: "bogus" });
  expect(bad.error).toBeDefined();
  expect(existsSync(configFile)).toBe(false);
});

test("daemon_restart waits for a running turn, then leaves once", async () => {
  let shutdowns = 0;
  const { call, keychain } = await start({ onIdleShutdown: () => shutdowns++ });
  await keychain.set("anthropic", "test-key");
  const turn = call("session_send", {
    sessionId: "s1",
    provider: "anthropic",
    model: "m",
    userText: "hi",
  });
  await Bun.sleep(300);
  const first = await call("daemon_restart");
  expect(first.result).toEqual({ restarting: true, activeTurns: 1 });
  expect((await call("daemon_restart")).result?.restarting).toBe(true);

  await Bun.sleep(1_500);
  expect(shutdowns).toBe(0);

  release();
  await turn;
  await Bun.sleep(1_500);
  expect(shutdowns).toBe(1);
}, 15_000);

test("provider_connect validates, then stores in the key store; provider_disconnect removes it", async () => {
  const { call, keychain } = await start();
  const connected = await call("provider_connect", { providerId: "openai", apiKey: "sk-test" });
  expect(connected.result).toEqual({ providerId: "openai", storedIn: "memory", verified: true });
  expect(keychain.store.get("openai")).toBe("sk-test");

  const gone = await call("provider_disconnect", { providerId: "openai" });
  expect(gone.result).toEqual({ providerId: "openai", removed: true });
  expect(keychain.store.has("openai")).toBe(false);
});

test("provider_connect refuses a rejected key and a bad id, and stores nothing", async () => {
  const { call, keychain } = await start({ status: 401 });
  const rejected = await call("provider_connect", { providerId: "openai", apiKey: "bad" });
  expect(rejected.error?.message).toBe("the provider rejected the key");
  const badId = await call("provider_connect", { providerId: "Not Valid", apiKey: "k" });
  expect(badId.error?.message).toContain("invalid provider id");
  expect(keychain.store.size).toBe(0);
});

test("provider_disconnect names the environment variable of a key it cannot remove", async () => {
  process.env.ACME_API_KEY = "from-env";
  try {
    const { call } = await start();
    const res = await call("provider_disconnect", { providerId: "acme" });
    expect(res.result?.removed).toBe(false);
    expect(String(res.result?.reason)).toContain("ACME_API_KEY");
  } finally {
    delete process.env.ACME_API_KEY;
  }
});

const projectSkill =
  "---\nname: deploy\ndescription: Ship it\nallowed-tools: Read, Bash(git *)\ncontext: fork\n---\n\nRun the deploy.\n";
const userSkill = "---\nname: notes\ndescription: Take notes\n---\n\nWrite notes.\n";

test("skills_list lists project and user skills with origin and enabled", async () => {
  const { call, workspaceRoot, configDir } = await start({
    project: { deploy: projectSkill },
    user: { notes: userSkill },
    configText: '{ "skills": { "disabled": ["notes"] } }',
  });
  const { skills, trusted } = (await call("skills_list")).result as { skills: SkillRow[]; trusted: boolean };
  expect(trusted).toBe(true);
  const deploy = skills.find((s) => s.name === "deploy");
  const notes = skills.find((s) => s.name === "notes");
  expect(deploy).toMatchObject({
    description: "Ship it",
    path: join(workspaceRoot, ".agency", "skills", "deploy", "SKILL.md"),
    tier: "project",
    origin: "This workspace",
    allowedTools: ["Read", "Bash(git *)"],
    fork: true,
    userInvocable: true,
    modelInvocable: true,
    enabled: true,
  });
  expect(deploy?.body).toContain("Run the deploy.");
  expect(notes).toMatchObject({
    tier: "user",
    origin: "Your user folder",
    fork: false,
    allowedTools: [],
    enabled: false,
    path: join(configDir, "skills", "notes", "SKILL.md"),
  });
});

test("skills_list of an untrusted folder says so and hides its project skills", async () => {
  const { call } = await start({
    project: { deploy: projectSkill },
    user: { notes: userSkill },
    untrusted: true,
  });
  const { skills, trusted } = (await call("skills_list")).result as { skills: SkillRow[]; trusted: boolean };
  expect(trusted).toBe(false);
  expect(skills.map((s) => s.name)).toEqual(["notes"]);
});

test("skills_list names a skill of another agent by its tool", async () => {
  const { call, workspaceRoot } = await start();
  mkdirSync(join(workspaceRoot, ".claude", "skills", "foreign"), { recursive: true });
  writeFileSync(
    join(workspaceRoot, ".claude", "skills", "foreign", "SKILL.md"),
    "---\nname: foreign\n---\nx\n",
  );
  const { skills } = (await call("skills_list")).result as { skills: SkillRow[] };
  expect(skills.find((s) => s.name === "foreign")?.origin).toBe("Claude Code");
});

test("skill_write writes frontmatter, refuses an overwrite and a bad name", async () => {
  const { call, workspaceRoot, configDir } = await start();
  const project = await call("skill_write", {
    scope: "project",
    name: "my-skill",
    description: "Does: things",
    fork: true,
    allowedTools: ["Read", "Bash(git *)"],
    body: "Do it.",
  });
  const path = join(workspaceRoot, ".agency", "skills", "my-skill", "SKILL.md");
  expect(project.result).toEqual({ path });
  const text = readFileSync(path, "utf8");
  expect(text).toContain("name: my-skill");
  expect(text).toContain('description: "Does: things"');
  expect(text).toContain("context: fork");
  expect(text.endsWith("Do it.\n")).toBe(true);

  const listed = ((await call("skills_list")).result as { skills: SkillRow[] }).skills.find(
    (s) => s.name === "my-skill",
  );
  expect(listed).toMatchObject({
    description: "Does: things",
    fork: true,
    allowedTools: ["Read", "Bash(git *)"],
  });

  const again = await call("skill_write", { scope: "project", name: "my-skill", body: "other" });
  expect(again.error?.message).toContain("exists already");
  expect(readFileSync(path, "utf8")).toBe(text);

  for (const name of ["Bad", "-x", "a b", "../up", ""]) {
    expect((await call("skill_write", { scope: "user", name, body: "x" })).error).toBeDefined();
  }
  const user = await call("skill_write", { scope: "user", name: "u1", body: "x" });
  expect(user.result?.path).toBe(join(configDir, "skills", "u1", "SKILL.md"));
});

const commandNames = (res: { result?: Record<string, unknown> }): string[] =>
  (res.result as { commands: Array<{ name: string }> }).commands.map((c) => c.name);

test("a disabled skill does not appear in commands_list", async () => {
  const both = { project: { deploy: projectSkill }, user: { notes: userSkill } };
  const on = await start(both);
  const names = commandNames(await on.call("commands_list"));
  expect(names).toContain("deploy");
  expect(names).toContain("notes");

  const off = await start({ ...both, configText: '{ "skills": { "disabled": ["deploy"] } }' });
  const left = commandNames(await off.call("commands_list"));
  expect(left).not.toContain("deploy");
  expect(left).toContain("notes");
});

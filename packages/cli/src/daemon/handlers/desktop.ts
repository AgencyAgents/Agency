import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import {
  configDir,
  discoverSkills,
  foreignHome,
  loadConfig,
  memoryFile,
  resolveSkillDirs,
  userPluginStore,
} from "@agency/core";
import { envNames, oauthKey } from "@agency/providers";
import type { MethodHandler } from "@agency/rpc";
import { AgencyError, ErrorCode } from "@agency/schema";
import { readMemoryNotes, writeMemoryNotes } from "@agency/tools";
import { applyEdits, modify, parse } from "jsonc-parser";
import { createHttpValidator, isValidProviderId } from "../../connect.ts";
import type { DaemonContext } from "../types.ts";

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const RESTART_POLL_MS = 1_000;

/** Labels of the skill folders of other agents, by the folder that holds the `skills` directory. */
const FOREIGN_ORIGINS: Array<[string, string]> = [
  [".claude", "Claude Code"],
  [".agents", "Shared agents"],
  [".codex", "Codex"],
  [".cursor", "Cursor"],
  [".pi", "Pi"],
  [".opencode", "OpenCode"],
  [".config/opencode", "OpenCode"],
  [".gemini", "Gemini"],
  [".github", "Copilot"],
];

function invalid(message: string): AgencyError {
  return new AgencyError(ErrorCode.INVALID_REQUEST, message, { source: "desktop" });
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== "string" || value.trim() === "") throw invalid(`${what} must be a non-empty string`);
  return value;
}

/** Short human label for the folder a skill file came from. */
function skillOrigin(path: string, workspaceRoot: string, userDir: string, pluginStore: string): string {
  const inside = (dir: string): boolean => resolve(path).startsWith(resolve(dir) + sep);
  if (inside(join(workspaceRoot, ".agency", "skills")) || inside(join(workspaceRoot, "skills")))
    return "This workspace";
  if (inside(join(pluginStore, ".agency", "skills"))) return "Plugins";
  if (inside(join(userDir, "skills"))) return "Your user folder";
  const home = foreignHome();
  for (const base of [workspaceRoot, ...(home === undefined ? [] : [home])]) {
    for (const [folder, label] of FOREIGN_ORIGINS) {
      if (inside(join(base, ...folder.split("/"), "skills"))) return label;
      if (folder === ".pi" && inside(join(base, ".pi", "agent", "skills"))) return label;
    }
  }
  return "Other";
}

/** One scalar of the frontmatter, quoted when plain YAML would misread it. */
function yamlScalar(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return /[:#"'[\]{}&*!|>%@`]|^[-?]/.test(line) ? JSON.stringify(line) : line;
}

/**
 * The methods that the desktop app needs: user config writes, a daemon restart, provider keys and skills.
 * Returns a disposer for the restart poll.
 */
export function registerDesktopHandlers(
  handlers: Record<string, MethodHandler>,
  ctx: DaemonContext,
  extra: { leave: () => void },
): () => void {
  const { options } = ctx;
  const userDir = (): string => options.configDir ?? configDir();
  let restartTimer: ReturnType<typeof setInterval> | undefined;

  handlers.config_write = async (rawParams) => {
    const { key, value } = (rawParams ?? {}) as { key?: unknown; value?: unknown };
    const path = requireString(key, "config_write key").split(".");
    if (path.some((part) => !/^[\w-]+$/.test(part))) throw invalid(`config_write: bad key ${String(key)}`);
    if (value === undefined) throw invalid("config_write requires value (null removes the key)");

    const file = join(userDir(), "config.jsonc");
    const previous = existsSync(file) ? readFileSync(file, "utf8") : undefined;
    const text = previous ?? "{}";
    const edits = modify(text, path, value ?? undefined, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: text.includes("\r\n") ? "\r\n" : "\n" },
    });
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, applyEdits(text, edits), "utf8");
    try {
      loadConfig({ globalDir: userDir(), env: process.env, projectRoot: options.workspaceRoot });
    } catch (error) {
      if (previous === undefined) rmSync(file, { force: true });
      else writeFileSync(file, previous, "utf8");
      throw invalid(error instanceof Error ? error.message : String(error));
    }
    return { key, value, file };
  };

  /** The user file alone: an editor that writes back a whole key must not copy project or environment values. */
  handlers.config_user = async () => {
    const file = join(userDir(), "config.jsonc");
    const raw: unknown = existsSync(file) ? parse(readFileSync(file, "utf8")) : {};
    const { provider: _keys, ...config } = (
      raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}
    ) as Record<string, unknown>;
    return { config, file };
  };

  handlers.daemon_restart = async () => {
    // The poll runs once: a second call only reports the turns that still run.
    restartTimer ??= setInterval(() => {
      if (ctx.activeControllers.size > 0) return;
      clearInterval(restartTimer);
      extra.leave();
    }, RESTART_POLL_MS);
    restartTimer.unref?.();
    return { restarting: true, activeTurns: ctx.activeControllers.size };
  };

  handlers.memory_get = async () => {
    const path = ctx.memoryFile ?? memoryFile(options.workspaceRoot);
    return { enabled: ctx.config.memory !== false, path, notes: readMemoryNotes(path) };
  };

  handlers.memory_remove = async (rawParams) => {
    const note = ((rawParams ?? {}) as { note?: unknown }).note;
    if (typeof note !== "string" || note === "")
      throw invalid("memory_remove note must be a non-empty string");
    const path = ctx.memoryFile ?? memoryFile(options.workspaceRoot);
    const notes = readMemoryNotes(path);
    const index = notes.indexOf(note);
    if (index === -1) return { removed: false, notes };
    notes.splice(index, 1);
    writeMemoryNotes(path, notes);
    return { removed: true, notes };
  };

  handlers.provider_connect = async (rawParams) => {
    const params = (rawParams ?? {}) as { providerId?: unknown; apiKey?: unknown };
    const providerId = requireString(params.providerId, "provider_connect providerId");
    const apiKey = requireString(params.apiKey, "provider_connect apiKey").trim();
    if (!isValidProviderId(providerId)) throw invalid(`invalid provider id: ${providerId}`);

    const baseUrls: Record<string, string> = {};
    for (const [id, provider] of Object.entries(ctx.providers))
      if (provider.baseUrl !== undefined) baseUrls[id] = provider.baseUrl;
    if (!(await createHttpValidator(ctx.http, baseUrls)(providerId, apiKey)))
      throw invalid("the provider rejected the key");

    const keychain = await ctx.getKeychain();
    if (keychain === undefined)
      throw new AgencyError(ErrorCode.INTERNAL, "no key store available", { source: "desktop" });
    await keychain.set(providerId, apiKey);
    ctx.redactor.registerSecret(apiKey);
    return { providerId, storedIn: keychain.name, verified: true };
  };

  handlers.provider_disconnect = async (rawParams) => {
    const providerId = requireString(
      ((rawParams ?? {}) as { providerId?: unknown }).providerId,
      "provider_disconnect providerId",
    );
    if (!isValidProviderId(providerId)) throw invalid(`invalid provider id: ${providerId}`);
    const keychain = await ctx.getKeychain();
    if (keychain === undefined)
      throw new AgencyError(ErrorCode.INTERNAL, "no key store available", { source: "desktop" });

    const stored = (await keychain.get(providerId)) !== undefined;
    const signedIn = (await keychain.get(oauthKey(providerId))) !== undefined;
    if (stored) await keychain.delete(providerId);
    if (signedIn) await keychain.delete(oauthKey(providerId));
    const variable = envNames(providerId, ctx.providers[providerId]?.env).find((name) => process.env[name]);
    const removed = stored || signedIn;
    if (variable !== undefined)
      return { providerId, removed, reason: `a key still comes from the environment variable ${variable}` };
    return removed ? { providerId, removed } : { providerId, removed, reason: "no stored key" };
  };

  handlers.skills_list = async () => {
    const root = options.workspaceRoot;
    const trusted = ctx.trustStore.isTrusted(root);
    // The config file, not the config of the start: a toggle shows before the restart that applies it.
    let disabled = ctx.config.skills?.disabled ?? [];
    try {
      disabled =
        loadConfig({ globalDir: userDir(), env: process.env, projectRoot: root }).skills?.disabled ?? [];
    } catch {}
    const pluginStore = userPluginStore(options.configDir);
    const skills = discoverSkills(
      resolveSkillDirs(root, options.configDir).filter((entry) => trusted || entry.tier !== "project"),
    );
    return {
      trusted,
      skills: skills.map((skill) => ({
        name: skill.name,
        ...(skill.description === undefined ? {} : { description: skill.description }),
        path: skill.path,
        tier: skill.tier,
        origin: skillOrigin(skill.path, root, userDir(), pluginStore),
        allowedTools: skill.allowedTools ?? [],
        fork: skill.fork !== undefined,
        userInvocable: skill.userInvocable,
        modelInvocable: skill.modelInvocable,
        body: skill.body,
        enabled: !disabled.includes(skill.name),
      })),
    };
  };

  handlers.skill_write = async (rawParams) => {
    const params = (rawParams ?? {}) as {
      scope?: unknown;
      name?: unknown;
      description?: unknown;
      fork?: unknown;
      allowedTools?: unknown;
      body?: unknown;
    };
    if (params.scope !== "project" && params.scope !== "user") throw invalid("scope must be project or user");
    const name = requireString(params.name, "skill_write name");
    if (!SKILL_NAME.test(name)) throw invalid(`skill name must match ${SKILL_NAME}`);
    if (typeof params.body !== "string") throw invalid("skill_write requires body");
    if (params.description !== undefined && typeof params.description !== "string")
      throw invalid("description must be a string");
    const tools = params.allowedTools ?? [];
    if (!Array.isArray(tools) || tools.some((tool) => typeof tool !== "string" || tool.trim() === ""))
      throw invalid("allowedTools must be a list of non-empty strings");

    const base =
      params.scope === "project"
        ? join(options.workspaceRoot, ".agency", "skills")
        : join(userDir(), "skills");
    const path = join(base, name, "SKILL.md");
    if (existsSync(path)) throw invalid(`skill ${name} exists already: ${path}`);
    const front = [
      `name: ${name}`,
      ...(params.description?.trim() ? [`description: ${yamlScalar(params.description)}`] : []),
      ...(tools.length > 0 ? [`allowed-tools: ${yamlScalar((tools as string[]).join(", "))}`] : []),
      ...(params.fork === true ? ["context: fork"] : []),
    ];
    const body = params.body.endsWith("\n") ? params.body : `${params.body}\n`;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `---\n${front.join("\n")}\n---\n\n${body}`, { encoding: "utf8", flag: "wx" });
    return { path };
  };

  return () => clearInterval(restartTimer);
}

import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The home folder where other agents keep their user files (`~/.claude/skills`, `~/.codex/prompts`).
 * `AGENCY_AGENTS_HOME` names another folder, and `off` reads none: the test preload points it away from the real home.
 */
export function foreignHome(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.AGENCY_AGENTS_HOME;
  if (value === "off") return undefined;
  return value || homedir();
}

/**
 * Where `plugin install --scope user` puts a plugin: a folder that holds `.agency/` as a workspace does, so the importer
 * is the same; its files load in every workspace, at the user tier.
 */
export function userPluginStore(configDirOverride?: string): string {
  return join(configDirOverride ?? configDir(), "plugin-store");
}

/** Per-OS config directory. Data/cache/log directories live in storage.ts. */
export function configDir(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string {
  if (env.AGENCY_HOME) return join(env.AGENCY_HOME, "config");
  if (platform === "win32") {
    return join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Agency");
  }
  if (platform === "darwin") {
    return join(homedir(), ".config", "agency");
  }
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "agency");
}

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  type CommandHooks,
  claudeUserPlugins,
  foreignHome,
  foreignHookFiles,
  loadClaudeSettingsEnv,
  loadConfig,
  loadUserAgentInstructions,
  updateGlobalConfig,
  userPluginStore,
} from "@agency/core";
import { importMcpServers, MCP_IMPORT_SOURCES } from "@agency/tools";
import { writeMcpImport } from "./mcp-commands.ts";
import { pluginInstallCmd } from "./plugin-commands.ts";

/** A set of things of another agent that `agency import` can bring over, with one question for the set. */
export interface ImportGroup {
  title: string;
  items: string[];
  apply: () => string;
}

const readJson = (file: string): Record<string, unknown> => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
};

const nonEmptyDir = (dir: string): boolean => existsSync(dir) && readdirSync(dir).length > 0;

function hookLines(hooks: CommandHooks): string[] {
  return Object.entries(hooks).flatMap(([event, groups]) =>
    (groups ?? []).flatMap((group) =>
      group.hooks.map((entry) => {
        const what = "command" in entry ? entry.command : "url" in entry ? entry.url : entry.type;
        return `${event}${group.matcher ? ` ${group.matcher}` : ""}: ${what}`;
      }),
    ),
  );
}

/**
 * What other agents keep for the user and Agency does not use until it is imported: MCP servers, hooks, plugins, and
 * the user instructions and code plugins that are off by default. A set that is imported already is left out.
 */
export function scanHarnesses(configDir: string, env: NodeJS.ProcessEnv): ImportGroup[] {
  const home = foreignHome(env);
  if (home === undefined) return [];
  const groups: ImportGroup[] = [];
  const where = { home, env, platform: process.platform };

  for (const source of MCP_IMPORT_SOURCES) {
    let found: ReturnType<typeof importMcpServers>;
    try {
      found = importMcpServers(source, where);
    } catch {
      continue;
    }
    if (found === undefined || Object.keys(found.servers).length === 0) continue;
    const { file, servers } = found;
    const done = readJson(join(configDir, "mcp", `${source}.json`)).mcpServers;
    if (JSON.stringify(done) === JSON.stringify(servers)) continue;
    groups.push({
      title: `MCP servers of ${source} (${file})`,
      items: Object.keys(servers),
      apply: () => writeMcpImport(configDir, source, servers),
    });
  }

  const hookDir = join(userPluginStore(configDir), ".agency", "hooks");
  // Claude Code gives the `env` of its settings to its hooks.
  const claudeEnv = loadClaudeSettingsEnv(home);
  for (const { file, hooks } of foreignHookFiles(home)) {
    const items = hookLines(hooks);
    if (items.length === 0) continue;
    if (file.startsWith(join(home, ".claude")) && Object.keys(claudeEnv).length > 0) {
      for (const group of Object.values(hooks).flat())
        for (const entry of group?.hooks ?? [])
          if (entry.type === "command") entry.env = { ...claudeEnv, ...entry.env };
    }
    const target = join(
      hookDir,
      `import-${relative(home, file)
        .replace(/^\./, "")
        .replace(/[\\/.]+/g, "-")}.json`,
    );
    const text = `${JSON.stringify({ hooks }, null, 2)}\n`;
    if (existsSync(target) && readFileSync(target, "utf8") === text) continue;
    groups.push({
      title: `Hooks of ${file} (they run these commands)`,
      items,
      apply: () => {
        mkdirSync(hookDir, { recursive: true });
        writeFileSync(target, text);
        return `${items.length} hooks to ${target}`;
      },
    });
  }

  const store = userPluginStore(configDir);
  const plugins = claudeUserPlugins(home).filter(
    ({ id }) => !existsSync(join(store, ".agency", "skills", id.split("@")[0] ?? "", "receipt.json")),
  );
  if (plugins.length > 0)
    groups.push({
      title: "Plugins that Claude Code installed for the user",
      items: plugins.map(({ id }) => id),
      apply: () =>
        plugins
          .map(({ id, dir, entry }) => {
            try {
              pluginInstallCmd(dir, store, false, () => {}, { source: dir }, entry);
              return `${id}: installed`;
            } catch (error) {
              return `${id}: ${error instanceof Error ? error.message : String(error)}`;
            }
          })
          .join("\n"),
    });

  const config = loadConfig({ globalDir: configDir, env });
  if (config.userAgentInstructions === undefined && loadUserAgentInstructions(home).length > 0)
    groups.push({
      title: "User instructions of other agents (~/.claude/CLAUDE.md, ~/.codex/AGENTS.md, ...)",
      items: ["userAgentInstructions: true"],
      apply: () => {
        updateGlobalConfig({ userAgentInstructions: true }, { globalDir: configDir, env });
        return "userAgentInstructions: true";
      },
    });
  const codeDirs = [
    join(home, ".config", "opencode", "plugins"),
    join(home, ".config", "opencode", "plugin"),
    join(home, ".pi", "agent", "extensions"),
  ].filter(nonEmptyDir);
  if (config.userAgentPlugins === undefined && codeDirs.length > 0)
    groups.push({
      title: "Code plugins of OpenCode and Pi (they run as code in the daemon)",
      items: codeDirs,
      apply: () => {
        updateGlobalConfig({ userAgentPlugins: true }, { globalDir: configDir, env });
        return "userAgentPlugins: true";
      },
    });
  return groups;
}

/** The settings of Claude Code that have no counterpart here, for the report. */
function claudeLeftOut(home: string): string[] {
  const settings = readJson(join(home, ".claude", "settings.json"));
  const permissions = (settings.permissions ?? {}) as Record<string, unknown>;
  return [
    ...(settings.model === undefined ? [] : [`model "${String(settings.model)}"`]),
    ...(permissions.defaultMode === undefined
      ? []
      : [`permissions.defaultMode "${String(permissions.defaultMode)}"`]),
  ];
}

/**
 * `agency import [--yes] [--dry-run]`: shows what other agents keep for the user and imports each set the user says
 * yes to. With no terminal and no `--yes`, it only shows.
 */
export async function harnessImportCmd(options: {
  configDir: string;
  env: NodeJS.ProcessEnv;
  yes: boolean;
  dryRun: boolean;
  confirm: ((question: string) => Promise<boolean>) | undefined;
  out: (line: string) => void;
}): Promise<number> {
  const { out } = options;
  const groups = scanHarnesses(options.configDir, options.env);
  if (groups.length === 0) out("Nothing of another agent to import.");
  let shown = false;
  for (const group of groups) {
    out(`${group.title}:`);
    for (const item of group.items) out(`  ${item}`);
    if (options.dryRun) continue;
    const take = options.yes || (options.confirm !== undefined && (await options.confirm("Import these?")));
    if (take) out(group.apply());
    else shown = true;
  }
  if (shown && options.confirm === undefined && !options.dryRun)
    out("Run agency import in a terminal to choose, or agency import --yes to import all.");
  const home = foreignHome(options.env);
  if (home !== undefined) {
    const left = claudeLeftOut(home);
    if (left.length > 0) out(`Not imported, with no counterpart here: ${left.join(", ")} of Claude Code.`);
  }
  out(
    "Used with no import: the skills, commands, agents and output styles of other agents, the permission rules of " +
      "~/.claude/settings.json, and the hooks, MCP servers and plugins that other agents keep in a trusted workspace.",
  );
  return 0;
}

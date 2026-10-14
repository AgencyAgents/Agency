import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { McpServerConfigSchema } from "@agency/tools";
import { parseAgentFile } from "../agents/files.ts";
import type { Logger } from "../logger.ts";
import { COMMAND_HOOK_EVENTS, type CommandHooks, CommandHooksSchema } from "./command-hooks.ts";
import { SKILL_NAME_RE } from "./manifest.ts";
import { parseSkillFrontmatter } from "./skill.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImportClaudePluginOptions {
  /** Absolute path to the unpacked plugin directory. */
  sourceDir: string;
  /** Workspace root where .agency/ lives. */
  workspaceRoot: string;
  /** Overwrite existing .agency/skills/<name>/SKILL.md or .agency/commands/<file>? Default false (skip with warning). */
  overwrite?: boolean;
  /** Logger for warnings and info messages. */
  logger?: Logger;
}

export interface ImportClaudePluginReport {
  /** Plugin name from manifest. */
  pluginName: string;
  /** Plugin version from manifest (if present). */
  pluginVersion?: string;
  /** Plugin description from manifest (if present). */
  pluginDescription?: string;
  /** Skill names that were installed into .agency/skills/<name>/. */
  skillsInstalled: string[];
  /** Events whose commands are now in .agency/hooks/<plugin>.json, where the daemon runs them. */
  hooksInstalled: string[];
  /** Events that were not installed: no such event here, or entries that are not commands. */
  hooksSkipped: Array<{ event: string; reason: string }>;
  /** The MCP servers that are now in .agency/mcp/<plugin>.json, where the daemon loads them. */
  mcpServers: Record<string, unknown>;
  /** Agent definition filenames found (informational; see agentsInstalled). */
  agentsFound: string[];
  /** Agent files written into .agency/agents/, runnable with no config edit. */
  agentsInstalled: string[];
  /** Command filenames that were installed into .agency/commands/. */
  commandsInstalled: string[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function readJsonFile(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    const text = readFileSync(path, "utf8");
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Read the plugin manifest from either .claude-plugin/plugin.json or
 * .codex-plugin/plugin.json. Returns undefined when neither exists or
 * the manifest lacks a "name" field.
 */
function readManifest(
  sourceDir: string,
  _logger?: Logger,
):
  | { name: string; version?: string; description?: string; hooks?: unknown; mcpServers?: unknown }
  | undefined {
  const claudePath = join(sourceDir, ".claude-plugin", "plugin.json");
  const codexPath = join(sourceDir, ".codex-plugin", "plugin.json");

  let manifestPath: string | undefined;
  if (existsSync(claudePath)) {
    manifestPath = claudePath;
  } else if (existsSync(codexPath)) {
    manifestPath = codexPath;
  }

  if (!manifestPath) {
    _logger?.warn(`[importer] no manifest found at ${claudePath} or ${codexPath}`);
    return undefined;
  }

  const raw = readJsonFile(manifestPath);
  if (!isRecord(raw)) {
    _logger?.warn(`[importer] manifest at ${manifestPath} is not a valid JSON object`);
    return undefined;
  }

  if (typeof raw.name !== "string" || raw.name.length === 0) {
    _logger?.warn(`[importer] manifest at ${manifestPath} has no "name" field`);
    return undefined;
  }

  return raw as {
    name: string;
    version?: string;
    description?: string;
    hooks?: unknown;
    mcpServers?: unknown;
  };
}

/** Where the files of an installed plugin stay, for the hook commands that name them. */
export function pluginRootDir(workspaceRoot: string, pluginName: string): string {
  return join(workspaceRoot, ".agency", "plugin-roots", pluginName);
}

/** The MCP file that `plugin install` writes for one plugin. */
export function pluginMcpFile(workspaceRoot: string, pluginName: string): string {
  return join(workspaceRoot, ".agency", "mcp", `${pluginName}.json`);
}

/** The hook file that `plugin install` writes for one plugin. */
export function pluginHooksFile(workspaceRoot: string, pluginName: string): string {
  return join(workspaceRoot, ".agency", "hooks", `${pluginName}.json`);
}

/**
 * The command hooks of a plugin, for the events that this harness runs. `${CLAUDE_PLUGIN_ROOT}` in a command
 * becomes `root`, the folder that holds the plugin's files after the install.
 */
function parseHooks(
  hooksRaw: Record<string, unknown>,
  root: string,
): { hooks: CommandHooks; skipped: Array<{ event: string; reason: string }> } {
  const hooks: CommandHooks = {};
  const skipped: Array<{ event: string; reason: string }> = [];
  for (const [event, groups] of Object.entries(hooksRaw)) {
    if (!(COMMAND_HOOK_EVENTS as readonly string[]).includes(event)) {
      skipped.push({ event, reason: `unsupported event "${event}"` });
      continue;
    }
    const parsed = CommandHooksSchema.safeParse({ [event]: groups });
    if (!parsed.success) {
      skipped.push({ event, reason: "its entries are not command hooks" });
      continue;
    }
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal placeholder of a Claude Code hook command
    const placeholder = "${CLAUDE_PLUGIN_ROOT}";
    const text = JSON.stringify(parsed.data).replaceAll(placeholder, root.replaceAll("\\", "/"));
    Object.assign(hooks, JSON.parse(text));
  }
  return { hooks, skipped };
}

/**
 * Resolve the hooks source from a plugin directory. Tries, in order:
 * 1. hooks/hooks.json (extracts the "hooks" key if present)
 * 2. Inline hooks from the manifest (plugin.json "hooks" field as object)
 * 3. Manifest hooks as a string path (resolved relative to sourceDir)
 *
 * Returns undefined when no hooks source is found.
 */
function resolveHooks(
  sourceDir: string,
  manifest: { hooks?: unknown },
  logger?: Logger,
): Record<string, unknown> | undefined {
  // 1. hooks/hooks.json
  const hooksFilePath = join(sourceDir, "hooks", "hooks.json");
  if (existsSync(hooksFilePath)) {
    const raw = readJsonFile(hooksFilePath);
    if (isRecord(raw)) {
      // The hooks.json format wraps events under a "hooks" key:
      // { "hooks": { "SessionStart": [...] } }
      if (isRecord(raw.hooks)) {
        return raw.hooks as Record<string, unknown>;
      }
      // Fallback: treat the whole file as the hooks map
      return raw;
    }
    logger?.warn(`[importer] hooks/hooks.json is not a valid object`);
  }

  // 2. Inline hooks from manifest
  if (isRecord(manifest.hooks)) {
    return manifest.hooks as Record<string, unknown>;
  }

  // 3. Manifest hooks as a string path
  if (typeof manifest.hooks === "string") {
    const resolvedPath = join(sourceDir, manifest.hooks);
    if (existsSync(resolvedPath)) {
      const raw = readJsonFile(resolvedPath);
      if (isRecord(raw)) {
        if (isRecord(raw.hooks)) {
          return raw.hooks as Record<string, unknown>;
        }
        return raw;
      }
      logger?.warn(`[importer] hooks file at ${resolvedPath} is not a valid object`);
    } else {
      logger?.warn(`[importer] hooks file at ${resolvedPath} does not exist`);
    }
  }

  return undefined;
}

/**
 * Validate MCP server entries against McpServerConfigSchema. Returns only
 * entries that pass validation, logging warnings for failures.
 */
function parseMcpServers(mcpRaw: Record<string, unknown>, logger?: Logger): Record<string, unknown> {
  const valid: Record<string, unknown> = {};
  for (const [name, config] of Object.entries(mcpRaw)) {
    const result = McpServerConfigSchema.safeParse(config);
    if (result.success) {
      valid[name] = result.data;
    } else {
      logger?.warn(`[importer] MCP server "${name}" failed validation: ${result.error.message}`);
    }
  }
  return valid;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Import a Claude Code / OpenAI Codex plugin from an unpacked directory into
 * Agency-native state. Skills, commands, and agents are copied into .agency/
 * as runnable files; only MCP servers are reported for manual config merge.
 *
 * @param sourceDir - Absolute path to the unpacked plugin directory.
 * @param opts - Options including workspaceRoot, overwrite flag, and logger.
 * @returns A structured report of what was installed, mapped, and found.
 * @throws If no valid manifest is found (missing or missing "name" field).
 */
export function importClaudePlugin(
  sourceDir: string,
  opts: ImportClaudePluginOptions,
): ImportClaudePluginReport {
  const { workspaceRoot, overwrite = false, logger } = opts;

  // -----------------------------------------------------------------------
  // 1. Read manifest
  // -----------------------------------------------------------------------
  const manifest = readManifest(sourceDir, logger);
  if (!manifest) {
    throw new Error(
      `No valid plugin manifest found in ${sourceDir}. ` +
        `Expected .claude-plugin/plugin.json or .codex-plugin/plugin.json with a "name" field.`,
    );
  }

  // The name becomes a folder and a file under .agency: a name that is a path would write outside them.
  if (!SKILL_NAME_RE.test(manifest.name)) {
    throw new Error(`Plugin name "${manifest.name}" is not valid: it must match ${SKILL_NAME_RE.source}`);
  }

  const report: ImportClaudePluginReport = {
    pluginName: manifest.name,
    pluginVersion: manifest.version,
    pluginDescription: manifest.description,
    skillsInstalled: [],
    hooksInstalled: [],
    hooksSkipped: [],
    mcpServers: {},
    agentsFound: [],
    agentsInstalled: [],
    commandsInstalled: [],
  };

  // -----------------------------------------------------------------------
  // 2. Skills: skills/<name>/SKILL.md -> .agency/skills/<name>/SKILL.md
  // -----------------------------------------------------------------------
  const skillsDir = join(sourceDir, "skills");
  if (existsSync(skillsDir)) {
    let entries: string[];
    try {
      entries = readdirSync(skillsDir);
    } catch {
      logger?.warn(`[importer] cannot read skills directory: ${skillsDir}`);
      entries = [];
    }

    for (const entry of entries.sort()) {
      const skillDirPath = join(skillsDir, entry);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(skillDirPath);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;

      const skillFile = join(skillDirPath, "SKILL.md");
      if (!existsSync(skillFile)) continue;

      let raw: string;
      try {
        raw = readFileSync(skillFile, "utf8");
      } catch {
        logger?.warn(`[importer] cannot read skill file: ${skillFile}`);
        continue;
      }

      // Reuse the existing frontmatter parser
      const parsed = parseSkillFrontmatter(raw);
      const skillName = parsed.name ?? entry;
      if (!SKILL_NAME_RE.test(skillName)) {
        logger?.warn(`[importer] skipping skill "${skillName}": its name must match ${SKILL_NAME_RE.source}`);
        continue;
      }

      // Write to .agency/skills/<name>/SKILL.md
      const targetDir = join(workspaceRoot, ".agency", "skills", skillName);
      const targetFile = join(targetDir, "SKILL.md");

      if (existsSync(targetFile)) {
        if (!overwrite) {
          logger?.warn(
            `[importer] skill "${skillName}" already exists at ${targetFile}, skipping ` +
              `(use overwrite: true to replace)`,
          );
          continue;
        }
        logger?.info(`[importer] overwriting skill "${skillName}" at ${targetFile}`);
      }

      // The whole folder: a skill names its own files (references, scripts) by a path that starts at its folder.
      cpSync(skillDirPath, targetDir, { recursive: true });
      report.skillsInstalled.push(skillName);
    }
  }

  // -----------------------------------------------------------------------
  // 3. Hooks: hooks/hooks.json or inline in plugin.json
  // -----------------------------------------------------------------------
  const copyTo = pluginRootDir(workspaceRoot, manifest.name);
  // A plugin that is installed from the workspace itself cannot be copied into its own subfolder: its files stay where they are.
  const inPlace = resolve(copyTo).startsWith(`${resolve(sourceDir)}${sep}`);
  const root = inPlace ? sourceDir : copyTo;
  let copied = inPlace;
  // Hook commands and MCP servers name files of the plugin: its files stay in the workspace, as the source folder can go away.
  const keepPluginFiles = (): void => {
    if (copied) return;
    cpSync(sourceDir, root, { recursive: true, filter: (path) => basename(path) !== ".git" });
    copied = true;
  };
  const hooksSource = resolveHooks(sourceDir, manifest, logger);
  if (hooksSource) {
    const { hooks, skipped } = parseHooks(hooksSource, root);
    report.hooksSkipped = skipped;
    report.hooksInstalled = Object.keys(hooks);
    if (report.hooksInstalled.length > 0) {
      keepPluginFiles();
      const file = pluginHooksFile(workspaceRoot, manifest.name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify({ hooks }, null, 2)}\n`, "utf8");
    }
  }

  // -----------------------------------------------------------------------
  // 4. MCP servers: .mcp.json
  // -----------------------------------------------------------------------
  // The file of the plugin, with or with no `mcpServers` key, or the same key of the manifest.
  const mcpFile = readJsonFile(join(sourceDir, ".mcp.json"));
  const mcpRaw = isRecord(mcpFile) ? (mcpFile.mcpServers ?? mcpFile) : manifest.mcpServers;
  if (isRecord(mcpRaw)) {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal placeholder of a Claude Code plugin
    const placeholder = "${CLAUDE_PLUGIN_ROOT}";
    const text = JSON.stringify(mcpRaw).replaceAll(placeholder, root.replaceAll("\\", "/"));
    report.mcpServers = parseMcpServers(JSON.parse(text), logger);
    if (Object.keys(report.mcpServers).length > 0) {
      keepPluginFiles();
      const file = pluginMcpFile(workspaceRoot, manifest.name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify({ mcpServers: report.mcpServers }, null, 2)}\n`, "utf8");
    }
  }

  // -----------------------------------------------------------------------
  // 5. Agents: agents/*.md -> .agency/agents/*.md (validated, runnable)
  // -----------------------------------------------------------------------
  const agentsDir = join(sourceDir, "agents");
  if (existsSync(agentsDir)) {
    let entries: string[];
    try {
      entries = readdirSync(agentsDir);
    } catch {
      logger?.warn(`[importer] cannot read agents directory: ${agentsDir}`);
      entries = [];
    }

    for (const entry of entries.sort()) {
      if (!entry.endsWith(".md")) continue;
      const agentName = basename(entry, ".md");
      report.agentsFound.push(agentName);
      const sourceFile = join(agentsDir, entry);
      let raw: string;
      try {
        raw = readFileSync(sourceFile, "utf8");
      } catch {
        logger?.warn(`[importer] cannot read agent file: ${sourceFile}`);
        continue;
      }
      try {
        parseAgentFile(raw, sourceFile);
      } catch (err) {
        logger?.warn(`[importer] skipping invalid agent "${agentName}": ${String(err)}`);
        continue;
      }
      const targetDir = join(workspaceRoot, ".agency", "agents");
      const targetFile = join(targetDir, entry);
      if (existsSync(targetFile)) {
        if (!overwrite) {
          logger?.warn(
            `[importer] agent "${agentName}" already exists at ${targetFile}, skipping ` +
              `(use overwrite: true to replace)`,
          );
          continue;
        }
        logger?.info(`[importer] overwriting agent "${agentName}" at ${targetFile}`);
      }
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(targetFile, raw, "utf8");
      report.agentsInstalled.push(agentName);
    }
  }

  // -----------------------------------------------------------------------
  // 6. Commands: commands/*.md -> .agency/commands/
  // -----------------------------------------------------------------------
  const commandsDir = join(sourceDir, "commands");
  if (existsSync(commandsDir)) {
    let entries: string[];
    try {
      entries = readdirSync(commandsDir);
    } catch {
      logger?.warn(`[importer] cannot read commands directory: ${commandsDir}`);
      entries = [];
    }

    for (const entry of entries.sort()) {
      if (!entry.endsWith(".md")) continue;
      const sourceFile = join(commandsDir, entry);

      const targetDir = join(workspaceRoot, ".agency", "commands");
      const targetFile = join(targetDir, entry);

      if (existsSync(targetFile)) {
        if (!overwrite) {
          logger?.warn(
            `[importer] command "${entry}" already exists at ${targetFile}, skipping ` +
              `(use overwrite: true to replace)`,
          );
          continue;
        }
        logger?.info(`[importer] overwriting command "${entry}" at ${targetFile}`);
      }

      let content: string;
      try {
        content = readFileSync(sourceFile, "utf8");
      } catch {
        logger?.warn(`[importer] cannot read command file: ${sourceFile}`);
        continue;
      }

      mkdirSync(targetDir, { recursive: true });
      writeFileSync(targetFile, content, "utf8");
      report.commandsInstalled.push(entry);
    }
  }

  return report;
}

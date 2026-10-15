import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { LspServerConfigSchema, McpServerConfigSchema, normalizeMcpServers } from "@agency/tools";
import { parseAgentFile, renderAgentFile } from "../agents/files.ts";
import { geminiTemplate } from "../commands/loader.ts";
import type { Logger } from "../logger.ts";
import { scopedRuleText } from "../prompt/instructions.ts";
import { COMMAND_HOOK_EVENTS, type CommandHooks, CommandHooksSchema } from "./command-hooks.ts";
import { convertForeignHooks } from "./foreign-hooks.ts";
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
  /** The entry of the plugin in its marketplace: the manifest when the plugin has no plugin.json. */
  marketplaceEntry?: Record<string, unknown>;
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
  /** Rule files written into .agency/rules/: the rules of a Cursor plugin, the context file of a Gemini extension. */
  rulesInstalled: string[];
  /** Parts of the plugin that cannot run here, each with the reason. */
  partsSkipped: string[];
  /** Module files written into .agency/plugins/: the Pi extensions of a Pi package. */
  modulesInstalled: string[];
  /** Output style files written into .agency/output-styles/. */
  outputStylesInstalled: string[];
  /** The LSP servers that are now in .agency/lsp/<plugin>.json, where the daemon loads them. */
  lspServers: string[];
  /** The `bin/` folder of the plugin, on the PATH of shell commands; absent when it has none. */
  binDir?: string;
  /** The variables that give the values of the `userConfig` of a Claude Code plugin. */
  optionVariables: string[];
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

/** The plugin formats of other agents, by the manifest file that names each, first match wins. */
const MANIFESTS = [
  ["claude", join(".claude-plugin", "plugin.json")],
  ["codex", join(".codex-plugin", "plugin.json")],
  ["cursor", join(".cursor-plugin", "plugin.json")],
  ["gemini", "gemini-extension.json"],
  // The portable form of Codex and of agent-plugins.org.
  ["portable", "plugin.json"],
  ["pi", "package.json"],
] as const;
type PluginFormat = (typeof MANIFESTS)[number][0];

interface Manifest {
  format: PluginFormat;
  name: string;
  version?: string;
  description?: string;
  hooks?: unknown;
  mcpServers?: unknown;
  lspServers?: unknown;
  /** Folders of each part, relative to the plugin root. */
  skills: string[];
  commands: string[];
  agents: string[];
  rules: string[];
  /** The folders of the output styles of a Claude Code plugin. */
  outputStyles?: string[];
  contextFile?: string;
  /** The module files of the extensions of a Pi package. */
  extensions: string[];
  /** Commands that a Claude Code manifest maps by name: `{ "about": { "content" | "source", "description" } }`. */
  commandMap?: Record<string, unknown>;
  /** The keys of the `userConfig` of a Claude Code manifest. */
  userConfig: string[];
  partsSkipped: string[];
}

/** True when `dir` holds the manifest of a plugin in one of the formats that `plugin install` takes. */
export function hasPluginManifest(dir: string): boolean {
  return readManifest(dir) !== undefined;
}

/** The folders that a manifest key names, or the default folder. A glob such as `./prompts/*.md` names its folder. */
function partDirs(value: unknown, fallback: string): string[] {
  const listed =
    typeof value === "string"
      ? [value]
      : Array.isArray(value)
        ? value.filter((v) => typeof v === "string")
        : [];
  const paths = listed.length > 0 ? listed : [fallback];
  return paths.map((path) => {
    const plain = path.replace(/^\.\//, "");
    return plain.includes("*") ? dirname(`${plain.slice(0, plain.indexOf("*"))}x`) : plain;
  });
}

/** The manifest of a plugin in any of the formats, or undefined when the folder has none with a name. */
function readManifest(
  sourceDir: string,
  logger?: Logger,
  entry?: Record<string, unknown>,
): Manifest | undefined {
  // As in Claude Code, the entry of a marketplace is the manifest of a plugin that has no plugin.json (`strict: false`).
  const sources = [
    ...MANIFESTS.map(([format, file]) => [format, file, readJsonFile(join(sourceDir, file))] as const),
    ...(entry === undefined ? [] : [["claude", "marketplace.json", entry] as const]),
  ];
  for (const [format, file, raw] of sources) {
    if (!isRecord(raw)) continue;
    const pi = isRecord(raw.pi) ? raw.pi : undefined;
    // Any package has a package.json: only a Pi package counts.
    if (
      format === "pi" &&
      pi === undefined &&
      !(Array.isArray(raw.keywords) && raw.keywords.includes("pi-package"))
    ) {
      continue;
    }
    if (typeof raw.name !== "string" || raw.name.length === 0) {
      logger?.warn(`[importer] manifest at ${join(sourceDir, file)} has no "name" field`);
      return undefined;
    }
    const base = {
      format,
      // An npm name has a scope: `@me/tools` is the plugin `tools`.
      name: format === "pi" ? raw.name.replace(/^@[^/]+\//, "") : raw.name,
      ...(typeof raw.version === "string" ? { version: raw.version } : {}),
      ...(typeof raw.description === "string" ? { description: raw.description } : {}),
      hooks: raw.hooks,
      mcpServers: raw.mcpServers,
      lspServers: raw.lspServers,
      partsSkipped: [] as string[],
      extensions: [] as string[],
      userConfig: isRecord(raw.userConfig) ? Object.keys(raw.userConfig) : [],
    };
    if (format === "pi") {
      // An extension is a module file, or a folder with an index.
      const indexOf = (dir: string): string | undefined =>
        ["index.ts", "index.js"].find((index) => existsSync(join(sourceDir, dir, index)));
      const extensions = partDirs(pi?.extensions, "extensions").flatMap((path) => {
        const full = join(sourceDir, path);
        if (!existsSync(full)) return [];
        if (!statSync(full).isDirectory()) return [path];
        const own = indexOf(path);
        if (own !== undefined) return [`${path}/${own}`];
        return readdirSync(full)
          .sort()
          .flatMap((entry) => {
            if (statSync(join(full, entry)).isFile())
              return /\.(m?js|m?ts)$/.test(entry) ? [`${path}/${entry}`] : [];
            const index = indexOf(`${path}/${entry}`);
            return index === undefined ? [] : [`${path}/${entry}/${index}`];
          });
      });
      return {
        ...base,
        skills: partDirs(pi?.skills, "skills"),
        commands: partDirs(pi?.prompts, "prompts"),
        agents: [],
        rules: [],
        extensions,
      };
    }
    if (format === "gemini") {
      const context = typeof raw.contextFileName === "string" ? raw.contextFileName : "GEMINI.md";
      return {
        ...base,
        skills: ["skills"],
        commands: ["commands"],
        agents: ["agents"],
        rules: [],
        ...(existsSync(join(sourceDir, context)) ? { contextFile: context } : {}),
      };
    }
    return {
      ...base,
      skills: partDirs(raw.skills, "skills"),
      // Claude Code can map commands by name: the default folder too then.
      commands: partDirs(isRecord(raw.commands) ? undefined : raw.commands, "commands"),
      ...(isRecord(raw.commands) ? { commandMap: raw.commands } : {}),
      agents: partDirs(raw.agents, "agents"),
      rules: format === "cursor" ? partDirs(raw.rules, "rules") : [],
      outputStyles: partDirs(raw.outputStyles, "output-styles"),
    };
  }
  logger?.warn(`[importer] no plugin manifest found in ${sourceDir}`);
  return undefined;
}

/** The folders of a part that exist inside the plugin: a path that goes outside it is skipped. */
function existingDirs(sourceDir: string, paths: string[], logger?: Logger): string[] {
  const root = resolve(sourceDir);
  return paths
    .map((path) => resolve(root, path))
    .filter((dir) => {
      if (dir !== root && !dir.startsWith(`${root}${sep}`)) {
        logger?.warn(`[importer] skipping ${dir}: it is outside the plugin`);
        return false;
      }
      return existsSync(dir) && statSync(dir).isDirectory();
    });
}

/** The variable that gives the value of a `userConfig` key, as Claude Code names it for a hook. */
const optionVariable = (key: string): string => `CLAUDE_PLUGIN_OPTION_${key.toUpperCase()}`;

/**
 * Puts the folder of the installed plugin in place of the root variable of each format, and its data folder in place
 * of `${CLAUDE_PLUGIN_DATA}`. A `${user_config.KEY}` becomes the variable that gives that value.
 */
function withPluginRoot(text: string, root: string, data: string): string {
  const path = root.replaceAll("\\", "/");
  let out = text;
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal root variables of Claude Code, Cursor and Gemini
  for (const variable of [
    "${CLAUDE_PLUGIN_ROOT}",
    "${CURSOR_PLUGIN_ROOT}",
    "${PLUGIN_ROOT}",
    "${extensionPath}",
  ]) {
    out = out.replaceAll(variable, path);
  }
  out = out.replace(/\$\{user_config\.(\w+)\}/g, (_, key: string) => `\${${optionVariable(key)}}`);
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the data variable of Claude Code, the path separator of Gemini
  return out.replaceAll("${CLAUDE_PLUGIN_DATA}", data.replaceAll("\\", "/")).replaceAll("${/}", "/");
}

/** The folder of `${CLAUDE_PLUGIN_DATA}`: it outlives a new install of the plugin, and `plugin remove` deletes it. */
export function pluginDataDir(workspaceRoot: string, pluginName: string): string {
  return join(workspaceRoot, ".agency", "plugin-data", pluginName);
}

/** Where the files of an installed plugin stay, for the hook commands that name them. */
export function pluginRootDir(workspaceRoot: string, pluginName: string): string {
  return join(workspaceRoot, ".agency", "plugin-roots", pluginName);
}

/** The MCP file that `plugin install` writes for one plugin. */
export function pluginMcpFile(workspaceRoot: string, pluginName: string): string {
  return join(workspaceRoot, ".agency", "mcp", `${pluginName}.json`);
}

/** The LSP file that `plugin install` writes for one plugin. */
export function pluginLspFile(workspaceRoot: string, pluginName: string): string {
  return join(workspaceRoot, ".agency", "lsp", `${pluginName}.json`);
}

/**
 * The LSP servers of a Claude Code plugin (`.lsp.json`, then the `lspServers` key, which wins on a name) in the form
 * of `lspServers` here. ponytail: one language id per server, the first of `extensionToLanguage`.
 */
function resolveLspServers(sourceDir: string, manifest: Manifest, logger?: Logger): Record<string, unknown> {
  const maps = [readJsonFile(join(sourceDir, ".lsp.json"))];
  for (const item of [manifest.lspServers].flat()) {
    maps.push(
      typeof item === "string" ? existingFiles(sourceDir, [item], logger).map(readJsonFile)[0] : item,
    );
  }
  const servers: Record<string, unknown> = {};
  for (const map of maps) {
    if (!isRecord(map)) continue;
    for (const [name, spec] of Object.entries(map)) {
      const languages = isRecord(spec) && isRecord(spec.extensionToLanguage) ? spec.extensionToLanguage : {};
      const server = LspServerConfigSchema.safeParse({
        ...(isRecord(spec) ? { command: spec.command, args: spec.args, env: spec.env } : {}),
        extensions: Object.keys(languages),
        languageId: Object.values(languages)[0],
      });
      if (server.success && server.data.extensions.length > 0) servers[name] = server.data;
      else logger?.warn(`[importer] skipping LSP server "${name}": it needs command and extensionToLanguage`);
    }
  }
  return servers;
}

/** The hook file that `plugin install` writes for one plugin. */
export function pluginHooksFile(workspaceRoot: string, pluginName: string): string {
  return join(workspaceRoot, ".agency", "hooks", `${pluginName}.json`);
}

/**
 * The command hooks of a plugin, for the events that this harness runs. `${CLAUDE_PLUGIN_ROOT}` in a command
 * becomes `root`, the folder that holds the plugin's files after the install; a command gets both folders as variables.
 */
function parseHooks(
  hooksRaw: Record<string, unknown>,
  root: string,
  data: string,
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
      skipped.push({ event, reason: "its entries are not command, http, prompt, agent or mcp_tool hooks" });
      continue;
    }
    const converted = JSON.parse(withPluginRoot(JSON.stringify(parsed.data), root, data)) as CommandHooks;
    for (const group of Object.values(converted).flat()) {
      for (const entry of group?.hooks ?? []) {
        if (entry.type === "command") entry.env = { CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: data };
      }
    }
    Object.assign(hooks, converted);
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
 * The MCP server map of a plugin: `.mcp.json` (Claude Code, Codex), `mcp.json` (Cursor, the portable form), or the
 * `mcpServers` key of the manifest, as a map or as a path.
 */
function resolveMcpServers(sourceDir: string, manifest: Manifest): unknown {
  for (const file of [".mcp.json", "mcp.json"]) {
    const raw = readJsonFile(join(sourceDir, file));
    if (isRecord(raw)) return raw.mcpServers ?? raw;
  }
  if (typeof manifest.mcpServers === "string") {
    const raw = readJsonFile(join(sourceDir, manifest.mcpServers));
    return isRecord(raw) ? (raw.mcpServers ?? raw) : undefined;
  }
  return manifest.mcpServers;
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

/** Writes one file of a part, or warns when it exists and `overwrite` is off. Returns true when it wrote. */
function writePart(
  targetFile: string,
  content: string,
  what: string,
  opts: { overwrite: boolean; logger?: Logger },
): boolean {
  if (existsSync(targetFile)) {
    if (!opts.overwrite) {
      opts.logger?.warn(
        `[importer] ${what} already exists at ${targetFile}, skipping (use overwrite: true to replace)`,
      );
      return false;
    }
    opts.logger?.info(`[importer] overwriting ${what} at ${targetFile}`);
  }
  mkdirSync(dirname(targetFile), { recursive: true });
  writeFileSync(targetFile, content, "utf8");
  return true;
}

/** The files that `paths` name inside the plugin: a path that goes outside it is skipped. */
function existingFiles(sourceDir: string, paths: string[], logger?: Logger): string[] {
  const root = resolve(sourceDir);
  return paths
    .map((path) => resolve(root, path))
    .filter((file) => {
      if (!file.startsWith(`${root}${sep}`)) {
        logger?.warn(`[importer] skipping ${file}: it is outside the plugin`);
        return false;
      }
      return existsSync(file) && statSync(file).isFile();
    });
}

/** The files of a folder and its subfolders, as paths relative to it, sorted. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((entry) => statSync(join(dir, entry)).isFile())
    .sort();
}

const COMMAND_EXTENSIONS = new Set([".md", ".mdc", ".markdown", ".txt"]);

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Import a plugin of Claude Code, Codex, Cursor, Gemini CLI or Pi from an unpacked directory into Agency-native state.
 * Skills, commands, agents and rules are copied into .agency/ as runnable files, hooks and MCP servers into the files
 * that the daemon reads.
 *
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
  const manifest = readManifest(sourceDir, logger, opts.marketplaceEntry);
  if (!manifest) {
    throw new Error(
      `No valid plugin manifest found in ${sourceDir}. Expected .claude-plugin/plugin.json, ` +
        `.codex-plugin/plugin.json, .cursor-plugin/plugin.json, gemini-extension.json, plugin.json, ` +
        `or a package.json of a Pi package, with a "name" field.`,
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
    rulesInstalled: [],
    partsSkipped: manifest.partsSkipped,
    modulesInstalled: [],
    outputStylesInstalled: [],
    lspServers: [],
    optionVariables: manifest.userConfig.map(optionVariable),
  };
  const write = { overwrite, logger };

  // -----------------------------------------------------------------------
  // 2. Skills: <skills folder>/<name>/SKILL.md -> .agency/skills/<name>/
  // -----------------------------------------------------------------------
  const skillFolders = existingDirs(sourceDir, manifest.skills, logger).flatMap((skillsDir) =>
    readdirSync(skillsDir)
      .sort()
      .map((entry) => ({ skillDirPath: join(skillsDir, entry), entry })),
  );
  // As in Claude Code: a plugin with no skills folder can be one skill, with its SKILL.md at the root.
  const rootSkill = join(workspaceRoot, ".agency", "skills");
  if (
    skillFolders.length === 0 &&
    existsSync(join(sourceDir, "SKILL.md")) &&
    !resolve(rootSkill).startsWith(`${resolve(sourceDir)}${sep}`)
  ) {
    skillFolders.push({ skillDirPath: sourceDir, entry: manifest.name });
  }
  for (const { skillDirPath, entry } of skillFolders) {
    const skillFile = join(skillDirPath, "SKILL.md");
    if (!statSync(skillDirPath).isDirectory() || !existsSync(skillFile)) continue;

    const parsed = parseSkillFrontmatter(readFileSync(skillFile, "utf8"));
    const skillName = parsed.name ?? entry;
    if (!SKILL_NAME_RE.test(skillName)) {
      logger?.warn(`[importer] skipping skill "${skillName}": its name must match ${SKILL_NAME_RE.source}`);
      continue;
    }

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
    cpSync(skillDirPath, targetDir, { recursive: true, filter: (path) => basename(path) !== ".git" });
    report.skillsInstalled.push(skillName);
  }

  // -----------------------------------------------------------------------
  // 3. Hooks: hooks/hooks.json or inline in plugin.json
  // -----------------------------------------------------------------------
  const copyTo = pluginRootDir(workspaceRoot, manifest.name);
  // A plugin that is installed from the workspace itself cannot be copied into its own subfolder: its files stay where they are.
  const inPlace = resolve(copyTo).startsWith(`${resolve(sourceDir)}${sep}`);
  const root = inPlace ? sourceDir : copyTo;
  let copied = inPlace;
  const data = pluginDataDir(workspaceRoot, manifest.name);
  // Hook commands and MCP servers name files of the plugin: its files stay in the workspace, as the source folder can go away.
  const keepPluginFiles = (): void => {
    if (copied) return;
    cpSync(sourceDir, root, { recursive: true, filter: (path) => basename(path) !== ".git" });
    copied = true;
  };
  const rawHooks = resolveHooks(sourceDir, manifest, logger);
  // The hooks of Cursor and Gemini CLI have their own events and fields.
  const hooksSource =
    rawHooks !== undefined && (manifest.format === "cursor" || manifest.format === "gemini")
      ? convertForeignHooks(manifest.format, rawHooks, sourceDir, (message) =>
          logger?.warn(`[importer] ${message}`),
        )
      : rawHooks;
  if (hooksSource) {
    const { hooks, skipped } = parseHooks(hooksSource, root, data);
    report.hooksSkipped = skipped;
    report.hooksInstalled = Object.keys(hooks);
    if (report.hooksInstalled.length > 0) {
      keepPluginFiles();
      mkdirSync(data, { recursive: true });
      const file = pluginHooksFile(workspaceRoot, manifest.name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify({ hooks }, null, 2)}\n`, "utf8");
    }
  }

  // -----------------------------------------------------------------------
  // 4. MCP servers, with the keys of Gemini and Cursor mapped
  // -----------------------------------------------------------------------
  const mcpRaw = resolveMcpServers(sourceDir, manifest);
  if (isRecord(mcpRaw)) {
    const client =
      manifest.format === "gemini" ? "gemini" : manifest.format === "cursor" ? "cursor" : undefined;
    const servers = client === undefined ? mcpRaw : normalizeMcpServers(client, mcpRaw);
    const text = JSON.stringify(servers);
    report.mcpServers = parseMcpServers(JSON.parse(withPluginRoot(text, root, data)), logger);
    if (Object.keys(report.mcpServers).length > 0) {
      keepPluginFiles();
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal data variable of Claude Code
      if (text.includes("${CLAUDE_PLUGIN_DATA}")) mkdirSync(data, { recursive: true });
      const file = pluginMcpFile(workspaceRoot, manifest.name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify({ mcpServers: report.mcpServers }, null, 2)}\n`, "utf8");
    }
  }

  const lsp = resolveLspServers(sourceDir, manifest, logger);
  report.lspServers = Object.keys(lsp);
  if (report.lspServers.length > 0) {
    keepPluginFiles();
    const file = pluginLspFile(workspaceRoot, manifest.name);
    mkdirSync(dirname(file), { recursive: true });
    const servers = JSON.parse(withPluginRoot(JSON.stringify(lsp), root, data));
    writeFileSync(file, `${JSON.stringify({ lspServers: servers }, null, 2)}\n`, "utf8");
  }

  // The commands of `bin/` are on the PATH of a shell command while the plugin is installed, as in Claude Code.
  const bin = join(sourceDir, "bin");
  if (existsSync(bin) && statSync(bin).isDirectory()) {
    keepPluginFiles();
    report.binDir = join(root, "bin");
  }

  // -----------------------------------------------------------------------
  // 5. Agents: agents/*.md -> .agency/agents/*.md, as agent files of Agency
  // -----------------------------------------------------------------------
  for (const agentsDir of existingDirs(sourceDir, manifest.agents, logger)) {
    for (const entry of readdirSync(agentsDir).sort()) {
      if (!entry.endsWith(".md")) continue;
      const agentName = basename(entry, ".md");
      report.agentsFound.push(agentName);
      const sourceFile = join(agentsDir, entry);
      let text: string;
      try {
        // The keys of another agent that have no use here are left out, and the file is written in the form here.
        text = renderAgentFile(parseAgentFile(readFileSync(sourceFile, "utf8"), sourceFile, true));
      } catch (err) {
        logger?.warn(`[importer] skipping invalid agent "${agentName}": ${String(err)}`);
        continue;
      }
      const targetFile = join(workspaceRoot, ".agency", "agents", entry);
      if (writePart(targetFile, text, `agent "${agentName}"`, write)) report.agentsInstalled.push(agentName);
    }
  }

  // -----------------------------------------------------------------------
  // 6. Commands: Markdown and the TOML of Gemini CLI -> .agency/commands/
  // -----------------------------------------------------------------------
  for (const commandsDir of existingDirs(sourceDir, manifest.commands, logger)) {
    // Only Gemini CLI names a command by its subfolder.
    const entries =
      manifest.format === "gemini"
        ? filesUnder(commandsDir)
        : readdirSync(commandsDir)
            .filter((entry) => statSync(join(commandsDir, entry)).isFile())
            .sort();
    for (const entry of entries) {
      const sourceFile = join(commandsDir, entry);
      let name = basename(entry, extname(entry));
      let content = readFileSync(sourceFile, "utf8");
      if (manifest.format === "gemini") {
        if (extname(entry) !== ".toml") continue;
        const raw = Bun.TOML.parse(content) as { prompt?: unknown; description?: unknown };
        if (typeof raw.prompt !== "string") continue;
        // A colon cannot be in a file name on Windows: `gcs/sync.toml` is `/gcs-sync`.
        name = relative(commandsDir, sourceFile).slice(0, -".toml".length).replace(/[\\/]/g, "-");
        const head = typeof raw.description === "string" ? `---\ndescription: ${raw.description}\n---\n` : "";
        content = `${head}${geminiTemplate(raw.prompt)}`;
      } else if (!COMMAND_EXTENSIONS.has(extname(entry))) {
        continue;
      }
      const target = `${name}.md`;
      const targetFile = join(workspaceRoot, ".agency", "commands", target);
      // A command names the scripts of its plugin by `${CLAUDE_PLUGIN_ROOT}`, as a hook does.
      content = withPluginRoot(content, root, data);
      if (writePart(targetFile, content, `command "${target}"`, write)) report.commandsInstalled.push(target);
    }
  }

  for (const [name, spec] of Object.entries(manifest.commandMap ?? {})) {
    if (!isRecord(spec) || !SKILL_NAME_RE.test(name)) continue;
    let body = typeof spec.content === "string" ? spec.content : undefined;
    if (body === undefined && typeof spec.source === "string") {
      const [file] = existingFiles(sourceDir, [spec.source], logger);
      if (file !== undefined) body = readFileSync(file, "utf8");
    }
    if (body === undefined) continue;
    const head =
      typeof spec.description === "string" && !body.startsWith("---")
        ? `---\ndescription: ${spec.description}\n---\n`
        : "";
    const target = `${name}.md`;
    const targetFile = join(workspaceRoot, ".agency", "commands", target);
    if (writePart(targetFile, withPluginRoot(`${head}${body}`, root, data), `command "${target}"`, write))
      report.commandsInstalled.push(target);
  }

  for (const stylesDir of existingDirs(sourceDir, manifest.outputStyles ?? [], logger)) {
    for (const entry of readdirSync(stylesDir).sort()) {
      if (extname(entry) !== ".md") continue;
      const targetFile = join(workspaceRoot, ".agency", "output-styles", entry);
      const text = readFileSync(join(stylesDir, entry), "utf8");
      if (writePart(targetFile, text, `output style "${entry}"`, write))
        report.outputStylesInstalled.push(entry);
    }
  }

  // -----------------------------------------------------------------------
  // 7. Rules of Cursor and the context file of Gemini -> .agency/rules/
  // -----------------------------------------------------------------------
  for (const rulesDir of existingDirs(sourceDir, manifest.rules, logger)) {
    for (const entry of filesUnder(rulesDir)) {
      if (![".md", ".mdc", ".markdown"].includes(extname(entry))) continue;
      const text = scopedRuleText(readFileSync(join(rulesDir, entry), "utf8"));
      // A rule that Cursor adds only on `@name` has no place here.
      if (text === "") continue;
      const target = `${manifest.name}-${basename(entry, extname(entry))}.md`;
      const targetFile = join(workspaceRoot, ".agency", "rules", target);
      if (writePart(targetFile, text, `rule "${target}"`, write)) report.rulesInstalled.push(target);
    }
  }
  if (manifest.contextFile !== undefined) {
    const target = `${manifest.name}.md`;
    const text = readFileSync(join(sourceDir, manifest.contextFile), "utf8");
    const targetFile = join(workspaceRoot, ".agency", "rules", target);
    if (writePart(targetFile, text, `rule "${target}"`, write)) report.rulesInstalled.push(target);
  }

  // -----------------------------------------------------------------------
  // 8. Pi extensions: a module of .agency/plugins/ imports them from the copy of the package
  // -----------------------------------------------------------------------
  if (manifest.extensions.length > 0) {
    keepPluginFiles();
    const target = `${manifest.name}.ts`;
    const names = manifest.extensions.map((_, index) => `extension${index}`);
    const imports = manifest.extensions.map(
      (path, index) => `import ${names[index]} from ${JSON.stringify(pathToFileURL(join(root, path)).href)};`,
    );
    const text = `// The Pi extensions of ${manifest.name}, written by agency plugin install.\n${imports.join("\n")}\nexport const piExtensions = [${names.join(", ")}];\n`;
    const targetFile = join(workspaceRoot, ".agency", "plugins", target);
    if (writePart(targetFile, text, `module "${target}"`, write)) report.modulesInstalled.push(target);
  }

  // The parts of a Claude Code plugin that have no counterpart here.
  for (const [part, reason] of [
    ["themes", "Agency has no themes"],
    ["monitors", "Agency has no monitors"],
    ["workflows", "run a workflow file with agency workflow run"],
    ["settings.json", "Agency does not take the settings of a plugin"],
  ]) {
    if (existsSync(join(sourceDir, part as string))) report.partsSkipped.push(`${part}: ${reason}`);
  }

  return report;
}

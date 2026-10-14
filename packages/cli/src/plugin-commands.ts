import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  hasPluginManifest,
  importClaudePlugin,
  Logger,
  pluginDataDir,
  pluginHooksFile,
  pluginLspFile,
  pluginMcpFile,
  pluginRootDir,
} from "@agency/core";

// ---------------------------------------------------------------------------
// Install receipt shape
// ---------------------------------------------------------------------------

export interface InstallReceipt {
  pluginName: string;
  pluginVersion?: string;
  skillsInstalled: string[];
  commandsInstalled: string[];
  agentsInstalled: string[];
  /** Absent in a receipt from before hooks were installed. */
  hooksInstalled?: string[];
  /** Absent in a receipt from before rules were installed. */
  rulesInstalled?: string[];
  /** The module files in .agency/plugins/ (the Pi extensions of a Pi package). */
  modulesInstalled?: string[];
  /** The output styles in .agency/output-styles/. */
  outputStylesInstalled?: string[];
  installedAt: string;
}

// ---------------------------------------------------------------------------
// plugin install <sourceDir> [--overwrite]
// ---------------------------------------------------------------------------

export function pluginInstallCmd(
  sourceDir: string,
  workspaceRoot: string,
  overwrite: boolean,
  errSink: (line: string) => void,
): string {
  // The importer logs JSON lines for a daemon. A person at the CLI gets the text and the CLI flag.
  const logger = new Logger({
    level: "warn",
    sink: (line) => errSink(String(JSON.parse(line).message).replace("overwrite: true", "--overwrite")),
  });
  const report = importClaudePlugin(sourceDir, { sourceDir, workspaceRoot, overwrite, logger });

  // Write install receipt into .agency/skills/<pluginName>/receipt.json
  const receipt: InstallReceipt = {
    pluginName: report.pluginName,
    pluginVersion: report.pluginVersion,
    skillsInstalled: report.skillsInstalled,
    commandsInstalled: report.commandsInstalled,
    agentsInstalled: report.agentsInstalled,
    hooksInstalled: report.hooksInstalled,
    rulesInstalled: report.rulesInstalled,
    modulesInstalled: report.modulesInstalled,
    outputStylesInstalled: report.outputStylesInstalled,
    installedAt: new Date().toISOString(),
  };
  const receiptDir = join(workspaceRoot, ".agency", "skills", report.pluginName);
  mkdirSync(receiptDir, { recursive: true });
  writeFileSync(join(receiptDir, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

  // Build human-readable report
  const lines: string[] = [];
  const nameLine = report.pluginVersion ? `${report.pluginName} v${report.pluginVersion}` : report.pluginName;
  lines.push(`Plugin: ${nameLine}`);
  if (report.pluginDescription) lines.push(`  ${report.pluginDescription}`);

  if (report.skillsInstalled.length > 0) {
    lines.push("");
    lines.push("Skills installed:");
    for (const s of report.skillsInstalled) lines.push(`  - ${s}`);
  }

  if (report.rulesInstalled.length > 0) {
    lines.push("");
    lines.push("Rules installed (.agency/rules/, added to the instructions):");
    for (const rule of report.rulesInstalled) lines.push(`  - ${rule}`);
  }

  if (report.outputStylesInstalled.length > 0) {
    lines.push("");
    lines.push('Output styles installed (.agency/output-styles/, chosen with "outputStyle" of the config):');
    for (const style of report.outputStylesInstalled) lines.push(`  - ${style}`);
  }

  if (report.modulesInstalled.length > 0) {
    lines.push("");
    lines.push("Pi extensions installed (.agency/plugins/, they run code in the daemon):");
    for (const module of report.modulesInstalled) lines.push(`  - ${module}`);
  }

  if (report.lspServers.length > 0) {
    lines.push("");
    lines.push(`LSP servers installed (.agency/lsp/${report.pluginName}.json, each starts a program):`);
    for (const name of report.lspServers) lines.push(`  - ${name}`);
  }

  if (report.binDir !== undefined) {
    lines.push("");
    lines.push(`Commands of ${report.binDir} are on the PATH of shell commands.`);
  }

  if (report.optionVariables.length > 0) {
    lines.push("");
    lines.push("Its settings (userConfig) come from these variables of the environment of Agency:");
    for (const variable of report.optionVariables) lines.push(`  - ${variable}`);
  }

  if (report.partsSkipped.length > 0) {
    lines.push("");
    lines.push("Not installed:");
    for (const part of report.partsSkipped) lines.push(`  - ${part}`);
  }

  if (report.hooksInstalled.length > 0) {
    lines.push("");
    lines.push(`Hooks installed (.agency/hooks/${report.pluginName}.json, they run shell commands):`);
    for (const event of report.hooksInstalled) lines.push(`  - ${event}`);
  }

  if (report.hooksSkipped.length > 0) {
    lines.push("");
    lines.push("Hooks skipped:");
    for (const h of report.hooksSkipped) lines.push(`  - ${h.event} (${h.reason})`);
  }

  const mcpKeys = Object.keys(report.mcpServers);
  if (mcpKeys.length > 0) {
    lines.push("");
    lines.push(`MCP servers installed (.agency/mcp/${report.pluginName}.json, they start programs):`);
    for (const key of mcpKeys) lines.push(`  - ${key}`);
  }

  if (report.agentsInstalled.length > 0) {
    lines.push("");
    lines.push("Agents installed (.agency/agents/, runnable with no config edit):");
    for (const a of report.agentsInstalled) lines.push(`  - ${a}`);
  }

  if (report.commandsInstalled.length > 0) {
    lines.push("");
    lines.push("Commands installed:");
    for (const c of report.commandsInstalled) lines.push(`  - ${c}`);
  }

  lines.push("");
  lines.push(`Install receipt written to: .agency/skills/${report.pluginName}/receipt.json`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// plugin install <git url | owner/repo>[#ref] [plugin]
// ---------------------------------------------------------------------------

export interface GitSource {
  url: string;
  ref?: string;
}

const GIT_URL = /^(?:(?:https?|ssh|git|file):\/\/|[\w.-]+@[\w.-]+:)/;
const GITHUB_REPO = /^[\w.-]+\/[\w.-]+$/;

/** A git URL, `git@host:path`, or `owner/repo` of GitHub, each with an optional `#ref`. A folder that exists is not one. */
export function gitSource(source: string): GitSource | undefined {
  if (existsSync(source)) return undefined;
  const [base = "", ref] = source.split("#", 2);
  const url = GIT_URL.test(base)
    ? base
    : GITHUB_REPO.test(base)
      ? `https://github.com/${base}.git`
      : undefined;
  return url === undefined ? undefined : { url, ...(ref ? { ref } : {}) };
}

/** Runs `use` on a shallow clone, then deletes the clone: the importer keeps a copy of the plugin. */
function withClone<T>(git: GitSource, use: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "agency-plugin-"));
  try {
    const ref = git.ref === undefined ? [] : ["--branch", git.ref];
    const result = spawnSync("git", ["clone", "--quiet", "--depth", "1", ...ref, "--", git.url, dir], {
      encoding: "utf8",
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    if (result.status !== 0) {
      throw new Error(
        `git clone of ${git.url} failed: ${(result.stderr || result.error?.message || "").trim()}`,
      );
    }
    return use(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

type MarketplaceSource = string | { source?: string; repo?: string; url?: string; ref?: string };

/** The marketplace files of Claude Code, Cursor and Codex. */
const MARKETPLACE_FILES = [
  [".claude-plugin", "marketplace.json"],
  [".cursor-plugin", "marketplace.json"],
  [".agents", "plugins", "marketplace.json"],
];

/**
 * The plugin of a marketplace file that `name` names, or its only plugin. Undefined when the folder is a plugin
 * itself, or no marketplace.
 */
function marketplacePlugin(
  root: string,
  name: string | undefined,
): { dir: string } | { git: GitSource } | undefined {
  const file = MARKETPLACE_FILES.map((parts) => join(root, ...parts)).find((path) => existsSync(path));
  if (file === undefined || hasPluginManifest(root)) return undefined;
  const market = JSON.parse(readFileSync(file, "utf8")) as {
    plugins?: { name: string; source: MarketplaceSource }[];
    metadata?: { pluginRoot?: string };
  };
  const plugins = market.plugins ?? [];
  const names = plugins.map((p) => p.name).join(", ");
  const entry =
    name === undefined && plugins.length === 1 ? plugins[0] : plugins.find((p) => p.name === name);
  if (entry === undefined) {
    throw new Error(
      name === undefined
        ? `This marketplace has more than one plugin. Name one: ${names}`
        : `The marketplace has no plugin "${name}". Its plugins: ${names}`,
    );
  }
  const source = entry.source;
  if (typeof source === "string") {
    const dir = resolve(root, market.metadata?.pluginRoot ?? "", source);
    const inside = relative(root, dir);
    if (inside.startsWith("..") || isAbsolute(inside)) {
      throw new Error(`The source of "${entry.name}" is outside the marketplace: ${source}`);
    }
    return { dir };
  }
  const ref = source.ref === undefined ? {} : { ref: source.ref };
  if (source.source === "github" && GITHUB_REPO.test(source.repo ?? "")) {
    return { git: { url: `https://github.com/${source.repo}.git`, ...ref } };
  }
  if (source.source === "url" && GIT_URL.test(source.url ?? ""))
    return { git: { url: source.url ?? "", ...ref } };
  throw new Error(`The source of "${entry.name}" has a form that Agency cannot install`);
}

/** `plugin install` of a folder or a git source; a marketplace in it gives the plugin that `name` names. */
export function pluginInstallSource(
  source: string,
  name: string | undefined,
  workspaceRoot: string,
  overwrite: boolean,
  errSink: (line: string) => void,
): string {
  const install = (root: string): string => {
    const picked = marketplacePlugin(root, name);
    if (picked === undefined) return pluginInstallCmd(root, workspaceRoot, overwrite, errSink);
    if ("dir" in picked) return pluginInstallCmd(picked.dir, workspaceRoot, overwrite, errSink);
    return withClone(picked.git, (dir) => pluginInstallCmd(dir, workspaceRoot, overwrite, errSink));
  };
  const git = gitSource(source);
  return git === undefined ? install(source) : withClone(git, install);
}

// ---------------------------------------------------------------------------
// plugin list
// ---------------------------------------------------------------------------

export function pluginListCmd(workspaceRoot: string): string {
  const lines: string[] = [];

  // Skills from .agency/skills/
  const skillsDir = join(workspaceRoot, ".agency", "skills");
  if (existsSync(skillsDir)) {
    const entries = readdirSync(skillsDir).sort();
    for (const entry of entries) {
      const fullPath = join(skillsDir, entry);
      try {
        if (statSync(fullPath).isDirectory()) {
          const kind = existsSync(join(fullPath, "receipt.json")) ? "plugin" : "skill";
          lines.push(`  ${entry}  (${kind})`);
        }
      } catch {
        // race: dir disappeared between readdir and stat
      }
    }
  }

  // JS/TS plugin modules from .agency/plugins/
  const pluginsDir = join(workspaceRoot, ".agency", "plugins");
  if (existsSync(pluginsDir)) {
    const entries = readdirSync(pluginsDir).sort();
    for (const entry of entries) {
      if (/\.(m?js|cjs|ts|mts)$/.test(entry)) {
        lines.push(`  ${entry}  (module)`);
      }
    }
  }

  if (lines.length === 0) return "No plugins or skills installed.";
  return `Installed plugins:\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// plugin remove <name>
// ---------------------------------------------------------------------------

function owningPlugin(workspaceRoot: string, skill: string): string | undefined {
  const skillsDir = join(workspaceRoot, ".agency", "skills");
  for (const entry of readdirSync(skillsDir)) {
    try {
      const receipt: InstallReceipt = JSON.parse(
        readFileSync(join(skillsDir, entry, "receipt.json"), "utf8"),
      );
      if (receipt.skillsInstalled.includes(skill)) return receipt.pluginName;
    } catch {
      // No receipt or a corrupt one: this folder owns no skill.
    }
  }
  return undefined;
}

/** A name from the command line or from a receipt is one path part: a path would delete outside `.agency`. */
const isFileName = (name: string): boolean => !/^\.*$|[\\/:]/.test(name);

export function pluginRemoveCmd(name: string, workspaceRoot: string): string {
  if (!isFileName(name)) throw new Error(`"${name}" is not a plugin name`);
  const skillDir = join(workspaceRoot, ".agency", "skills", name);
  if (!existsSync(skillDir)) {
    throw new Error(`Plugin "${name}" is not installed (no directory found at .agency/skills/${name}/)`);
  }

  // Read receipt to find command files and skill dirs to delete
  const receiptPath = join(skillDir, "receipt.json");
  if (!existsSync(receiptPath)) {
    // A skill that a plugin installed goes with its plugin: alone, its removal leaves the receipt behind.
    const owner = owningPlugin(workspaceRoot, name);
    if (owner !== undefined) {
      throw new Error(`"${name}" is a skill of the plugin "${owner}". Run: agency plugin remove ${owner}`);
    }
  }
  let commandsToDelete: string[] = [];
  let skillsToDelete: string[] = [];
  let agentsToDelete: string[] = [];
  let rulesToDelete: string[] = [];
  let stylesToDelete: string[] = [];
  let modulesToDelete: string[] = [];
  let pluginName = name;

  if (existsSync(receiptPath)) {
    try {
      const receipt: InstallReceipt = JSON.parse(readFileSync(receiptPath, "utf8"));
      commandsToDelete = receipt.commandsInstalled.filter(isFileName);
      skillsToDelete = receipt.skillsInstalled.filter(isFileName);
      agentsToDelete = (receipt.agentsInstalled ?? []).filter(isFileName);
      rulesToDelete = (receipt.rulesInstalled ?? []).filter(isFileName);
      stylesToDelete = (receipt.outputStylesInstalled ?? []).filter(isFileName);
      modulesToDelete = (receipt.modulesInstalled ?? []).filter(isFileName);
      if (isFileName(receipt.pluginName)) pluginName = receipt.pluginName;
    } catch {
      // Corrupt receipt -- still proceed with removing the skill dir
    }
  }

  // Delete tracked command files (only those from receipt)
  const commandsDir = join(workspaceRoot, ".agency", "commands");
  const deletedCommands: string[] = [];
  for (const cmd of commandsToDelete) {
    const cmdPath = join(commandsDir, cmd);
    if (existsSync(cmdPath)) {
      rmSync(cmdPath);
      deletedCommands.push(cmd);
    }
  }

  // Delete skill directories (including the plugin-name dir that holds the receipt)
  const deletedSkills: string[] = [];
  const allSkillDirs = new Set([...skillsToDelete, name]);
  for (const skillName of allSkillDirs) {
    const skillPath = join(workspaceRoot, ".agency", "skills", skillName);
    if (existsSync(skillPath)) {
      rmSync(skillPath, { recursive: true, force: true });
      deletedSkills.push(skillName);
    }
  }

  const lines: string[] = [`Removed plugin "${pluginName}".`];
  if (deletedSkills.length > 0) lines.push(`Deleted skill directories: ${deletedSkills.join(", ")}`);
  if (deletedCommands.length > 0) lines.push(`Deleted command files: ${deletedCommands.join(", ")}`);
  const agentsDir = join(workspaceRoot, ".agency", "agents");
  const deletedAgents: string[] = [];
  for (const agent of agentsToDelete) {
    const agentPath = join(agentsDir, `${agent}.md`);
    if (existsSync(agentPath)) {
      rmSync(agentPath);
      deletedAgents.push(agent);
    }
  }
  if (deletedAgents.length > 0) lines.push(`Deleted agent files: ${deletedAgents.join(", ")}`);
  const deletedRules = rulesToDelete.filter((rule) => {
    const rulePath = join(workspaceRoot, ".agency", "rules", rule);
    if (!existsSync(rulePath)) return false;
    rmSync(rulePath);
    return true;
  });
  if (deletedRules.length > 0) lines.push(`Deleted rule files: ${deletedRules.join(", ")}`);
  for (const style of stylesToDelete) {
    const stylePath = join(workspaceRoot, ".agency", "output-styles", style);
    if (!existsSync(stylePath)) continue;
    rmSync(stylePath);
    lines.push(`Deleted the output style ${style}.`);
  }
  for (const module of modulesToDelete) {
    const modulePath = join(workspaceRoot, ".agency", "plugins", module);
    if (!existsSync(modulePath)) continue;
    rmSync(modulePath);
    lines.push(`Deleted the module ${module}.`);
  }
  const hooksFile = pluginHooksFile(workspaceRoot, pluginName);
  if (existsSync(hooksFile)) {
    rmSync(hooksFile);
    lines.push("Deleted its hooks.");
  }
  const mcpFile = pluginMcpFile(workspaceRoot, pluginName);
  if (existsSync(mcpFile)) {
    rmSync(mcpFile);
    lines.push("Deleted its MCP servers.");
  }
  const lspFile = pluginLspFile(workspaceRoot, pluginName);
  if (existsSync(lspFile)) {
    rmSync(lspFile);
    lines.push("Deleted its LSP servers.");
  }
  rmSync(pluginRootDir(workspaceRoot, pluginName), { recursive: true, force: true });
  rmSync(pluginDataDir(workspaceRoot, pluginName), { recursive: true, force: true });

  return lines.join("\n");
}

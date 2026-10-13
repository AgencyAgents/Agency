import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { importClaudePlugin, Logger, pluginHooksFile, pluginRootDir } from "@agency/core";

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
    lines.push("MCP servers found -- manually merge into config.mcpServers:");
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
  let pluginName = name;

  if (existsSync(receiptPath)) {
    try {
      const receipt: InstallReceipt = JSON.parse(readFileSync(receiptPath, "utf8"));
      commandsToDelete = receipt.commandsInstalled.filter(isFileName);
      skillsToDelete = receipt.skillsInstalled.filter(isFileName);
      agentsToDelete = (receipt.agentsInstalled ?? []).filter(isFileName);
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
  const hooksFile = pluginHooksFile(workspaceRoot, pluginName);
  if (existsSync(hooksFile)) {
    rmSync(hooksFile);
    lines.push("Deleted its hooks.");
  }
  rmSync(pluginRootDir(workspaceRoot, pluginName), { recursive: true, force: true });

  return lines.join("\n");
}

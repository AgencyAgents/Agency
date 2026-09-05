import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { importClaudePlugin, Logger } from "@agency/core";

// ---------------------------------------------------------------------------
// Install receipt shape
// ---------------------------------------------------------------------------

export interface InstallReceipt {
  pluginName: string;
  pluginVersion?: string;
  skillsInstalled: string[];
  commandsInstalled: string[];
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
  const logger = new Logger({ level: "warn", sink: errSink });
  const report = importClaudePlugin(sourceDir, { sourceDir, workspaceRoot, overwrite, logger });

  // Write install receipt into .agency/skills/<pluginName>/receipt.json
  const receipt: InstallReceipt = {
    pluginName: report.pluginName,
    pluginVersion: report.pluginVersion,
    skillsInstalled: report.skillsInstalled,
    commandsInstalled: report.commandsInstalled,
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

  if (report.hooksMapped.length > 0) {
    lines.push("");
    lines.push("Hooks mapped:");
    for (const h of report.hooksMapped) lines.push(`  - ${h.claudeEvent} -> ${h.agencyHook}`);
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

  if (report.agentsFound.length > 0) {
    lines.push("");
    lines.push("Agents found -- manually add to config.agents:");
    for (const a of report.agentsFound) lines.push(`  - ${a}`);
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
          lines.push(`  ${entry}  (skill)`);
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

export function pluginRemoveCmd(name: string, workspaceRoot: string): string {
  const skillDir = join(workspaceRoot, ".agency", "skills", name);
  if (!existsSync(skillDir)) {
    throw new Error(`Plugin "${name}" is not installed (no directory found at .agency/skills/${name}/)`);
  }

  // Read receipt to find command files and skill dirs to delete
  const receiptPath = join(skillDir, "receipt.json");
  let commandsToDelete: string[] = [];
  let skillsToDelete: string[] = [];
  let pluginName = name;

  if (existsSync(receiptPath)) {
    try {
      const receipt: InstallReceipt = JSON.parse(readFileSync(receiptPath, "utf8"));
      commandsToDelete = receipt.commandsInstalled;
      skillsToDelete = receipt.skillsInstalled;
      pluginName = receipt.pluginName;
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

  return lines.join("\n");
}

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { McpServerConfigSchema } from "@agency/tools";
import type { Logger } from "../logger.ts";
import { parseSkillFrontmatter } from "./skill.ts";

// ---------------------------------------------------------------------------
// Hook event mapping: Claude Code event names -> Agency hook names
// ---------------------------------------------------------------------------

const CLAUDE_TO_AGENCY_HOOK_MAP: Record<string, string> = {
  SessionStart: "session.start",
  UserPromptSubmit: "prompt.submit",
  SubagentStart: "subagent.start",
};

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
  /** Hooks that were successfully mapped to Agency events. */
  hooksMapped: Array<{ claudeEvent: string; agencyHook: string }>;
  /** Hooks that were skipped (unknown events, etc.). */
  hooksSkipped: Array<{ event: string; reason: string }>;
  /** Validated MCP server entries (caller should merge into config). */
  mcpServers: Record<string, unknown>;
  /** Agent definition filenames found (caller should add to config.agents). */
  agentsFound: string[];
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

/**
 * Parse hooks from a raw object. The object is expected to be a map of
 * Claude Code event names to handler arrays: { SessionStart: [...], ... }.
 * Only known events are mapped; unknown events are warn-and-skipped.
 */
function parseHooks(
  hooksRaw: Record<string, unknown>,
  _logger?: Logger,
): {
  mapped: Array<{ claudeEvent: string; agencyHook: string }>;
  skipped: Array<{ event: string; reason: string }>;
} {
  const mapped: Array<{ claudeEvent: string; agencyHook: string }> = [];
  const skipped: Array<{ event: string; reason: string }> = [];

  for (const eventName of Object.keys(hooksRaw)) {
    const agencyHook = CLAUDE_TO_AGENCY_HOOK_MAP[eventName];
    if (!agencyHook) {
      skipped.push({ event: eventName, reason: `unknown event "${eventName}"` });
      continue;
    }
    mapped.push({ claudeEvent: eventName, agencyHook });
  }

  return { mapped, skipped };
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
 * Agency-native state. This is a read-mostly operation: it copies skills and
 * commands into .agency/, but only reports agents and MCP servers for the
 * caller to merge into config.
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

  const report: ImportClaudePluginReport = {
    pluginName: manifest.name,
    pluginVersion: manifest.version,
    pluginDescription: manifest.description,
    skillsInstalled: [],
    hooksMapped: [],
    hooksSkipped: [],
    mcpServers: {},
    agentsFound: [],
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

      mkdirSync(targetDir, { recursive: true });
      writeFileSync(targetFile, raw, "utf8");
      report.skillsInstalled.push(skillName);
    }
  }

  // -----------------------------------------------------------------------
  // 3. Hooks: hooks/hooks.json or inline in plugin.json
  // -----------------------------------------------------------------------
  const hooksSource = resolveHooks(sourceDir, manifest, logger);
  if (hooksSource) {
    const hookResult = parseHooks(hooksSource, logger);
    report.hooksMapped = hookResult.mapped;
    report.hooksSkipped = hookResult.skipped;
  }

  // -----------------------------------------------------------------------
  // 4. MCP servers: .mcp.json
  // -----------------------------------------------------------------------
  const mcpPath = join(sourceDir, ".mcp.json");
  const mcpRaw = readJsonFile(mcpPath);
  if (isRecord(mcpRaw)) {
    report.mcpServers = parseMcpServers(mcpRaw, logger);
  }

  // -----------------------------------------------------------------------
  // 5. Agents: agents/*.md (report only, never auto-write to config)
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

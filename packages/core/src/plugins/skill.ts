import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Logger } from "../logger.ts";
import type { ToolSpec } from "../loop.ts";
import { configDir } from "../paths.ts";
import type { PluginDefinition } from "./types.ts";

// ---------------------------------------------------------------------------
// YAML frontmatter splitter (zero-dep, shared by skills and agent files)
// ---------------------------------------------------------------------------

/** Split a ---delimited frontmatter block into raw key/value lines plus body. */
export function splitFrontmatter(text: string): {
  hasFrontmatter: boolean;
  fields: Record<string, string>;
  body: string;
} {
  const out: { hasFrontmatter: boolean; fields: Record<string, string>; body: string } = {
    hasFrontmatter: false,
    fields: {},
    body: text,
  };
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("---")) return out;
  // Find the closing --- after the opening one.
  const rest = trimmed.slice(3);
  const endIdx = rest.indexOf("\n---");
  if (endIdx === -1) return out;
  out.hasFrontmatter = true;
  out.body = rest.slice(endIdx + 5);
  for (const line of rest.slice(0, endIdx).split("\n")) {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) continue;
    const colon = trimmedLine.indexOf(":");
    if (colon <= 0) continue;
    const key = trimmedLine.slice(0, colon).trim();
    const val = trimmedLine.slice(colon + 1).trim();
    if (key.length > 0 && val.length > 0) out.fields[key] = val;
  }
  return out;
}

/**
 * Minimal YAML frontmatter parser. Extracts only name: and description:
 * string fields from a ---delimited block at the start of a Markdown file.
 * Returns the frontmatter values (if found) and the body (everything after the
 * closing ---). Malformed or missing frontmatter is never fatal - the caller
 * decides how to handle partial data.
 */
export function parseSkillFrontmatter(text: string): {
  name?: string;
  description?: string;
  body: string;
} {
  const split = splitFrontmatter(text);
  const result: { name?: string; description?: string; body: string } = { body: split.body };
  if (!split.hasFrontmatter) return result;
  if (split.fields.name !== undefined) result.name = split.fields.name;
  if (split.fields.description !== undefined) result.description = split.fields.description;
  return result;
}

// ---------------------------------------------------------------------------
// Skills directory scanner
// ---------------------------------------------------------------------------

/**
 * Scanned skill descriptor. Mirrors the shape returned by discoverSkills.
 */
export interface SkillDescriptor {
  /** Skill name (from frontmatter name: field, or directory basename as fallback). */
  name: string;
  /** Absolute path to the SKILL.md file. */
  path: string;
  /** Optional description from frontmatter description: field. */
  description?: string;
  /** Body content after the frontmatter block (or full file if no frontmatter). */
  body: string;
  /** Tier this skill was discovered from. */
  tier: "project" | "user";
}

/**
 * Scans one or more skills/ directories for SKILL.md files nested one level
 * deep: skills/<name>/SKILL.md. Each discovered file is parsed for YAML
 * frontmatter. Malformed files (no frontmatter, missing name) are skipped with
 * a warning - never thrown.
 *
 * @param dirs - Array of absolute paths to skills/ directories to scan.
 * @param logger - Optional logger for warnings.
 * @returns Discovered skills in scan order (first dir wins on id collision).
 */
export function discoverSkills(dirs: SkillDirEntry[], logger?: Logger): SkillDescriptor[] {
  const seen = new Set<string>();
  const skills: SkillDescriptor[] = [];

  for (const { dir, tier } of dirs) {
    if (!existsSync(dir)) continue;

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      logger?.warn(`[skills] cannot read directory: ${dir}`);
      continue;
    }

    for (const entry of entries.sort()) {
      const skillDir = join(dir, entry);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(skillDir);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;

      const skillFile = join(skillDir, "SKILL.md");
      if (!existsSync(skillFile)) continue;

      let raw: string;
      try {
        raw = readFileSync(skillFile, "utf8");
      } catch {
        logger?.warn(`[skills] cannot read: ${skillFile}`);
        continue;
      }

      const parsed = parseSkillFrontmatter(raw);
      const name = parsed.name ?? entry;

      if (!parsed.name) {
        logger?.warn(
          `[skills] SKILL.md at ${skillFile} has no frontmatter name: field; using directory name "${entry}" as fallback`,
        );
      }

      if (seen.has(name)) {
        logger?.warn(`[skills] duplicate skill id "${name}" skipped (${skillFile})`);
        continue;
      }
      seen.add(name);
      skills.push({
        name,
        path: skillFile,
        description: parsed.description,
        body: parsed.body,
        tier,
      });
    }
  }

  return skills;
}

// ---------------------------------------------------------------------------
// Skill -> PluginDefinition converter
// ---------------------------------------------------------------------------

/**
 * Converts a discovered skill into a PluginDefinition suitable for the plugin
 * loader. The skill body content becomes the agentsMd contribution (the
 * prompt instructions), and the skill name becomes the plugin id.
 *
 * Skills contribute no hooks, tools, or mcpServers by default - they are
 * purely instructional (AGENTS.md-style). The body is capped at the same 64KB
 * limit as other plugin instruction contributions.
 */
export function skillToPlugin(skill: SkillDescriptor): PluginDefinition {
  const def: PluginDefinition = {
    id: skill.name,
  };

  if (skill.body.length > 0) {
    def.agentsMd = skill.body;
  }

  return def;
}

/** The part of the system prompt that names the skills on demand: one line each, so an unused skill costs one line. */
export function skillListing(skills: SkillDescriptor[]): string | undefined {
  if (skills.length === 0) return undefined;
  return [
    "# Skills",
    "A skill is a set of instructions for one kind of task. Before a task that a skill below covers, load it with the skill tool and follow it.",
    ...skills.map((skill) => `- ${skill.name}: ${skill.description}`),
  ].join("\n");
}

/** The tool that gives the model the body of one listed skill. */
export function createSkillTool(skills: SkillDescriptor[]): ToolSpec {
  return {
    name: "skill",
    description:
      "Loads the full instructions of a skill that the system prompt lists. Call it before a task that the skill covers.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "The name of the skill, as listed." } },
      required: ["name"],
    },
    riskTier: "safe",
    handler: async (input) => {
      const skill = skills.find((candidate) => candidate.name === input.name);
      if (!skill) {
        const names = skills.map((candidate) => candidate.name).join(", ");
        return { content: `unknown skill: ${String(input.name)}. The skills are: ${names}`, isError: true };
      }
      return {
        content: `Skill: ${skill.name}\nBase directory: ${dirname(skill.path)} (paths in the skill are relative to it)\n\n${skill.body}`,
      };
    },
  };
}

/**
 * Resolves the skills directories to scan, in priority order (project first,
 * then user). Follows the same tier convention as resolvePluginTierDirs in
 * context.ts.
 */
export interface SkillDirEntry {
  dir: string;
  tier: "project" | "user";
}

/**
 * Resolves the skills directories to scan, in priority order (project first,
 * then user). Returns SkillDirEntry objects so that tier assignment is
 * explicit and correct: both <project>/.agency/skills/ and <project>/skills/
 * are "project" tier, while <configDir>/skills/ is "user" tier.
 *
 * Follows the same tier convention as resolvePluginTierDirs in context.ts.
 */
export function resolveSkillDirs(workspaceRoot: string, configDirOverride?: string): SkillDirEntry[] {
  const dirs: SkillDirEntry[] = [];

  // Project-level skills: <project>/.agency/skills/ (highest priority)
  dirs.push({ dir: join(workspaceRoot, ".agency", "skills"), tier: "project" });

  // Project-level skills: <project>/skills/ (same tier, project wins on collision)
  dirs.push({ dir: join(workspaceRoot, "skills"), tier: "project" });

  // The skill folders of other agents in the project: Claude Code, the shared `.agents`, Cursor, Codex, Pi, OpenCode, Gemini.
  for (const agent of [".claude", ".agents", ".cursor", ".codex", ".pi", ".opencode", ".gemini"]) {
    dirs.push({ dir: join(workspaceRoot, agent, "skills"), tier: "project" });
  }

  // User-level skills: <configDir>/skills/
  dirs.push({ dir: join(configDirOverride ?? configDir(), "skills"), tier: "user" });

  return dirs;
}

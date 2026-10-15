import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Logger } from "../logger.ts";
import type { ToolSpec } from "../loop.ts";
import { configDir, foreignHome, userPluginStore } from "../paths.ts";
import type { PluginDefinition } from "./types.ts";

const FOREIGN_USER_SKILL_DIRS = [
  [".claude", "skills"],
  [".agents", "skills"],
  [".codex", "skills"],
  [".cursor", "skills"],
  [".pi", "agent", "skills"],
  [".config", "opencode", "skills"],
  [".gemini", "skills"],
];

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
  // ponytail: the YAML of frontmatter in practice (quotes, `>` and `|` blocks, `- item` lists, nested maps
  // skipped), not all of YAML; a list becomes one comma-separated value.
  const lines = rest
    .slice(0, endIdx)
    .split("\n")
    .map((line) => line.replace(/\r$/, ""));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const colon = line.indexOf(":");
    if (/^\s/.test(line) || line.startsWith("#") || colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    let val = line.slice(colon + 1).trim();
    const nested: string[] = [];
    while (i + 1 < lines.length && /^(\s|$)/.test(lines[i + 1] as string)) nested.push(lines[++i] as string);
    if (/^[>|][-+]?$/.test(val)) {
      const text = nested.map((part) => part.trim());
      val = (val.startsWith(">") ? text.filter((part) => part !== "").join(" ") : text.join("\n")).trim();
    } else if (val === "") {
      val = nested
        .map((part) => /^\s*-\s+(.*)$/.exec(part)?.[1])
        .filter((item): item is string => item !== undefined)
        .map(unquote)
        .join(", ");
    } else {
      const more = nested.map((part) => part.trim()).filter((part) => part !== "");
      val = unquote([val, ...more].join(" "));
    }
    if (key.length > 0 && val.length > 0) out.fields[key] = val;
  }
  return out;
}

/** A YAML scalar without its quotes. */
function unquote(value: string): string {
  const quoted = /^(["'])([\s\S]*)\1$/.exec(value);
  if (quoted === null) return value;
  return quoted[1] === "'"
    ? (quoted[2] as string).replaceAll("''", "'")
    : (quoted[2] as string).replaceAll('\\"', '"');
}

/** A YAML boolean, with the spellings that Claude Code takes. */
function yamlTrue(value: string | undefined): boolean {
  return value !== undefined && /^(true|yes|on|1)$/i.test(value);
}

// biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder of Claude Code
const SKILL_DIR = "${CLAUDE_SKILL_DIR}";

/** The listing of Claude Code cuts the description and `when_to_use` of a skill here. */
const MAX_SKILL_DESCRIPTION = 1536;

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
  modelInvocable: boolean;
  userInvocable: boolean;
  allowedTools?: string[];
  fork?: { agent?: string; model?: string };
} {
  const split = splitFrontmatter(text);
  const { fields } = split;
  // As in Claude Code: with no description, the first line of the body; `when_to_use` joins it.
  const firstLine = split.body
    .split("\n")
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .find((line) => line !== "");
  const described = [fields.description ?? firstLine, fields.when_to_use].filter(Boolean).join(" ");
  const result: ReturnType<typeof parseSkillFrontmatter> = {
    body: split.body,
    modelInvocable: !yamlTrue(fields["disable-model-invocation"]),
    userInvocable: fields["user-invocable"] === undefined || yamlTrue(fields["user-invocable"]),
  };
  if (fields.name !== undefined) result.name = fields.name;
  // `Read, Bash(git *)`, `Read Grep` or a YAML list: each rule is a tool name with its optional pattern.
  const rules = fields["allowed-tools"]?.match(/[A-Za-z_][\w.:-]*(?:\([^)]*\))?/g);
  if (rules) result.allowedTools = rules;
  if (fields.context === "fork") {
    result.fork = {
      ...(fields.agent ? { agent: fields.agent } : {}),
      ...(fields.model && fields.model !== "inherit" ? { model: fields.model } : {}),
    };
  }
  if (described !== "") {
    result.description =
      described.length > MAX_SKILL_DESCRIPTION
        ? `${described.slice(0, MAX_SKILL_DESCRIPTION - 1)}…`
        : described;
  }
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
  /** False for `disable-model-invocation: true`: only a `/name` of the user loads it. */
  modelInvocable: boolean;
  /** False for `user-invocable: false`: no `/name` command. */
  userInvocable: boolean;
  /** `allowed-tools`: rules of Claude Code that the turn which loads the skill runs with no prompt. */
  allowedTools?: string[];
  /** `context: fork`: the skill runs in a subagent, of the type `agent` and on `model` when they are given. */
  fork?: { agent?: string; model?: string };
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
        modelInvocable: parsed.modelInvocable,
        userInvocable: parsed.userInvocable,
        ...(parsed.fork ? { fork: parsed.fork } : {}),
        ...(parsed.allowedTools
          ? { allowedTools: parsed.allowedTools.map((rule) => rule.replaceAll(SKILL_DIR, skillDir)) }
          : {}),
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

/**
 * The text of a skill as the model gets it, as in Claude Code: `${CLAUDE_SKILL_DIR}` is its folder,
 * `$ARGUMENTS[N]` the N-th word of the arguments, and arguments with no place in it go after it.
 */
export function skillText(skill: SkillDescriptor, args: string): string {
  const dir = dirname(skill.path);
  const words = (args.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((word) =>
    word.replace(/^(["'])(.*)\1$/s, "$2"),
  );
  const body = skill.body.replaceAll(SKILL_DIR, () => dir);
  const filled = body
    .replace(/\$ARGUMENTS\[(\d+)\]/g, (all, n: string) => words[Number(n)] ?? all)
    .replaceAll("$ARGUMENTS", () => args);
  const tail = filled === body && args.trim() !== "" ? `\n\nARGUMENTS: ${args}` : "";
  return `Skill: ${skill.name}\nBase directory: ${dir} (paths in the skill are relative to it)\n\n${filled}${tail}`;
}

/** A skill as the template of its `/name` command: `$ARGUMENTS[N]` becomes `$N+1` of a command. */
export function skillCommandTemplate(skill: SkillDescriptor): string {
  // A skill that runs in a subagent goes through the skill tool, which starts it.
  if (skill.fork && skill.modelInvocable) {
    return `Run the skill "${skill.name}" now with the skill tool, with the arguments: $ARGUMENTS`;
  }
  const dir = dirname(skill.path);
  const body = skill.body
    .replaceAll(SKILL_DIR, () => dir)
    .replace(/\$ARGUMENTS\[([0-8])\]/g, (_all, n: string) => `$${Number(n) + 1}`);
  const tail = /\$ARGUMENTS|\$[1-9]/.test(body) ? "" : "\n\nARGUMENTS: $ARGUMENTS";
  return `Skill: ${skill.name}\nBase directory: ${dir} (paths in the skill are relative to it)\n\n${body}${tail}`;
}

/** The tool that gives the model the body of one listed skill. */
export function createSkillTool(skills: SkillDescriptor[]): ToolSpec {
  return {
    name: "skill",
    description:
      "Loads the full instructions of a skill that the system prompt lists. Call it before a task that the skill covers.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The name of the skill, as listed." },
        arguments: { type: "string", description: "Arguments for the skill, if the task gives any." },
      },
      required: ["name"],
    },
    riskTier: "safe",
    handler: async (input, ctx) => {
      const skill = skills.find((candidate) => candidate.name === input.name);
      if (!skill) {
        const names = skills.map((candidate) => candidate.name).join(", ");
        return { content: `unknown skill: ${String(input.name)}. The skills are: ${names}`, isError: true };
      }
      if (skill.allowedTools) ctx.grantTools?.(skill.allowedTools);
      const text = skillText(skill, typeof input.arguments === "string" ? input.arguments : "");
      // `context: fork`, as in Claude Code: a subagent runs the skill, and only its answer comes back.
      if (skill.fork && ctx.callTool) {
        const result = await ctx.callTool("spawn", { prompt: text, ...skill.fork });
        if (!(result.isError && result.content.startsWith("no such tool"))) {
          return {
            content: `The skill ${skill.name} ran in a subagent. Its answer:\n\n${result.content}`,
            isError: result.isError,
          };
        }
      }
      return { content: text };
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

  // The skill folders of other agents in the project: Claude Code, the shared `.agents`, Cursor, Codex, Pi, OpenCode, Gemini, Copilot.
  for (const agent of [".claude", ".agents", ".cursor", ".codex", ".pi", ".opencode", ".gemini", ".github"]) {
    dirs.push({ dir: join(workspaceRoot, agent, "skills"), tier: "project" });
  }

  // User-level skills: <configDir>/skills/, then those of the plugins installed for the user.
  dirs.push({ dir: join(configDirOverride ?? configDir(), "skills"), tier: "user" });
  dirs.push({ dir: join(userPluginStore(configDirOverride), ".agency", "skills"), tier: "user" });

  // The user skill folders of other agents: Claude Code, the shared `~/.agents`, Codex, Cursor, Pi, OpenCode, Gemini.
  const home = foreignHome();
  if (home !== undefined) {
    for (const parts of FOREIGN_USER_SKILL_DIRS) dirs.push({ dir: join(home, ...parts), tier: "user" });
  }

  return dirs;
}

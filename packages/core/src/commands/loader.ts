import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { SandboxBoundary } from "@agency/guard";
import { AgencyError } from "@agency/schema";
import { openCodeConfig } from "../config/opencode.ts";
import { configDir, foreignHome, userPluginStore } from "../paths.ts";
import { discoverSkills, resolveSkillDirs, skillCommandTemplate } from "../plugins/skill.ts";
import { expandAtFiles, parseCommandFile, runShellBlocks, substituteArgs } from "./runtime.ts";

export interface CommandTemplate {
  name: string;
  content: string;
  path: string;
  source: "project" | "user";
  description?: string;
  /** The `allowed-tools` of a skill: the turn of its command runs them with no prompt. */
  allowedTools?: string[];
}

/** `.prompt.md` reads the prompt files of Copilot: with no `$ARGUMENTS`, the words of the command go after the prompt. */
function parseCommandFiles(dir: string, source: "project" | "user", ext = ".md"): CommandTemplate[] {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir);
  const out: CommandTemplate[] = [];
  for (const e of entries) {
    if (!e.endsWith(ext)) continue;
    const full = join(dir, e);
    try {
      const st = statSync(full);
      if (!st.isFile()) continue;
      const raw = readFileSync(full, "utf8");
      const text = ext === ".md" || raw.includes("$ARGUMENTS") ? raw : `${raw}\n\n$ARGUMENTS`;
      const name = basename(e, ext);
      // Frontmatter description wins, else the first heading.
      const parsed = parseCommandFile(text);
      let description = parsed.description;
      const lines = text.split("\n");
      for (const line of lines.slice(0, 5)) {
        const m = line.match(/^#\s+(.+)/);
        if (m) {
          description = m[1]?.trim();
          break;
        }
      }
      out.push({ name, content: text, path: full, source, description });
    } catch {}
  }
  return out;
}

/** The prompt of a Gemini CLI command in the syntax of a command here: `{{args}}`, `@{file}` and `!{shell}`. */
export function geminiTemplate(prompt: string): string {
  const body = prompt.replace(/@\{([^}]+)\}/g, "@$1").replace(/!\{([^}]+)\}/g, "!`$1`");
  // As in Gemini CLI: with no `{{args}}`, the words of the command go after the prompt.
  return body.includes("{{args}}") ? body.replaceAll("{{args}}", "$ARGUMENTS") : `${body}\n\n$ARGUMENTS`;
}

/** The TOML commands of Gemini CLI: a file in a subfolder is `<folder>:<name>`. */
function parseGeminiCommands(dir: string, source: "project" | "user"): CommandTemplate[] {
  if (!existsSync(dir)) return [];
  const out: CommandTemplate[] = [];
  for (const entry of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    if (!entry.endsWith(".toml")) continue;
    const full = join(dir, entry);
    try {
      const raw = Bun.TOML.parse(readFileSync(full, "utf8")) as { prompt?: unknown; description?: unknown };
      if (typeof raw.prompt !== "string") continue;
      const name = relative(dir, full)
        .replace(/\.toml$/, "")
        .replace(/[\\/]/g, ":");
      out.push({
        name,
        content: geminiTemplate(raw.prompt),
        path: full,
        source,
        ...(typeof raw.description === "string" ? { description: raw.description } : {}),
      });
    } catch {}
  }
  return out;
}

/** The `command` map of the `opencode.json` of the workspace: each `template`, with its `description`. */
function openCodeCommands(root: string): CommandTemplate[] {
  const commands = openCodeConfig(root).command;
  if (typeof commands !== "object" || commands === null) return [];
  return Object.entries(commands).flatMap(([name, raw]) => {
    const command = raw as { template?: unknown; description?: unknown } | null;
    if (typeof command?.template !== "string" || !/^[\w:.-]+$/.test(name)) return [];
    const description = typeof command.description === "string" ? { description: command.description } : {};
    return [
      {
        name,
        content: command.template,
        path: join(root, "opencode.json"),
        source: "project" as const,
        ...description,
      },
    ];
  });
}

/** The user command folders of other agents, in Markdown with the syntax of Claude Code. */
const FOREIGN_USER_COMMAND_DIRS = [
  [".claude", "commands"],
  [".cursor", "commands"],
  [".codex", "prompts"],
  [".pi", "agent", "prompts"],
  [".config", "opencode", "commands"],
];

/** The command folders of other agents in the project, in Markdown with the syntax of Claude Code. */
const FOREIGN_COMMAND_DIRS = [
  [".claude", "commands"],
  [".cursor", "commands"],
  [".opencode", "commands"],
  [".pi", "prompts"],
];

export function loadCommands(options: {
  workspaceRoot: string;
  configDirOverride?: string;
  /** False for a workspace that the user did not trust: a command file can hold shell blocks, so none loads. */
  projectTrusted?: boolean;
  /** Names of skills the user switched off (`skills.disabled` of the config). */
  disabledSkills?: readonly string[];
}): CommandTemplate[] {
  const root = options.workspaceRoot;
  const projectDir = join(root, ".agency", "commands");
  const userDir = join(options.configDirOverride ?? configDir(), "commands");
  const project =
    options.projectTrusted === false
      ? []
      : [
          ...parseGeminiCommands(join(root, ".gemini", "commands"), "project"),
          ...FOREIGN_COMMAND_DIRS.flatMap((parts) => parseCommandFiles(join(root, ...parts), "project")),
          ...parseCommandFiles(join(root, ".github", "prompts"), "project", ".prompt.md"),
          ...openCodeCommands(root),
          // Last: `.agency/commands` wins on a name.
          ...parseCommandFiles(projectDir, "project"),
        ];
  // The user commands of other agents first: those of Agency win on a name.
  const home = foreignHome();
  const user = [
    ...(home === undefined
      ? []
      : [
          ...parseGeminiCommands(join(home, ".gemini", "commands"), "user"),
          ...FOREIGN_USER_COMMAND_DIRS.flatMap((parts) => parseCommandFiles(join(home, ...parts), "user")),
        ]),
    ...parseCommandFiles(join(userPluginStore(options.configDirOverride), ".agency", "commands"), "user"),
    ...parseCommandFiles(userDir, "user"),
  ];
  // As in Claude Code, a skill is also the command `/<name>`; a command file of the same name wins here.
  const skills = discoverSkills(
    resolveSkillDirs(root, options.configDirOverride).filter(
      (entry) => options.projectTrusted !== false || entry.tier !== "project",
    ),
  ).filter((skill) => skill.userInvocable && !options.disabledSkills?.includes(skill.name));
  // project wins on name collision
  const map = new Map<string, CommandTemplate>();
  for (const skill of skills) {
    map.set(skill.name, {
      name: skill.name,
      content: skillCommandTemplate(skill),
      path: skill.path,
      source: skill.tier,
      ...(skill.description === undefined ? {} : { description: skill.description }),
      ...(skill.allowedTools ? { allowedTools: skill.allowedTools } : {}),
    });
  }
  for (const c of user) map.set(c.name, c);
  for (const c of project) map.set(c.name, c);
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function expandCommand(
  template: string,
  args: string,
  workspaceRoot?: string,
  opts?: {
    shell?: boolean;
    shellCommand?: { command: string; buildArgs: (command: string) => string[] };
    env?: Record<string, string>;
  },
): string {
  const { body } = parseCommandFile(template);
  let out = substituteArgs(body, args);

  // File references: {{file:path}} or $FILE:path or @file:path — include file content
  // We support {{file:relative/path}} and $FILE:relative/path
  if (workspaceRoot) {
    out = expandAtFiles(out, { workspaceRoot });
    const boundary = new SandboxBoundary(workspaceRoot);
    const filePattern = /\{\{file:([^}]+)\}\}/g;
    out = out.replace(filePattern, (_m, p1: string) => {
      try {
        const filePath = boundary.resolvePath(p1.trim());
        const content = readFileSync(filePath, "utf8");
        return content;
      } catch (err) {
        if (err instanceof AgencyError) {
          return `[[blocked: ${p1} resolves outside workspace]]`;
        }
        return `[[missing file: ${p1}]]`;
      }
    });
    const dollarFilePattern = /\$FILE:([^\s]+)/g;
    out = out.replace(dollarFilePattern, (_m, p1: string) => {
      try {
        const filePath = boundary.resolvePath(p1.trim());
        return readFileSync(filePath, "utf8");
      } catch (err) {
        if (err instanceof AgencyError) {
          return `[[blocked: ${p1} resolves outside workspace]]`;
        }
        return `[[missing file: ${p1}]]`;
      }
    });
  }
  if (workspaceRoot && opts?.shell === true)
    out = runShellBlocks(out, {
      cwd: workspaceRoot,
      ...(opts.shellCommand === undefined ? {} : { shell: opts.shellCommand }),
      ...(opts.env === undefined ? {} : { env: opts.env }),
    });

  return out;
}

export function parseSlashInput(input: string): { name: string; args: string } | undefined {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const withoutSlash = trimmed.slice(1);
  const space = withoutSlash.indexOf(" ");
  if (space === -1) return { name: withoutSlash, args: "" };
  return { name: withoutSlash.slice(0, space), args: withoutSlash.slice(space + 1) };
}

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { openCodeConfig } from "../config/opencode.ts";
import { type AgentConfig, DEFAULT_ROSTER, ToolPermissionSchema } from "../config/schema.ts";
import { configDir, foreignHome, userPluginStore } from "../paths.ts";
import { splitFrontmatter } from "../plugins/skill.ts";
import { isFileInside } from "../prompt/instructions.ts";

export const AGENT_FILE_FIELDS = [
  "role",
  "provider",
  "model",
  "effort",
  "tools",
  "permissions",
  "pathScope",
  "replace",
  "description",
  // A Claude Code agent file carries these two. The handle is the file name, and there is no color here.
  "name",
  "color",
] as const;

export type AgentFileField = (typeof AGENT_FILE_FIELDS)[number];

const EFFORTS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"]);
const HANDLE_RE = /^[a-z][a-z0-9-]*$/;

/** The tool names of a Claude Code agent file, as the names of the same tools here. */
const CLAUDE_TOOL_NAMES: Record<string, string> = {
  Read: "read",
  Write: "write",
  Edit: "edit",
  Glob: "glob",
  Grep: "grep",
  Bash: "bash",
  WebFetch: "fetch",
  WebSearch: "websearch",
  TodoWrite: "todo_write",
  NotebookEdit: "notebook_edit",
};
/** The tool sets of a Copilot agent (`edit`, `runCommands`, `edit/editFiles`) as tools here; any other is left out. */
const COPILOT_TOOL_SETS: Record<string, string[]> = {
  edit: ["edit", "notebook_edit", "write"],
  search: ["glob", "grep", "read"],
  codebase: ["glob", "grep", "read"],
  read: ["read"],
  execute: ["bash"],
  runCommands: ["bash"],
  runInTerminal: ["bash"],
  web: ["fetch", "websearch"],
  fetch: ["fetch"],
  todo: ["todo_write"],
  todos: ["todo_write"],
};
/** The tools of OpenCode that the `tools` map of its agent turns off, as tools here. */
const OPENCODE_TOOLS: Record<string, string[]> = {
  write: ["write"],
  edit: ["edit", "notebook_edit"],
  patch: ["edit"],
  bash: ["bash"],
  read: ["read"],
  grep: ["grep"],
  glob: ["glob"],
  webfetch: ["fetch"],
  todowrite: ["todo_write"],
};
/** Model values of a Claude Code agent file that name no model of a provider here: the worker keeps its parent's model. */
const CLAUDE_MODEL_ALIASES = new Set(["inherit", "sonnet", "opus", "haiku"]);

export type AgentSource = "project" | "user" | "config" | "seed" | "plugin";

export interface FileAgentDef {
  handle: string;
  role: string;
  /** When to use the agent. With one, the agent is a type of the spawn tool. */
  description?: string;
  provider?: string;
  model?: string;
  effort?: AgentConfig["effort"];
  tools?: string[];
  permissions?: AgentConfig["permissions"];
  pathScope?: string[];
  // Bodies extend the built-in role prompt unless replace is true.
  replace?: boolean;
  systemPrompt: string;
  source: AgentSource;
  file?: string;
}

function fail(file: string, field: string, detail: string): never {
  throw new Error(`agent file ${file}: field "${field}" ${detail}`);
}

function parseStringList(raw: string, file: string, field: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      fail(file, field, "is not valid JSON");
    }
    if (!Array.isArray(parsed) || !parsed.every((e) => typeof e === "string" && e.length > 0)) {
      fail(file, field, "must be a JSON array of non-empty strings");
    }
    return [...(parsed as string[])].sort();
  }
  const out = trimmed
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
  if (out.length === 0) fail(file, field, "must list at least one value");
  return [...new Set(out)].sort();
}

/**
 * Parse one agent file: strict frontmatter, body is the role prompt. `foreign` reads the file of another agent: its
 * other keys are left out, `readonly` of Cursor gives the read tools, and a `provider/model` of OpenCode is split.
 */
export function parseAgentFile(
  text: string,
  file: string,
  foreign: boolean | "copilot" = false,
): FileAgentDef {
  const handle = basename(file).replace(/(\.agent|\.chatmode)?\.md$/, "");
  if (!HANDLE_RE.test(handle)) {
    throw new Error(`agent file ${file}: handle "${handle}" must match [a-z][a-z0-9-]*`);
  }
  const split = splitFrontmatter(text);
  if (!split.hasFrontmatter) {
    throw new Error(`agent file ${file}: missing frontmatter (role: is required)`);
  }
  for (const key of Object.keys(split.fields)) {
    if (foreign) continue;
    if (!(AGENT_FILE_FIELDS as readonly string[]).includes(key)) {
      throw new Error(`agent file ${file}: unknown field "${key}"`);
    }
  }
  const role = split.fields.role ?? handle;
  if (role.length === 0) fail(file, "role", "is required");
  const body = split.body.trim();
  if (body.length === 0) fail(file, "body", "is empty: the body is the role prompt");
  const def: FileAgentDef = {
    handle,
    role,
    systemPrompt: body,
    source: "project",
    file,
  };
  const provider = split.fields.provider;
  if (provider !== undefined) {
    if (provider.length === 0) fail(file, "provider", "must be non-empty");
    def.provider = provider;
  }
  // A Copilot agent keeps the parent's model: Copilot names a model for display only (`GPT-5 (copilot)`).
  let model = foreign === "copilot" ? undefined : split.fields.model;
  const slash = model?.indexOf("/") ?? -1;
  if (foreign && model !== undefined && slash > 0 && split.fields.provider === undefined) {
    def.provider = model.slice(0, slash);
    model = model.slice(slash + 1);
  }
  if (model !== undefined && !CLAUDE_MODEL_ALIASES.has(model)) {
    if (model.length === 0) fail(file, "model", "must be non-empty");
    def.model = model;
  }
  if (split.fields.description !== undefined) def.description = split.fields.description;
  const effort = split.fields.effort;
  if (effort !== undefined) {
    if (!EFFORTS.has(effort)) {
      fail(file, "effort", `must be one of ${[...EFFORTS].join("|")}, got "${effort}"`);
    }
    def.effort = effort as AgentConfig["effort"];
  }
  if (foreign === "copilot" && split.fields.tools !== undefined) {
    // ponytail: an agent of only MCP or unknown tool sets gets the read tools, not every tool.
    const sets = split.fields.tools.replace(/[[\]'"]/g, "").split(",");
    const tools = sets.flatMap((set) => COPILOT_TOOL_SETS[set.trim().split("/")[0] ?? ""] ?? []);
    def.tools = tools.length > 0 ? [...new Set(tools)].sort() : ["glob", "grep", "read"];
  } else if (split.fields.tools !== undefined) {
    def.tools = parseStringList(split.fields.tools, file, "tools").map(
      (name) => CLAUDE_TOOL_NAMES[name] ?? name,
    );
  } else if (foreign && split.fields.readonly === "true") {
    def.tools = ["glob", "grep", "read"];
  }
  if (split.fields.permissions !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(split.fields.permissions);
    } catch {
      fail(file, "permissions", "is not valid JSON");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      fail(file, "permissions", "must be a JSON object");
    }
    const out: NonNullable<AgentConfig["permissions"]> = {};
    for (const [tool, value] of Object.entries(parsed as Record<string, unknown>)) {
      const check = ToolPermissionSchema.safeParse(value);
      if (!check.success)
        fail(file, "permissions", `entry "${tool}" must be allow|ask|deny or a pattern map`);
      out[tool] = check.data;
    }
    def.permissions = out;
  }
  if (split.fields.pathScope !== undefined) {
    def.pathScope = parseStringList(split.fields.pathScope, file, "pathScope");
  }
  const replace = split.fields.replace;
  if (replace !== undefined) {
    if (replace !== "true" && replace !== "false") fail(file, "replace", 'must be "true" or "false"');
    def.replace = replace === "true";
  }
  return def;
}

/** An agent definition as the text of an agent file here: a plugin agent of another format is installed so. */
export function renderAgentFile(def: FileAgentDef): string {
  const fields: Array<[string, string | undefined]> = [
    ["role", def.role],
    ["description", def.description],
    ["provider", def.provider],
    ["model", def.model],
    ["effort", def.effort],
    ["tools", def.tools?.join(", ")],
  ];
  const lines = fields.filter(([, value]) => value !== undefined).map(([key, value]) => `${key}: ${value}`);
  return `---\n${lines.join("\n")}\n---\n${def.systemPrompt}\n`;
}

export function agentFileName(handle: string): string {
  return `${handle}.md`;
}

/** Handles double as filenames and registry keys, so both stay strict. */
export function isValidAgentHandle(handle: string): boolean {
  return HANDLE_RE.test(handle);
}

function discoverAgentFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith(".md")) continue;
    const full = join(dir, entry);
    try {
      if (readFileSync(full, "utf8") !== undefined) out.push(full);
    } catch {
      // Race: file vanished between readdir and read.
    }
  }
  return out;
}

/** A file that is not valid is skipped: one bad file must not take every other agent away. */
function loadAgentDir(
  dir: string,
  source: AgentSource,
  warn: (message: string) => void,
  foreign: boolean | "copilot" = false,
): Map<string, FileAgentDef> {
  const out = new Map<string, FileAgentDef>();
  for (const file of discoverAgentFiles(dir)) {
    try {
      const def = parseAgentFile(readFileSync(file, "utf8"), file, foreign);
      out.set(def.handle, { ...def, source, file });
    } catch (error) {
      warn(`skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return out;
}

function toFileDef(handle: string, agent: AgentConfig, source: AgentSource): FileAgentDef {
  return {
    handle,
    role: agent.role,
    ...(agent.provider !== undefined ? { provider: agent.provider } : {}),
    ...(agent.model !== undefined ? { model: agent.model } : {}),
    ...(agent.effort !== undefined ? { effort: agent.effort } : {}),
    ...(agent.permissions !== undefined ? { permissions: agent.permissions } : {}),
    systemPrompt: "",
    source,
  };
}

/** Render one roster entry as seed file content. */
export function renderSeedAgentFile(agent: AgentConfig): string {
  const lines = [`role: ${agent.role}`];
  if (agent.provider) lines.push(`provider: ${agent.provider}`);
  if (agent.model) lines.push(`model: ${agent.model}`);
  if (agent.effort) lines.push(`effort: ${agent.effort}`);
  if (agent.permissions) lines.push(`permissions: ${JSON.stringify(agent.permissions)}`);
  return `---\n${lines.join("\n")}\n---\nYou are ${agent.role}, an agency team agent.\n`;
}

/** Write DEFAULT_ROSTER entries missing from the project dir. Returns files written. */
export function ensureSeedAgents(
  workspaceRoot: string,
  base: Record<string, AgentConfig> = DEFAULT_ROSTER,
): string[] {
  if (!existsSync(workspaceRoot)) return [];
  const dir = join(workspaceRoot, ".agency", "agents");
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  for (const [handle, agent] of Object.entries(base)) {
    const file = join(dir, agentFileName(handle));
    if (existsSync(file)) continue;
    writeFileSync(file, renderSeedAgentFile(agent), "utf8");
    written.push(file);
  }
  return written;
}

export interface ResolveFileRosterOptions {
  workspaceRoot: string;
  configDirOverride?: string;
  configAgents?: Record<string, AgentConfig>;
  seed?: boolean;
  /** False for a workspace that the user did not trust: an agent file can grant itself tools, so none loads. */
  projectTrusted?: boolean;
  /** Gets a line for each agent file that is skipped. */
  warn?: (message: string) => void;
}

export interface FileRoster {
  agents: Map<string, FileAgentDef>;
  seeded: boolean;
}

const FOREIGN_USER_AGENT_DIRS = [
  [".claude", "agents"],
  [".cursor", "agents"],
  [".codex", "agents"],
  [".config", "opencode", "agents"],
];

/**
 * The subagents of the `agent` map of the `opencode.json` of a workspace: `prompt` (with `{file:path}` inside the
 * workspace), `description`, `model` as `provider/model`, and a `tools` map whose `false` denies a tool. A primary
 * agent of OpenCode (`build`, `plan`) and one with no prompt are left out.
 */
function openCodeAgents(workspaceRoot: string, warn: (message: string) => void): Map<string, FileAgentDef> {
  const out = new Map<string, FileAgentDef>();
  const file = join(workspaceRoot, "opencode.json");
  const agents = openCodeConfig(workspaceRoot).agent;
  for (const [handle, raw] of Object.entries(typeof agents === "object" && agents !== null ? agents : {})) {
    const agent = raw as Record<string, unknown>;
    if (agent?.disable === true || agent.mode === "primary" || typeof agent.prompt !== "string") continue;
    if (!HANDLE_RE.test(handle)) {
      warn(`skipped: the agent "${handle}" of ${file} needs a name that matches [a-z][a-z0-9-]*`);
      continue;
    }
    const prompt = agent.prompt.replace(/\{file:([^}]+)\}/g, (match, path: string) => {
      const target = resolve(dirname(file), path);
      return isFileInside(workspaceRoot, target) ? readFileSync(target, "utf8") : match;
    });
    const def: FileAgentDef = { handle, role: handle, systemPrompt: prompt.trim(), source: "project", file };
    if (typeof agent.description === "string") def.description = agent.description;
    const slash = typeof agent.model === "string" ? agent.model.indexOf("/") : -1;
    if (typeof agent.model === "string" && slash > 0) {
      def.provider = agent.model.slice(0, slash);
      def.model = agent.model.slice(slash + 1);
    }
    const tools = typeof agent.tools === "object" && agent.tools !== null ? agent.tools : {};
    const off = Object.entries(tools).flatMap(([name, on]) =>
      on === false ? (OPENCODE_TOOLS[name] ?? []) : [],
    );
    if (off.length > 0) def.permissions = Object.fromEntries(off.map((tool) => [tool, "deny" as const]));
    if (def.systemPrompt !== "") out.set(handle, def);
  }
  return out;
}

/** Merge order: config/seed base, then user files, then project files. */
export function resolveFileRoster(opts: ResolveFileRosterOptions): FileRoster {
  const base = opts.configAgents ?? DEFAULT_ROSTER;
  const merged = new Map<string, FileAgentDef>();
  for (const [handle, agent] of Object.entries(base)) merged.set(handle, toFileDef(handle, agent, "config"));
  let seeded = false;
  // No seed in an untrusted workspace: the files would not load, and their folder would look like project content.
  if (opts.seed !== false && opts.projectTrusted !== false) {
    const written = ensureSeedAgents(opts.workspaceRoot, base);
    seeded = written.length > 0;
  }
  const userDir = join(opts.configDirOverride ?? configDir(), "agents");
  const warn = opts.warn ?? (() => {});
  // The user agent files of other agents, then those of Agency, which win on a handle.
  const home = foreignHome();
  for (const parts of home === undefined ? [] : FOREIGN_USER_AGENT_DIRS) {
    for (const [handle, def] of loadAgentDir(join(home ?? "", ...parts), "user", warn, true))
      merged.set(handle, def);
  }
  const storeDir = join(userPluginStore(opts.configDirOverride), ".agency", "agents");
  for (const [handle, def] of loadAgentDir(storeDir, "user", warn)) merged.set(handle, def);
  for (const [handle, def] of loadAgentDir(userDir, "user", warn)) merged.set(handle, def);
  if (opts.projectTrusted === false) return { agents: merged, seeded };
  // The agent folders of Claude Code, Cursor, Codex and OpenCode in the project; `.agency/agents` wins on a handle.
  for (const agent of [".claude", ".cursor", ".codex", ".opencode"]) {
    for (const [handle, def] of loadAgentDir(
      join(opts.workspaceRoot, agent, "agents"),
      "project",
      warn,
      true,
    )) {
      merged.set(handle, def);
    }
  }
  for (const [handle, def] of openCodeAgents(opts.workspaceRoot, warn)) merged.set(handle, def);
  // The custom agents of Copilot, after its older chat modes.
  for (const dir of ["chatmodes", "agents"]) {
    for (const [handle, def] of loadAgentDir(
      join(opts.workspaceRoot, ".github", dir),
      "project",
      warn,
      "copilot",
    ))
      merged.set(handle, def);
  }
  const projectDir = join(opts.workspaceRoot, ".agency", "agents");
  for (const [handle, def] of loadAgentDir(projectDir, "project", warn)) merged.set(handle, def);
  return { agents: merged, seeded };
}

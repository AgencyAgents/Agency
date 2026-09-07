import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { type AgentConfig, DEFAULT_ROSTER, ToolPermissionSchema } from "../config/schema.ts";
import { configDir } from "../paths.ts";
import { splitFrontmatter } from "../plugins/skill.ts";

export const AGENT_FILE_FIELDS = [
  "role",
  "provider",
  "model",
  "effort",
  "tools",
  "permissions",
  "pathScope",
  "replace",
] as const;

export type AgentFileField = (typeof AGENT_FILE_FIELDS)[number];

const EFFORTS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"]);
const HANDLE_RE = /^[a-z][a-z0-9-]*$/;

export type AgentSource = "project" | "user" | "config" | "seed" | "plugin";

export interface FileAgentDef {
  handle: string;
  role: string;
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

/** Parse one agent file: strict frontmatter, body is the role prompt. */
export function parseAgentFile(text: string, file: string): FileAgentDef {
  const handle = basename(file, ".md");
  if (!HANDLE_RE.test(handle)) {
    throw new Error(`agent file ${file}: handle "${handle}" must match [a-z][a-z0-9-]*`);
  }
  const split = splitFrontmatter(text);
  if (!split.hasFrontmatter) {
    throw new Error(`agent file ${file}: missing frontmatter (role: is required)`);
  }
  for (const key of Object.keys(split.fields)) {
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
  const model = split.fields.model;
  if (model !== undefined) {
    if (model.length === 0) fail(file, "model", "must be non-empty");
    def.model = model;
  }
  const effort = split.fields.effort;
  if (effort !== undefined) {
    if (!EFFORTS.has(effort)) {
      fail(file, "effort", `must be one of ${[...EFFORTS].join("|")}, got "${effort}"`);
    }
    def.effort = effort as AgentConfig["effort"];
  }
  if (split.fields.tools !== undefined) def.tools = parseStringList(split.fields.tools, file, "tools");
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

function loadAgentDir(dir: string, source: AgentSource): Map<string, FileAgentDef> {
  const out = new Map<string, FileAgentDef>();
  for (const file of discoverAgentFiles(dir)) {
    const def = parseAgentFile(readFileSync(file, "utf8"), file);
    out.set(def.handle, { ...def, source, file });
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
}

export interface FileRoster {
  agents: Map<string, FileAgentDef>;
  seeded: boolean;
}

/** Merge order: config/seed base, then user files, then project files. */
export function resolveFileRoster(opts: ResolveFileRosterOptions): FileRoster {
  const base = opts.configAgents ?? DEFAULT_ROSTER;
  const merged = new Map<string, FileAgentDef>();
  for (const [handle, agent] of Object.entries(base)) merged.set(handle, toFileDef(handle, agent, "config"));
  let seeded = false;
  if (opts.seed !== false) {
    const written = ensureSeedAgents(opts.workspaceRoot, base);
    seeded = written.length > 0;
  }
  const userDir = join(opts.configDirOverride ?? configDir(), "agents");
  for (const [handle, def] of loadAgentDir(userDir, "user")) merged.set(handle, def);
  const projectDir = join(opts.workspaceRoot, ".agency", "agents");
  for (const [handle, def] of loadAgentDir(projectDir, "project")) merged.set(handle, def);
  return { agents: merged, seeded };
}

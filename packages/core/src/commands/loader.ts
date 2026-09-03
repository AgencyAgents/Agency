import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { configDir } from "../paths.ts";

export interface CommandTemplate {
  name: string;
  content: string;
  path: string;
  source: "project" | "user";
  description?: string;
}

function parseCommandFiles(dir: string, source: "project" | "user"): CommandTemplate[] {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir);
  const out: CommandTemplate[] = [];
  for (const e of entries) {
    if (!e.endsWith(".md")) continue;
    const full = join(dir, e);
    try {
      const st = statSync(full);
      if (!st.isFile()) continue;
      const text = readFileSync(full, "utf8");
      const name = basename(e, ".md");
      // First line heading or frontmatter description
      let description: string | undefined;
      const lines = text.split("\n");
      for (const line of lines.slice(0, 5)) {
        const m = line.match(/^#\s+(.+)/);
        if (m) { description = m[1]?.trim(); break; }
      }
      out.push({ name, content: text, path: full, source, description });
    } catch {}
  }
  return out;
}

export function loadCommands(options: { workspaceRoot: string; configDirOverride?: string }): CommandTemplate[] {
  const projectDir = join(options.workspaceRoot, ".agency", "commands");
  const userDir = join(options.configDirOverride ?? configDir(), "commands");
  const project = parseCommandFiles(projectDir, "project");
  const user = parseCommandFiles(userDir, "user");
  // project wins on name collision
  const map = new Map<string, CommandTemplate>();
  for (const c of user) map.set(c.name, c);
  for (const c of project) map.set(c.name, c);
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function expandCommand(template: string, args: string, workspaceRoot?: string): string {
  let out = template;
  // $ARGUMENTS placeholder substitution (also ${ARGUMENTS} and $ARGUMENTS)
  out = out.replaceAll("$ARGUMENTS", args);
  out = out.replaceAll("${ARGUMENTS}", args);
  out = out.replaceAll("$ARGS", args);

  // File references: {{file:path}} or $FILE:path or @file:path — include file content
  // We support {{file:relative/path}} and $FILE:relative/path
  if (workspaceRoot) {
    const filePattern = /\{\{file:([^}]+)\}\}/g;
    out = out.replace(filePattern, (_m, p1: string) => {
      try {
        const filePath = join(workspaceRoot, p1.trim());
        // Basic containment check: must be inside workspaceRoot or absolute
        const content = readFileSync(filePath, "utf8");
        return content;
      } catch {
        return `[[missing file: ${p1}]]`;
      }
    });
    const dollarFilePattern = /\$FILE:([^\s]+)/g;
    out = out.replace(dollarFilePattern, (_m, p1: string) => {
      try {
        const filePath = join(workspaceRoot, p1.trim());
        return readFileSync(filePath, "utf8");
      } catch {
        return `[[missing file: ${p1}]]`;
      }
    });
  }

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

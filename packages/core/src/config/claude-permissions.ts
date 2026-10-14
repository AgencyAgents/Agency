import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Decision,
  isCommandPatternTool,
  isPathPatternTool,
  type ToolPermissionValue,
} from "@agency/guard";
import { parse as parseJsonc } from "jsonc-parser";
import { foreignHome } from "../paths.ts";
import { agencyToolName } from "../plugins/command-hooks.ts";

/**
 * Permission rules of Claude Code (`Bash(git push *)`, `Edit(src/**)`, `WebFetch`, `mcp__github__create_issue`) as
 * the `permissions` map here. Later lists win on a call that two rules match: allow, then ask, then deny. A rule with
 * no counterpart here (a path outside the workspace, a domain rule, a whole MCP server) goes to `skipped`.
 */
export function permissionsFromRules(lists: { allow?: unknown; ask?: unknown; deny?: unknown }): {
  permissions: Record<string, ToolPermissionValue>;
  skipped: string[];
} {
  const maps: Record<string, Record<string, Decision>> = {};
  const skipped: string[] = [];
  for (const decision of ["allow", "ask", "deny"] as const) {
    const rules = lists[decision];
    for (const rule of Array.isArray(rules) ? rules : []) {
      if (typeof rule !== "string") continue;
      const parsed = /^([^()]+?)(?:\(([\s\S]*)\))?$/.exec(rule.trim());
      const tool = parsed?.[1] === undefined ? undefined : agencyToolName(parsed[1].trim());
      // `Bash(npm run test:*)` is the older form of `Bash(npm run test *)`.
      const pattern = parsed?.[2]?.trim().replace(/:\*$/, " *");
      let key: string | undefined;
      if (tool === undefined) key = undefined;
      // A path glob `*` stays in one folder: all paths are `**`.
      else if (pattern === undefined || pattern === "" || pattern === "*" || pattern === "**")
        key = isPathPatternTool(tool) ? "**" : "*";
      else if (isCommandPatternTool(tool)) key = pattern;
      else if (isPathPatternTool(tool) && !/^(\/|~|\.\.)/.test(pattern)) key = pattern.replace(/^\.\//, "");
      if (tool === undefined || key === undefined) {
        skipped.push(rule);
        continue;
      }
      const map = maps[tool] ?? {};
      maps[tool] = map;
      // A rule that comes again moves to the end, so the later list still wins.
      delete map[key];
      map[key] = decision;
    }
  }
  const permissions: Record<string, ToolPermissionValue> = {};
  for (const [tool, map] of Object.entries(maps)) {
    const keys = Object.keys(map);
    const bare = keys.length === 1 && (keys[0] === "*" || keys[0] === "**");
    permissions[tool] = bare ? (map[keys[0] as string] as Decision) : map;
  }
  return { permissions, skipped };
}

/**
 * The `permissions` of the settings files of Claude Code: `~/.claude/settings.json`, then `.claude/settings.json` and
 * `.claude/settings.local.json` of a trusted workspace. As in Claude Code, a deny rule of any file wins.
 */
export function loadClaudePermissions(
  workspaceRoot: string,
  projectTrusted: boolean,
  warn: (message: string) => void = () => {},
): Record<string, ToolPermissionValue> {
  const home = foreignHome();
  const files = [
    ...(home === undefined ? [] : [join(home, ".claude", "settings.json")]),
    ...(projectTrusted
      ? [
          join(workspaceRoot, ".claude", "settings.json"),
          join(workspaceRoot, ".claude", "settings.local.json"),
        ]
      : []),
  ];
  const lists: Record<"allow" | "ask" | "deny", unknown[]> = { allow: [], ask: [], deny: [] };
  for (const file of files) {
    if (!existsSync(file)) continue;
    const raw = parseJsonc(readFileSync(file, "utf8"), [], { allowTrailingComma: true }) as {
      permissions?: Record<string, unknown>;
    };
    for (const decision of ["allow", "ask", "deny"] as const) {
      const rules = raw?.permissions?.[decision];
      if (Array.isArray(rules)) lists[decision].push(...rules);
    }
  }
  const { permissions, skipped } = permissionsFromRules(lists);
  if (skipped.length > 0)
    warn(`permission rules of Claude Code with no counterpart here: ${skipped.join(", ")}`);
  return permissions;
}

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { foreignHome } from "../paths.ts";

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const readJson = (file: string): Record<string, unknown> =>
  existsSync(file) ? record(parseJsonc(readFileSync(file, "utf8"), [], { allowTrailingComma: true })) : {};

/** The settings files of Claude Code in a workspace, the one that wins last. */
const projectSettings = (workspaceRoot: string): string[] => [
  join(workspaceRoot, ".claude", "settings.json"),
  join(workspaceRoot, ".claude", "settings.local.json"),
];

/** The plugins that the settings of Claude Code in a workspace enable, as `plugin@marketplace`. */
export function claudeEnabledPlugins(workspaceRoot: string): string[] {
  const enabled: Record<string, unknown> = {};
  for (const file of projectSettings(workspaceRoot))
    Object.assign(enabled, record(readJson(file).enabledPlugins));
  return Object.entries(enabled)
    .filter(([id, on]) => on === true && /^[\w.-]+@[\w.-]+$/.test(id))
    .map(([id]) => id);
}

/** A marketplace source of Claude Code as a source of `plugin install` here: a folder, `owner/repo#ref` or a git URL. */
function installSource(raw: unknown, workspaceRoot: string): string {
  const source = record(raw);
  const ref = typeof source.ref === "string" ? `#${source.ref}` : "";
  if (source.source === "directory" && typeof source.path === "string")
    return resolve(workspaceRoot, source.path);
  if (typeof source.path === "string") {
    throw new Error(`a marketplace in the subfolder ${source.path} of a repository cannot be installed here`);
  }
  if (source.source === "github" && typeof source.repo === "string") return `${source.repo}${ref}`;
  if (source.source === "git" && typeof source.url === "string") return `${source.url}${ref}`;
  throw new Error(`a marketplace of the source type "${String(source.source)}" cannot be installed here`);
}

/**
 * Where a marketplace of Claude Code is: `extraKnownMarketplaces` (or `additionalMarketplaces`) of the settings of the
 * workspace, then of the user, then the marketplaces that Claude Code added, whose local copy goes first, then the
 * official one. Undefined when nothing names it.
 */
export function claudeMarketplaceSource(
  name: string,
  workspaceRoot: string,
  home: string | undefined = foreignHome(),
): string | undefined {
  const files = [
    ...projectSettings(workspaceRoot).reverse(),
    ...(home === undefined ? [] : [join(home, ".claude", "settings.json")]),
  ];
  for (const file of files) {
    const settings = readJson(file);
    const entry =
      record(settings.extraKnownMarketplaces)[name] ?? record(settings.additionalMarketplaces)[name];
    if (entry !== undefined) return installSource(record(entry).source, workspaceRoot);
  }
  if (home !== undefined) {
    const known = record(readJson(join(home, ".claude", "plugins", "known_marketplaces.json"))[name]);
    if (typeof known.installLocation === "string" && existsSync(known.installLocation))
      return known.installLocation;
    if (known.source !== undefined) return installSource(known.source, workspaceRoot);
  }
  return name === "claude-plugins-official" ? "anthropics/claude-plugins-official" : undefined;
}

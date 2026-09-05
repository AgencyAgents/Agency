import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { isPlanPath, LEGACY_PLAN_DIR, PLAN_DIR, WORKING_PLAN_DIR } from "./plan.ts";

/** Tools usable in plan mode without a plan-file target. */
export const PLAN_MODE_READ_TOOLS: readonly string[] = ["read", "glob", "grep", "question", "plan_exit"];

/** Rewrite a legacy or working plan path to the canonical dir. */
export function resolvePlanPath(p: string): string {
  const n = p.replace(/\\/g, "/");
  const mapped = redirectPlanSlashes(n);
  return p.includes("\\") ? mapped.replace(/\//g, "\\") : mapped;
}

/** Slash-normalized redirect, extracted for single-purpose clarity. */
function redirectPlanSlashes(n: string): string {
  for (const alias of [LEGACY_PLAN_DIR, WORKING_PLAN_DIR]) {
    if (n === alias) return PLAN_DIR;
    if (n.startsWith(`${alias}/`)) return `${PLAN_DIR}${n.slice(alias.length)}`;
    const seg = `/${alias}/`;
    const at = n.indexOf(seg);
    if (at >= 0) return `${n.slice(0, at)}/${PLAN_DIR}${n.slice(at + seg.length - 1)}`;
  }
  return n;
}

/** True when a tool call is allowed in plan mode. */
export function planModeAllowsTool(toolName: string, targetPath?: string): boolean {
  if (PLAN_MODE_READ_TOOLS.includes(toolName)) return true;
  if (toolName === "write" || toolName === "edit") {
    return targetPath !== undefined && isPlanPath(resolvePlanPath(targetPath));
  }
  return false;
}

/** Rejection reason for a plan-mode call, undefined when allowed. */
export function planModeRejectReason(toolName: string, targetPath?: string): string | undefined {
  if (planModeAllowsTool(toolName, targetPath)) return undefined;
  const target = targetPath === undefined ? "with no target path" : `for ${targetPath}`;
  return `plan mode denies ${toolName} ${target}: only read-only inspection and plan-file writes are allowed`;
}

const SIDECAR_SUFFIXES: readonly string[] = [".approval.json", ".comments.json"];

/** Copy one plan file into the canonical dir with its sidecars. */
export function copyPlanToCanonical(sourceAbsPath: string): string {
  const dest = resolvePlanPath(sourceAbsPath);
  mkdirSync(dirname(dest), { recursive: true });
  if (dest !== sourceAbsPath) copyFileSync(sourceAbsPath, dest);
  for (const suffix of SIDECAR_SUFFIXES) {
    const side = `${sourceAbsPath}${suffix}`;
    if (existsSync(side) && `${dest}${suffix}` !== side) copyFileSync(side, `${dest}${suffix}`);
  }
  return dest;
}

/** Plan files and their sidecars, nothing else migrates. */
function isMigratablePlanFile(name: string): boolean {
  return name.endsWith(".md") || name.endsWith(".md.approval.json") || name.endsWith(".md.comments.json");
}

/** Copy a legacy or working plan dir wholesale to canonical. */
export function migratePlanDirectory(sourceDirAbs: string, destDirAbs: string): string[] {
  mkdirSync(destDirAbs, { recursive: true });
  const copied: string[] = [];
  for (const entry of readdirSync(sourceDirAbs, { withFileTypes: true })) {
    if (!entry.isFile() || !isMigratablePlanFile(entry.name)) continue;
    const dest = join(destDirAbs, entry.name);
    if (join(sourceDirAbs, entry.name) !== dest) copyFileSync(join(sourceDirAbs, entry.name), dest);
    copied.push(dest);
  }
  return copied.sort();
}

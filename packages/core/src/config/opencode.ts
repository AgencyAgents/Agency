import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";

/** The `opencode.json` (or `opencode.jsonc`) of a folder; empty when there is none or it is not an object. */
export function openCodeConfig(dir: string): Record<string, unknown> {
  const file = ["opencode.json", "opencode.jsonc"].map((name) => join(dir, name)).find(existsSync);
  if (file === undefined) return {};
  const raw: unknown = parseJsonc(readFileSync(file, "utf8"), [], { allowTrailingComma: true });
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

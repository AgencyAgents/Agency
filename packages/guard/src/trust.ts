import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { AgencyError, ErrorCode } from "@agency/schema";

export interface TrustStore {
  isTrusted(path: string): boolean;
  trust(path: string): void;
  distrust(path: string): void;
}

/**
 * Persists trust decisions as a flat JSON list on disk. A directory is
 * untrusted until explicitly confirmed: repo-provided instructions and
 * config must not load before that (R2/trust gate: AGENTS.md is an
 * injection surface).
 */
export function createFileTrustStore(storePath: string): TrustStore {
  function read(): string[] {
    if (!existsSync(storePath)) return [];
    try {
      const parsed = JSON.parse(readFileSync(storePath, "utf8"));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function write(paths: string[]): void {
    mkdirSync(dirname(storePath), { recursive: true });
    writeFileSync(storePath, JSON.stringify(paths, null, 2));
  }

  return {
    isTrusted(path) {
      return read().includes(path);
    },
    trust(path) {
      const paths = read();
      if (!paths.includes(path)) write([...paths, path]);
    },
    distrust(path) {
      write(read().filter((p) => p !== path));
    },
  };
}

/** Throws PERMISSION_DENIED if `path` hasn't been explicitly trusted. */
export function requireTrust(store: TrustStore, path: string): void {
  if (store.isTrusted(path)) return;
  throw new AgencyError(ErrorCode.PERMISSION_DENIED, `"${path}" is not a trusted directory`, {
    source: "trust",
    context: { path },
  });
}

import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { AgencyError, ErrorCode } from "@agency/schema";

export interface CommandPolicy {
  /** If set, a command must match at least one pattern to be allowed. */
  allow?: readonly RegExp[];
  /** Checked first: a match here is always denied, even if also allowlisted. */
  deny?: readonly RegExp[];
}

/**
 * Bounds where tool execution is allowed to touch: a resolved-path scope and
 * a command allow/deny policy. This is a software boundary, not OS isolation.
 * It's the seam future work (containers, namespaces) plugs into without any
 * caller changing (R2).
 */
export class SandboxBoundary {
  constructor(
    private readonly root: string,
    private readonly commandPolicy: CommandPolicy = {},
  ) {}

  /** Resolves `candidate` against the root and rejects anything that escapes it.
   *  Symlinks (and Windows junctions) are dereferenced first: a link inside the
   *  workspace pointing outside it must not hide its real target behind an
   *  in-root path. */
  resolvePath(candidate: string): string {
    const normalizedRoot = canonicalPath(this.root);
    const resolved = canonicalPath(resolve(this.root, candidate));
    if (resolved !== normalizedRoot && !resolved.startsWith(`${normalizedRoot}${sep()}`)) {
      throw new AgencyError(ErrorCode.PERMISSION_DENIED, `"${candidate}" resolves outside the sandbox root`, {
        source: "sandbox",
        context: { candidate, root: normalizedRoot },
      });
    }
    return resolved;
  }

  /** Throws PERMISSION_DENIED if `command` is deny-matched, or unmatched under an allowlist. */
  checkCommand(command: string): void {
    for (const pattern of this.commandPolicy.deny ?? []) {
      if (pattern.test(command)) {
        throw new AgencyError(ErrorCode.PERMISSION_DENIED, `command is explicitly denied: ${command}`, {
          source: "sandbox",
          context: { command, pattern: pattern.source },
        });
      }
    }

    const allow = this.commandPolicy.allow;
    if (allow && allow.length > 0 && !allow.some((pattern) => pattern.test(command))) {
      throw new AgencyError(ErrorCode.PERMISSION_DENIED, `command is not on the allowlist: ${command}`, {
        source: "sandbox",
        context: { command },
      });
    }
  }
}

function sep(): string {
  return process.platform === "win32" ? "\\" : "/";
}

/**
 * Canonicalizes `path` through realpath so symlinked components are dereferenced.
 * Not-yet-existing components (a file a tool is about to create) can't be
 * dereferenced, so the deepest existing ancestor is resolved instead and the
 * missing tail re-appended — that still catches a symlinked parent directory.
 */
function canonicalPath(path: string): string {
  const resolved = resolve(path);
  let current = resolved;
  let tail = "";
  while (true) {
    try {
      const real = realpathSync(current);
      if (tail === "") return real;
      return real.endsWith(sep()) ? real + tail : `${real}${sep()}${tail}`;
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolved; // reached the filesystem root without resolving
      tail = tail === "" ? basename(current) : `${basename(current)}${sep()}${tail}`;
      current = parent;
    }
  }
}

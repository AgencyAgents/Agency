import { resolve } from "node:path";
import { AgencyError, ErrorCode } from "@agency/schema";

export interface CommandPolicy {
  /** If set, a command must match at least one pattern to be allowed. */
  allow?: readonly RegExp[];
  /** Checked first — a match here is always denied, even if also allowlisted. */
  deny?: readonly RegExp[];
}

/**
 * Bounds where tool execution is allowed to touch: a resolved-path scope and
 * a command allow/deny policy. This is a software boundary, not OS isolation —
 * it's the seam future work (containers, namespaces) plugs into without any
 * caller changing (R2).
 */
export class SandboxBoundary {
  constructor(
    private readonly root: string,
    private readonly commandPolicy: CommandPolicy = {},
  ) {}

  /** Resolves `candidate` against the root and rejects anything that escapes it. */
  resolvePath(candidate: string): string {
    const resolved = resolve(this.root, candidate);
    const normalizedRoot = resolve(this.root);
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

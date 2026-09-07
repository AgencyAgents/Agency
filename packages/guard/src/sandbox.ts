import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { AgencyError, ErrorCode } from "@agency/schema";
import type { RequestApproval } from "./approval.ts";
import type { Decision } from "./policy.ts";

export interface CommandPolicy {
  /** If set, a command must match at least one pattern to be allowed. */
  allow?: readonly RegExp[];
  /** Checked first: a match here is always denied, even if also allowlisted. */
  deny?: readonly RegExp[];
}

/**
 * Decides the verdict for a path that resolves OUTSIDE the sandbox root:
 * "deny" refuses (the historical default), "allow" admits it, "ask" routes
 * through the approval callback. Wired from the `external_directory`
 * permission config.
 */
export type ExternalDirectoryDecision = (resolvedPath: string) => Decision;

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
    private readonly externalDecision: ExternalDirectoryDecision | undefined = undefined,
  ) {}

  /** Resolves `candidate` against the root and rejects anything that escapes it.
   *  Symlinks (and Windows junctions) are dereferenced first: a link inside the
   *  workspace pointing outside it must not hide its real target behind an
   *  in-root path. */
  resolvePath(candidate: string): string {
    const resolved = this.resolveUncontained(candidate);
    if (!this.contains(resolved)) {
      throw new AgencyError(ErrorCode.PERMISSION_DENIED, `"${candidate}" resolves outside the sandbox root`, {
        source: "sandbox",
        context: { candidate, root: this.canonicalRoot() },
      });
    }
    return resolved;
  }

  /**
   * Resolve with the `external_directory` gate applied: in-root paths pass,
   * out-of-root paths follow the configured decision — deny refuses, allow
   * admits, ask consults `ask` (once/always/reject; no callback available
   * fails closed). `tool` names the asker so the approval prompt is attributed.
   */
  async resolvePathGated(candidate: string, opts: { tool: string; ask?: RequestApproval }): Promise<string> {
    const resolved = this.resolveUncontained(candidate);
    if (this.contains(resolved)) return resolved;

    const decision = this.externalDecision?.(resolved) ?? "deny";
    if (decision === "allow") return resolved;
    if (decision === "ask") {
      const ask = opts.ask;
      if (!ask) {
        throw new AgencyError(
          ErrorCode.PERMISSION_DENIED,
          `"${candidate}" is outside the workspace and no approval surface is available to permit it`,
          { source: "sandbox", context: { candidate, root: this.canonicalRoot() } },
        );
      }
      const response = await ask({
        tool: opts.tool,
        title: `access outside the workspace: ${candidate}`,
        path: candidate,
      });
      if (response === "reject") {
        throw new AgencyError(
          ErrorCode.PERMISSION_DENIED,
          `access outside the workspace denied: ${candidate}`,
          {
            source: "sandbox",
            context: { candidate, root: this.canonicalRoot() },
          },
        );
      }
      return resolved;
    }
    throw new AgencyError(ErrorCode.PERMISSION_DENIED, `"${candidate}" resolves outside the sandbox root`, {
      source: "sandbox",
      context: { candidate, root: this.canonicalRoot() },
    });
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

  private resolveUncontained(candidate: string): string {
    return canonicalPath(resolve(this.root, candidate));
  }

  private contains(resolved: string): boolean {
    const normalizedRoot = this.canonicalRoot();
    if (resolved === normalizedRoot || resolved.startsWith(`${normalizedRoot}${sep()}`)) return true;
    // Windows: TEMP (and thus workspaceRoot) is often the 8.3 short form
    // (C:\Users\RUNNER~1\...) while PowerShell reports the long form
    // (C:\Users\runneradmin\...). realpathSync preserves the short form;
    // only realpathSync.native resolves via GetFinalPathNameByHandle.
    // Fall back to a native-aware, case-insensitive compare so the same
    // directory under either spelling stays contained. The fast path above
    // already accepted exact matches (e.g. new files under a short root),
    // so this only widens genuinely equivalent spellings.
    if (process.platform !== "win32") return false;
    try {
      const a = windowsCompareKey(resolved);
      const b = windowsCompareKey(normalizedRoot);
      return a === b || a.startsWith(`${b}\\`);
    } catch {
      return false;
    }
  }

  private canonicalRoot(): string {
    return canonicalPath(this.root);
  }
}

function sep(): string {
  return process.platform === "win32" ? "\\" : "/";
}

function windowsCompareKey(p: string): string {
  let candidate = p.replace(/\//g, "\\");
  const native = (realpathSync as unknown as { native?: (s: string) => string }).native;
  if (typeof native === "function") {
    try {
      candidate = native(candidate);
    } catch {
      // Missing file: keep input; exact-match fast path already handled it.
    }
  }
  if (candidate.startsWith("\\\\?\\")) candidate = candidate.slice(4);
  if (candidate.startsWith("UNC\\")) candidate = `\\${candidate.slice(4)}`;
  return candidate.replace(/\//g, "\\").toLowerCase();
}

/**
 * Canonicalizes `path` through realpath so symlinked components are dereferenced.
 * A missing final component (a file a tool is about to create) resolves through
 * the deepest existing ancestor with the missing tail re-appended; genuinely
 * absent intermediate directories resolve the same way, since tools create
 * parents after the containment check. Anything the filesystem refuses to
 * resolve — EACCES on a permission-restricted directory, ELOOP on a symlink
 * chain, or a dangling link (ENOENT from realpath but present to lstat, so
 * re-appending it literally would hide its target from `contains()`) — is
 * denied with a typed refusal, never a raw fs error.
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
    } catch (err: unknown) {
      const nodeErr = err as { code?: string };
      if (nodeErr.code !== "ENOENT" || isDanglingLink(current)) {
        throw new AgencyError(ErrorCode.PERMISSION_DENIED, `cannot verify path: ${path}`, {
          source: "sandbox",
          context: { path, code: nodeErr.code ?? "unknown" },
        });
      }
      const parent = dirname(current);
      if (parent === current) return resolved; // reached the filesystem root without resolving
      tail = tail === "" ? basename(current) : `${basename(current)}${sep()}${tail}`;
      current = parent;
    }
  }
}

/**
 * True when `current` exists as a link realpath cannot see through (dangling
 * target): lstat observes the link itself where realpath reported ENOENT. A
 * non-ENOENT lstat failure is unverifiable either way, so it also denies.
 */
function isDanglingLink(current: string): boolean {
  try {
    lstatSync(current);
    return true;
  } catch (err: unknown) {
    if ((err as { code?: string }).code !== "ENOENT") {
      throw new AgencyError(ErrorCode.PERMISSION_DENIED, `cannot verify path: ${current}`, {
        source: "sandbox",
        context: { path: current, code: (err as { code?: string }).code ?? "unknown" },
      });
    }
    return false;
  }
}

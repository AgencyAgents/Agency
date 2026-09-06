import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { normalizeCommand } from "./policy.ts";

/**
 * The human side of an `ask` decision. `once` approves this occurrence,
 * `always` records a session-scoped grant (and retroactively resolves matching
 * pending asks), `reject` refuses.
 */
export type ApprovalResponse = "once" | "always" | "reject";

/** What a tool (or the permission gate) presents to the user for approval. */
export interface ApprovalRequest {
  /** Tool asking: "bash", "write", "dispatch", ... */
  tool: string;
  /** The human-readable subject: the exact command, path, or forecast summary. */
  title: string;
  command?: string;
  path?: string;
  /** Extra structured context (cost estimates, normalized patterns). */
  metadata?: Record<string, unknown>;
}

/** A tool's way to request approval: resolves once the user answers. */
export type RequestApproval = (request: ApprovalRequest) => Promise<ApprovalResponse>;

function grantKey(request: ApprovalRequest): string {
  // bash "always" scopes to the arity-normalized command, so "always allow
  // git status" doesn't approve "git push". Path asks scope to the containing
  // directory, so "always allow this file" covers its siblings too.
  // Doom-loop grants include the looping tool so one loop cannot approve all future loops.
  if (request.tool === "doom-loop" && typeof request.metadata?.toolName === "string")
    return `tool\u0000doom-loop\u0000${request.metadata.toolName}`;
  if (request.command !== undefined) return `cmd\u0000${normalizeCommand(request.command)}`;
  if (request.path !== undefined) return `dir\u0000${dirname(request.path.replace(/\\/g, "/"))}`;
  return `tool\u0000${request.tool}`;
}

interface PendingEntry {
  id: string;
  request: ApprovalRequest;
  turnId?: string;
  resolve: (response: ApprovalResponse) => void;
}

export interface RespondOutcome {
  /** Whether an ask with that id was still pending. */
  resolved: boolean;
  /** How many OTHER pending asks were retroactively approved by an "always". */
  retroactive: number;
}

/**
 * Session-scoped approval state: the "always allow" grants and the pending
 * asks awaiting a user response. One instance per session, owned by the
 * daemon — grants persist to disk per-session so "always" survives daemon
 * restart.
 */
export class ApprovalManager {
  private readonly grants = new Set<string>();
  private readonly pending = new Map<string, PendingEntry>();

  /**
   * @param approvalsDir  Directory for per-session grant files (e.g. dataDir/approvals).
   *                      When absent, grants are in-memory only.
   * @param sessionId     Session identifier used as the filename stem.
   *                      When absent alongside approvalsDir, persistence is skipped.
   */
  constructor(
    private readonly approvalsDir?: string,
    private readonly sessionId?: string,
  ) {
    if (this.approvalsDir && this.sessionId) {
      this.loadGrants();
    }
  }

  private get grantsPath(): string | undefined {
    if (!this.approvalsDir || !this.sessionId) return undefined;
    return join(this.approvalsDir, `${this.sessionId}.json`);
  }

  /** Loads persisted grants from disk. Silently starts fresh on any error. */
  private loadGrants(): void {
    const path = this.grantsPath;
    if (!path) return;
    try {
      const data = readFileSync(path, "utf-8");
      const keys: string[] = JSON.parse(data);
      for (const key of keys) this.grants.add(key);
    } catch {
      // File doesn't exist or is corrupt — start with empty grants.
    }
  }

  /** Persists the current grants set to disk. Best-effort (never throws). */
  private saveGrants(): void {
    const path = this.grantsPath;
    if (!path) return;
    const dir = this.approvalsDir;
    if (!dir) return;
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, JSON.stringify([...this.grants]));
    } catch {
      // Best-effort persistence — failure must not break the running daemon.
    }
  }

  /** Whether this exact subject already carries a session "always" grant. */
  hasAlways(request: ApprovalRequest): boolean {
    return this.grants.has(grantKey(request));
  }

  grantAlways(request: ApprovalRequest): void {
    this.grants.add(grantKey(request));
    this.saveGrants();
  }

  /**
   * Registers a pending ask. The returned promise settles when `respond`
   * answers it, a retroactive "always" covers it, or `rejectTurn`/`rejectAll`
   * cleans it up on turn abort.
   */
  createPending(
    request: ApprovalRequest,
    turnId?: string,
  ): { id: string; promise: Promise<ApprovalResponse> } {
    const id = randomUUID();
    const promise = new Promise<ApprovalResponse>((resolve) => {
      this.pending.set(id, { id, request, turnId, resolve });
    });
    return { id, promise };
  }

  /**
   * Answers a pending ask. `always` also records the session grant and
   * retroactively resolves every other pending ask matching the same subject —
   * two terminals asking for the same command queue one prompt, not two.
   */
  respond(id: string, decision: ApprovalResponse): RespondOutcome {
    const entry = this.pending.get(id);
    if (!entry) return { resolved: false, retroactive: 0 };
    this.pending.delete(id);
    entry.resolve(decision);

    if (decision !== "always") return { resolved: true, retroactive: 0 };

    this.grantAlways(entry.request);
    const key = grantKey(entry.request);
    let retroactive = 0;
    for (const [otherId, other] of [...this.pending]) {
      if (otherId !== id && grantKey(other.request) === key) {
        this.pending.delete(otherId);
        other.resolve("once");
        retroactive += 1;
      }
    }
    return { resolved: true, retroactive };
  }

  /** Rejects every pending ask belonging to a turn (abort/disconnect cleanup). */
  rejectTurn(turnId: string): number {
    let rejected = 0;
    for (const [id, entry] of [...this.pending]) {
      if (entry.turnId === turnId) {
        this.pending.delete(id);
        entry.resolve("reject");
        rejected += 1;
      }
    }
    return rejected;
  }

  /** Rejects every pending ask regardless of turn (daemon shutdown). */
  rejectAll(): number {
    const count = this.pending.size;
    for (const [, entry] of [...this.pending]) entry.resolve("reject");
    this.pending.clear();
    return count;
  }

  pendingCount(): number {
    return this.pending.size;
  }
}

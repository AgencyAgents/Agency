import { AgencyError, ErrorCode } from "@agency/schema";
import type { RequestApproval } from "./approval.ts";
import { GIT_WRITE_PERMISSION_KEY, gitWriteDecision, type ToolPermissionValue } from "./policy.ts";

/** Inputs to the git-write gate (Todo 8 calls this before materializing commits). */
export interface GitWriteGateOptions {
  permissions?: Record<string, ToolPermissionValue>;
  /** Headless runs deny regardless of setting (plan.ts non-interactive precedent). */
  nonInteractive?: boolean;
  /** Existing approval surface; ask without one fails closed (sandbox precedent). */
  ask?: RequestApproval;
}

function denied(reason: string, decision: string): AgencyError {
  return new AgencyError(ErrorCode.PERMISSION_DENIED, `git write denied: ${reason}`, {
    source: "git-write",
    context: { key: GIT_WRITE_PERMISSION_KEY, decision, reason },
  });
}

/** Resolves when git writes may proceed; every denial throws typed PERMISSION_DENIED. */
export async function assertGitWriteAllowed(options: GitWriteGateOptions = {}): Promise<void> {
  if (options.nonInteractive === true) throw denied("non-interactive run has no approval surface", "deny");
  const decision = gitWriteDecision(options.permissions);
  if (decision === "allow") return;
  if (decision === "deny") throw denied("the git_write permission is not allowed", decision);
  const ask = options.ask;
  if (!ask) throw denied("ask requires an approval surface and none is available", decision);
  const response = await ask({ tool: GIT_WRITE_PERMISSION_KEY, title: "materialize git commit" });
  if (response === "reject") throw denied("the git write approval was rejected", decision);
}

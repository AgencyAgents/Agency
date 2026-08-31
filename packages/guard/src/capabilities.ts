import { AgencyError, ErrorCode } from "@agency/schema";

/**
 * Who's asking. `user` is the person at the keyboard; `agent`/`plugin` exist
 * now so the capability model doesn't need reshaping when P2's single caller
 * becomes many in a later phase (R2/R4) — nothing in v1 issues those yet.
 */
export type CallerIdentity =
  | { type: "user" }
  | { type: "agent"; name: string }
  | { type: "plugin"; id: string };

export function callerLabel(identity: CallerIdentity): string {
  switch (identity.type) {
    case "user":
      return "user";
    case "agent":
      return `agent:${identity.name}`;
    case "plugin":
      return `plugin:${identity.id}`;
  }
}

export interface Capabilities {
  /** Tool names this caller may invoke, or "*" for unrestricted. */
  tools: readonly string[] | "*";
  /** Directory prefixes this caller may read or write within. */
  pathScopes: readonly string[];
  /** Hosts this caller's tools may reach, "*" for any, or "none" to block network entirely. */
  network: readonly string[] | "*" | "none";
}

export const NO_CAPABILITIES: Capabilities = { tools: [], pathScopes: [], network: "none" };
export const FULL_CAPABILITIES: Capabilities = { tools: "*", pathScopes: ["/"], network: "*" };

function deny(caller: CallerIdentity, detail: string): never {
  throw new AgencyError(ErrorCode.PERMISSION_DENIED, detail, {
    source: callerLabel(caller),
    context: { detail },
  });
}

/** Throws PERMISSION_DENIED when the caller's capability set doesn't allow `tool`. */
export function requireTool(identity: CallerIdentity, capabilities: Capabilities, tool: string): void {
  if (capabilities.tools === "*") return;
  if (capabilities.tools.includes(tool)) return;
  deny(identity, `tool "${tool}" is outside this caller's allowed tools`);
}

/** Throws PERMISSION_DENIED when `absolutePath` falls outside every allowed scope. */
export function requirePathScope(identity: CallerIdentity, capabilities: Capabilities, absolutePath: string): void {
  const normalized = absolutePath.replace(/\\/g, "/");
  const inScope = capabilities.pathScopes.some((scope) => {
    const normalizedScope = scope.replace(/\\/g, "/").replace(/\/$/, "");
    return normalized === normalizedScope || normalized.startsWith(`${normalizedScope}/`);
  });
  if (!inScope) deny(identity, `path "${absolutePath}" is outside this caller's allowed scopes`);
}

/** Throws PERMISSION_DENIED when `host` isn't reachable under this caller's network capability. */
export function requireNetwork(identity: CallerIdentity, capabilities: Capabilities, host: string): void {
  if (capabilities.network === "none") deny(identity, "this caller has no network access");
  if (capabilities.network === "*") return;
  if (capabilities.network.includes(host)) return;
  deny(identity, `host "${host}" is outside this caller's allowed hosts`);
}

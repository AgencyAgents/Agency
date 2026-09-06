import { AgencyError, ErrorCode } from "@agency/schema";

/**
 * Who's asking. `user` is the person at the keyboard; `agent`/`plugin` exist
 * now so the capability model doesn't need reshaping when P2's single caller
 * becomes many in a later phase (R2/R4); nothing in v1 issues those yet.
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
  /**
   * Directory prefixes this caller may read or write within, or "*" for
   * unrestricted. A literal "/" is deliberately not a wildcard sentinel here:
   * on Windows every resolved path is drive-letter-rooted (`C:/...`), so a
   * POSIX-style "/" prefix match would silently deny everything.
   */
  pathScopes: readonly string[] | "*";
  /** Hosts this caller's tools may reach, "*" for any, or "none" to block network entirely. */
  network: readonly string[] | "*" | "none";
}

export const NO_CAPABILITIES: Capabilities = { tools: [], pathScopes: [], network: "none" };
export const FULL_CAPABILITIES: Capabilities = { tools: "*", pathScopes: "*", network: "*" };

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
export function requirePathScope(
  identity: CallerIdentity,
  capabilities: Capabilities,
  absolutePath: string,
): void {
  if (capabilities.pathScopes === "*") return;

  const normalized = absolutePath.replace(/\\/g, "/");
  const inScope = capabilities.pathScopes.some((scope) => {
    const normalizedScope = scope.replace(/\\/g, "/").replace(/\/$/, "");
    return normalized === normalizedScope || normalized.startsWith(`${normalizedScope}/`);
  });
  if (!inScope) deny(identity, `path "${absolutePath}" is outside this caller's allowed scopes`);
}

/** Workspace-relative forward-slash form: separators normalized for 7.33. */
export function normalizeScopePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** True for the match-all scopes (bare stars, slash stars, star slash star). */
export function isMatchAllScope(scope: string): boolean {
  const normalized = normalizeScopePath(scope);
  return normalized === "**" || normalized === "/**" || normalized === "**/*";
}

export function scopePatternToRegExp(glob: string): RegExp {
  const normalized = normalizeScopePath(glob);
  let out = "";
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (ch === "*") {
      if (normalized[i + 1] === "*") {
        i++;
        out += ".*";
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if ("+()^$.{}|[]\\".includes(ch ?? "")) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`^${out}$`);
}

export function scopeMatchesPattern(pattern: string, candidate: string): boolean {
  const scope = normalizeScopePath(pattern);
  const path = normalizeScopePath(candidate);
  if (isMatchAllScope(scope)) return true;
  if (scope.endsWith("/**")) {
    const prefix = scope.slice(0, -3);
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  return scopePatternToRegExp(scope).test(path);
}

/** One requested scope against one grant: keep, narrow to the grant, or drop. */
export function coverScope(requested: string, grant: string): "keep" | "narrow-to-grant" | "drop" {
  const req = normalizeScopePath(requested);
  const own = normalizeScopePath(grant);
  if (own === "*" || isMatchAllScope(own)) return "keep";
  if (req === "*" || isMatchAllScope(req)) return "narrow-to-grant";
  if (req === own || scopeMatchesPattern(own, req)) return "keep";
  if (own.endsWith("/**")) {
    const prefix = own.slice(0, -3);
    if (req === prefix) return "keep";
  }
  if (scopeMatchesPattern(req, own)) return "narrow-to-grant";
  return "drop";
}

/** Intersects requested path scopes with the filer's own grants, never unions. */
export function intersectPathScopes(
  requested: readonly string[] | undefined,
  grants: readonly string[] | "*" | undefined,
): { scopes: string[]; narrowed: boolean } {
  if (grants === undefined || grants === "*") {
    return { scopes: requested === undefined ? [] : [...requested], narrowed: false };
  }
  if (requested === undefined || requested.length === 0) return { scopes: [...grants], narrowed: true };
  const scopes: string[] = [];
  let narrowed = false;
  for (const req of requested) {
    let kept = false;
    for (const grant of grants) {
      const verdict = coverScope(req, grant);
      if (verdict === "keep") {
        if (!scopes.includes(req)) scopes.push(req);
        kept = true;
        break;
      }
      if (verdict === "narrow-to-grant") {
        if (!scopes.includes(grant)) scopes.push(grant);
        kept = true;
        narrowed = true;
        break;
      }
    }
    if (!kept) narrowed = true;
  }
  return { scopes, narrowed };
}
export function requireNetwork(identity: CallerIdentity, capabilities: Capabilities, host: string): void {
  if (capabilities.network === "none") deny(identity, "this caller has no network access");
  if (capabilities.network === "*") return;
  if (capabilities.network.includes(host)) return;
  deny(identity, `host "${host}" is outside this caller's allowed hosts`);
}

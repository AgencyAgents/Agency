import { randomBytes } from "node:crypto";

/**
 * Short-lived scoped tokens minted from the bootstrap instance token.
 * The instance-file token bootstraps trust (it proves local file access);
 * everything else runs on these, so a leaked stream URL or log line stops
 * working within minutes instead of for the daemon lifetime.
 */
export interface MintedToken {
  token: string;
  scopes: readonly string[];
  expiresAt: number;
}

export const MINT_DEFAULT_TTL_MS = 10 * 60 * 1_000;
export const MINT_MAX_TTL_MS = 60 * 60 * 1_000;

export class MintedTokenStore {
  private readonly tokens = new Map<string, MintedToken>();

  /** Issue a token; scopes are opaque except "*" which grants everything. */
  mint(scopes: readonly string[] = ["*"], ttlMs = MINT_DEFAULT_TTL_MS): MintedToken {
    const ttl = Math.max(1_000, Math.min(ttlMs, MINT_MAX_TTL_MS));
    const minted: MintedToken = {
      token: randomBytes(24).toString("hex"),
      scopes,
      expiresAt: Date.now() + ttl,
    };
    this.tokens.set(minted.token, minted);
    this.prune();
    return minted;
  }

  /** Scopes for a live token, or null when unknown or expired. */
  scopesFor(token: string): readonly string[] | null {
    const found = this.tokens.get(token);
    if (!found) return null;
    if (found.expiresAt <= Date.now()) {
      this.tokens.delete(token);
      return null;
    }
    return found.scopes;
  }

  private prune(): void {
    if (this.tokens.size < 512) return;
    const now = Date.now();
    for (const [token, minted] of this.tokens) {
      if (minted.expiresAt <= now) this.tokens.delete(token);
    }
  }
}

/** True when the scopes grant `need` (exact match or wildcard). */
export function scopeGrants(scopes: readonly string[], need: string): boolean {
  return scopes.includes("*") || scopes.includes(need);
}

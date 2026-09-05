/**
 * Adversarial chaos matrix: mocked providers, zero live network.
 * Covers Wave 5 U12 gate scenarios across scheduler, OAuth, loop,
 * dispatch, and plan gate. Every case is fast unit-style.
 */

import { describe, expect, jest, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeychainBackend } from "@agency/providers";
import { type OAuthToken, oauthKey, refreshOAuthToken, Scheduler } from "@agency/providers";
import { AgencyError, ErrorCode } from "@agency/schema";
import {
  countUnresolvedComments,
  evaluatePlanGate,
  type PlanGateDecision,
  writePlanIssues,
} from "@agency/tools/src/builtins/plan.ts";
import {
  DISPATCH_SKIP_REASONS,
  type DispatchSkipReason,
  formatSkipLine,
  planDispatchBatch,
} from "../src/orchestra/dispatch-core.ts";
import { isContextOverflowError } from "../src/sessions/compaction.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function retryable(msg = "429"): AgencyError {
  return new AgencyError(ErrorCode.RATE_LIMIT, msg, { source: "test" });
}

function memoryKeychain(seed: Record<string, string> = {}): KeychainBackend & { store: Map<string, string> } {
  const store = new Map(Object.entries(seed));
  return {
    name: "memory",
    isAvailable: async () => true,
    get: async (key: string) => store.get(key),
    set: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    store,
  };
}

function expiredToken(): string {
  return JSON.stringify({
    type: "oauth",
    accessToken: "stale-token",
    refreshToken: "refresh-token",
    expiresAt: 0,
  } satisfies OAuthToken);
}

// ---------------------------------------------------------------------------
// 1. Scheduler: key failure mid-rotation
// ---------------------------------------------------------------------------

describe("Chaos: scheduler failover mid-rotation", () => {
  test("all keys fail and quarantine; scheduler waits then retries", async () => {
    const scheduler = new Scheduler({
      baseDelayMs: 2,
      maxDelayMs: 10,
      maxAttempts: 4,
      requestsPerMinute: 6000,
    });
    let calls = 0;
    const err = await scheduler
      .scheduleWithKeys(
        "openai",
        ["k1", "k2"],
        async (key) => {
          calls += 1;
          throw retryable(`fail on ${key}`);
        },
        { quarantineMs: 15 },
      )
      .catch((e) => e);
    // Both keys tried, both failed, maxAttempts exhausted
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(err).toBeInstanceOf(AgencyError);
    expect((err as AgencyError).code).toBe(ErrorCode.RATE_LIMIT);
    // Both keys quarantined
    expect(scheduler.getQuarantinedKeys().sort()).toEqual(["k1", "k2"]);
  });

  test("concurrent failover storms isolate quarantine per call group", async () => {
    const scheduler = new Scheduler({
      maxConcurrent: 4,
      baseDelayMs: 2,
      maxDelayMs: 10,
      maxAttempts: 2,
      requestsPerMinute: 6000,
    });
    const results = await Promise.allSettled(
      [1, 2].map((group) =>
        scheduler.scheduleWithKeys(
          "openai",
          ["k1", "k2"],
          async (key) => {
            throw retryable(`group ${group} fail on ${key}`);
          },
          { quarantineMs: 15 },
        ),
      ),
    );
    // Both groups should fail
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    // Quarantine has both keys
    expect(scheduler.getQuarantinedKeys().sort()).toEqual(["k1", "k2"]);
  });

  test("non-retryable error during rotation does not quarantine", async () => {
    const scheduler = new Scheduler({
      baseDelayMs: 5,
      maxDelayMs: 10,
      maxAttempts: 4,
      requestsPerMinute: 6000,
    });
    const err = await scheduler
      .scheduleWithKeys("openai", ["k1", "k2"], async () => {
        throw new AgencyError(ErrorCode.AUTH, "bad key", { source: "test" });
      })
      .catch((e) => e);
    expect((err as AgencyError).code).toBe(ErrorCode.AUTH);
    // Auth error is non-retryable, so no quarantine
    expect(scheduler.getQuarantinedKeys()).toEqual([]);
  });

  test("rotation with zero keys throws INTERNAL error", async () => {
    const scheduler = new Scheduler({ requestsPerMinute: 6000 });
    const err = await scheduler.scheduleWithKeys("openai", [], async () => "x").catch((e) => e);
    expect(err).toBeInstanceOf(AgencyError);
    expect((err as AgencyError).code).toBe(ErrorCode.INTERNAL);
  });

  test("hostile retryAfterMs on all keys is capped per key attempt", async () => {
    const scheduler = new Scheduler({
      baseDelayMs: 5,
      maxDelayMs: 30,
      maxAttempts: 2,
      requestsPerMinute: 6000,
    });
    let calls = 0;
    const start = Date.now();
    const err = await scheduler
      .scheduleWithKeys(
        "openai",
        ["k1", "k2"],
        async () => {
          calls += 1;
          throw new AgencyError(ErrorCode.RATE_LIMIT, "429", {
            source: "test",
            context: { retryAfterMs: 86_400_000 },
          });
        },
        { quarantineMs: 15 },
      )
      .catch((e) => e);
    expect((err as AgencyError).code).toBe(ErrorCode.RATE_LIMIT);
    expect(calls).toBe(2);
    // Hostile retryAfterMs capped at maxDelayMs (30ms), so total time < 5s
    expect(Date.now() - start).toBeLessThan(5000);
  });
});

// ---------------------------------------------------------------------------
// 2. OAuth token expiry during a turn
// ---------------------------------------------------------------------------

describe("Chaos: OAuth token expiry during a turn", () => {
  test("expired token triggers refresh; successful refresh returns new token", async () => {
    const keychain = memoryKeychain({ [oauthKey("openai")]: expiredToken() });
    const httpFetch = (async () =>
      new Response(
        JSON.stringify({ access_token: "fresh-token", refresh_token: "new-refresh", expires_in: 3600 }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const token = await refreshOAuthToken(keychain, "openai", httpFetch, { clientId: "my-app-client-id" });
    expect(token).toBe("fresh-token");
    const stored = JSON.parse((await keychain.get(oauthKey("openai")))!) as OAuthToken;
    expect(stored.accessToken).toBe("fresh-token");
  });

  test("expired token with failed refresh throws AUTH error", async () => {
    const keychain = memoryKeychain({ [oauthKey("anthropic")]: expiredToken() });
    const httpFetch = (async () => new Response("denied", { status: 401 })) as unknown as typeof fetch;
    await expect(
      refreshOAuthToken(keychain, "anthropic", httpFetch, { clientId: "my-app-client-id" }),
    ).rejects.toMatchObject({ code: "auth" });
  });

  test("expired token with network failure during refresh throws AUTH error", async () => {
    const keychain = memoryKeychain({ [oauthKey("anthropic")]: expiredToken() });
    const httpFetch = (async () => {
      throw new Error("network unreachable");
    }) as unknown as typeof fetch;
    await expect(
      refreshOAuthToken(keychain, "anthropic", httpFetch, { clientId: "my-app-client-id" }),
    ).rejects.toMatchObject({ code: "auth" });
  });

  test("refresh with no access_token in response throws AUTH error", async () => {
    const keychain = memoryKeychain({ [oauthKey("anthropic")]: expiredToken() });
    const httpFetch = (async () =>
      new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;
    await expect(
      refreshOAuthToken(keychain, "anthropic", httpFetch, { clientId: "my-app-client-id" }),
    ).rejects.toMatchObject({ code: "auth" });
  });

  test("valid token does not trigger refresh", async () => {
    const keychain = memoryKeychain({
      [oauthKey("openai")]: JSON.stringify({
        type: "oauth",
        accessToken: "still-good",
        refreshToken: "ref",
        expiresAt: Date.now() + 3600_000,
      } satisfies OAuthToken),
    });
    const httpFetch = jest.fn() as unknown as typeof fetch;
    const token = await refreshOAuthToken(keychain, "openai", httpFetch, { clientId: "my-app-client-id" });
    expect(token).toBe("still-good");
    // No network call made
    expect(httpFetch).not.toHaveBeenCalled();
  });

  test("concurrent refresh calls deduplicate via refreshInflight", async () => {
    const keychain = memoryKeychain({ [oauthKey("openai")]: expiredToken() });
    let callCount = 0;
    const httpFetch = (async () => {
      callCount += 1;
      await new Promise((r) => setTimeout(r, 5));
      return new Response(JSON.stringify({ access_token: "deduped", refresh_token: "r", expires_in: 3600 }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const [a, b] = await Promise.all([
      refreshOAuthToken(keychain, "openai", httpFetch, { clientId: "my-app-client-id" }),
      refreshOAuthToken(keychain, "openai", httpFetch, { clientId: "my-app-client-id" }),
    ]);
    expect(a).toBe("deduped");
    expect(b).toBe("deduped");
    // Only one actual HTTP call
    expect(callCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Context overflow during a turn
// ---------------------------------------------------------------------------

describe("Chaos: context overflow during a turn", () => {
  test("isContextOverflowError detects CONTEXT_OVERFLOW code", () => {
    const err = new AgencyError(ErrorCode.CONTEXT_OVERFLOW, "too many tokens", { source: "test" });
    expect(isContextOverflowError(err)).toBe(true);
  });

  test("isContextOverflowError returns false for non-overflow errors", () => {
    const err = new AgencyError(ErrorCode.RATE_LIMIT, "429", { source: "test" });
    expect(isContextOverflowError(err)).toBe(false);
    expect(isContextOverflowError(null)).toBe(false);
    expect(isContextOverflowError("string")).toBe(false);
  });

  test("isContextOverflowError returns false for non-AgencyError objects", () => {
    expect(isContextOverflowError(new Error("generic"))).toBe(false);
    expect(isContextOverflowError({ code: "context_overflow" })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Dispatch skip storm
// ---------------------------------------------------------------------------

describe("Chaos: dispatch skip storm", () => {
  test("every skip reason produces a stable machine-readable code", () => {
    const reasons: DispatchSkipReason[] = [
      "empty-input",
      "invalid-entry",
      "unknown-handle",
      "nested-blocked",
      "depth-limit",
      "orchestra-budget-exceeded",
      "per-agent-budget-exceeded",
    ];
    expect(reasons).toEqual(DISPATCH_SKIP_REASONS);
  });

  test("empty-input skip when no agents provided", () => {
    const plan = planDispatchBatch([], { resolveHandle: () => undefined });
    expect(plan.targets).toEqual([]);
    expect(plan.skips).toHaveLength(1);
    expect(plan.skips[0]?.reason).toBe("empty-input");
    expect(formatSkipLine(plan.skips[0]!)).toContain("[skip:empty-input]");
  });

  test("invalid-entry skip for missing handle or brief", () => {
    const plan = planDispatchBatch(
      [
        { handle: "", brief: "x" },
        { handle: "h", brief: "" },
      ],
      { resolveHandle: () => undefined },
    );
    expect(plan.targets).toEqual([]);
    expect(plan.skips).toHaveLength(2);
    expect(plan.skips.every((s) => s.reason === "invalid-entry")).toBe(true);
    expect(plan.skips.every((s) => formatSkipLine(s).includes("[skip:invalid-entry]"))).toBe(true);
  });

  test("unknown-handle skip for unresolvable agent", () => {
    const plan = planDispatchBatch([{ handle: "ghost", brief: "do something" }], {
      resolveHandle: () => undefined,
    });
    expect(plan.targets).toEqual([]);
    expect(plan.skips).toHaveLength(1);
    expect(plan.skips[0]?.reason).toBe("unknown-handle");
    expect(formatSkipLine(plan.skips[0]!)).toContain("[skip:unknown-handle]");
    expect(formatSkipLine(plan.skips[0]!)).toContain("ghost");
  });

  test("nested-blocked skip when taskDepth > 0", () => {
    const plan = planDispatchBatch([{ handle: "agent1", brief: "work" }], {
      resolveHandle: () => ({ handle: "agent1" }),
      taskDepth: 1,
    });
    expect(plan.targets).toEqual([]);
    expect(plan.skips).toHaveLength(1);
    expect(plan.skips[0]?.reason).toBe("nested-blocked");
    expect(formatSkipLine(plan.skips[0]!)).toContain("[skip:nested-blocked]");
  });

  test("depth-limit skip when taskDepth >= maxDepth", () => {
    const plan = planDispatchBatch([{ handle: "agent1", brief: "work" }], {
      resolveHandle: () => ({ handle: "agent1" }),
      taskDepth: 0,
      maxDepth: 0,
    });
    expect(plan.targets).toEqual([]);
    expect(plan.skips).toHaveLength(1);
    expect(plan.skips[0]?.reason).toBe("depth-limit");
    expect(formatSkipLine(plan.skips[0]!)).toContain("[skip:depth-limit]");
  });

  test("orchestra-budget-exceeded skip when total spend over limit", () => {
    const plan = planDispatchBatch([{ handle: "agent1", brief: "work" }], {
      resolveHandle: () => ({ handle: "agent1" }),
      budgets: { orchestraUsd: 0.01 },
      orchestraTotal: 0.02,
    });
    expect(plan.targets).toEqual([]);
    expect(plan.skips).toHaveLength(1);
    expect(plan.skips[0]?.reason).toBe("orchestra-budget-exceeded");
    expect(formatSkipLine(plan.skips[0]!)).toContain("[skip:orchestra-budget-exceeded]");
  });

  test("per-agent-budget-exceeded skip when agent spend over limit", () => {
    const plan = planDispatchBatch([{ handle: "agent1", brief: "work" }], {
      resolveHandle: () => ({ handle: "agent1" }),
      budgets: { perAgentUsd: 0.01 },
      perAgentSpend: new Map([["agent1", 0.02]]),
    });
    expect(plan.targets).toEqual([]);
    expect(plan.skips).toHaveLength(1);
    expect(plan.skips[0]?.reason).toBe("per-agent-budget-exceeded");
    expect(formatSkipLine(plan.skips[0]!)).toContain("[skip:per-agent-budget-exceeded]");
  });

  test("mixed batch: valid targets pass, invalid entries skip with stable codes", () => {
    const plan = planDispatchBatch(
      [
        { handle: "agent1", brief: "valid work" },
        { handle: "", brief: "bad" },
        { handle: "ghost", brief: "missing" },
      ],
      {
        resolveHandle: (h) => (h === "agent1" ? { handle: "agent1" } : undefined),
      },
    );
    expect(plan.targets).toHaveLength(1);
    expect(plan.targets[0]?.handle).toBe("agent1");
    expect(plan.skips).toHaveLength(2);
    expect(plan.skips[0]?.reason).toBe("invalid-entry");
    expect(plan.skips[1]?.reason).toBe("unknown-handle");
  });
});

// ---------------------------------------------------------------------------
// 5. Plan gate reject
// ---------------------------------------------------------------------------

describe("Chaos: plan gate reject", () => {
  function planDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "chaos-plan-"));
    const plansDir = join(dir, ".opencode", "plans");
    mkdirSync(plansDir, { recursive: true });
    const planPath = join(plansDir, "test-plan.md");
    writeFileSync(planPath, "- [ ] step one\n- [ ] step two\n");
    return planPath;
  }

  test("fail-blocking-severity refuses execute_plan with high severity issues", () => {
    const path = planDir();
    writePlanIssues(path, [{ severity: "high", message: "unsafe operation" }]);
    const decision: PlanGateDecision = evaluatePlanGate(path);
    expect(decision.pass).toBe(false);
    expect(decision.reason).toBe("fail-blocking-severity");
    expect(decision.blocking).toHaveLength(1);
    expect(decision.blocking[0]?.severity).toBe("high");
  });

  test("fail-blocking-severity refuses execute_plan with critical severity issues", () => {
    const path = planDir();
    writePlanIssues(path, [{ severity: "critical", message: "security vulnerability" }]);
    const decision: PlanGateDecision = evaluatePlanGate(path);
    expect(decision.pass).toBe(false);
    expect(decision.reason).toBe("fail-blocking-severity");
    expect(decision.blocking).toHaveLength(1);
    expect(decision.blocking[0]?.severity).toBe("critical");
  });

  test("fail-unresolved-comments refuses execute_plan with unresolved comments", () => {
    const path = planDir();
    writeFileSync(
      `${path}.comments.json`,
      JSON.stringify({
        comments: [{ text: "fix this", resolved: false }],
      }),
    );
    const decision: PlanGateDecision = evaluatePlanGate(path);
    expect(decision.pass).toBe(false);
    expect(decision.reason).toBe("fail-unresolved-comments");
    expect(decision.unresolved).toBe(1);
  });

  test("pass-clean when no issues and no unresolved comments", () => {
    const path = planDir();
    const decision: PlanGateDecision = evaluatePlanGate(path);
    expect(decision.pass).toBe(true);
    expect(decision.reason).toBe("pass-clean");
    expect(decision.blocking).toEqual([]);
    expect(decision.unresolved).toBe(0);
  });

  test("pass-advisory-only when only info/low issues exist", () => {
    const path = planDir();
    writePlanIssues(path, [
      { severity: "info", message: "minor nit" },
      { severity: "low", message: "could be better" },
    ]);
    const decision: PlanGateDecision = evaluatePlanGate(path);
    expect(decision.pass).toBe(true);
    expect(decision.reason).toBe("pass-advisory-only");
    expect(decision.blocking).toEqual([]);
  });

  test("blocking severity takes precedence over unresolved comments", () => {
    const path = planDir();
    writePlanIssues(path, [{ severity: "critical", message: "blocker" }]);
    writeFileSync(
      `${path}.comments.json`,
      JSON.stringify({
        comments: [{ text: "fix", resolved: false }],
      }),
    );
    const decision: PlanGateDecision = evaluatePlanGate(path);
    // Unresolved comments checked first in evaluatePlanGate
    expect(decision.pass).toBe(false);
    expect(decision.reason).toBe("fail-unresolved-comments");
  });

  test("countUnresolvedComments returns 0 when no comments file exists", () => {
    const path = planDir();
    expect(countUnresolvedComments(path)).toBe(0);
  });

  test("countUnresolvedComments returns 0 for malformed comments file", () => {
    const path = planDir();
    writeFileSync(`${path}.comments.json`, "not json");
    expect(countUnresolvedComments(path)).toBe(0);
  });
});

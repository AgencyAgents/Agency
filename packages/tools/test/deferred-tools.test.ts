import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FULL_CAPABILITIES, SandboxBoundary } from "@agency/guard";
import type { HttpClient } from "@agency/net";
import type { ToolDeps, ToolSpec } from "../src/contract.ts";
import type { McpTransport } from "../src/mcp/transport.ts";
import { ToolRegistry } from "../src/registry.ts";
import { createSessionScope } from "../src/session-scope.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ctx = { signal: new AbortController().signal };

function makeSpec(name: string, reply = `ok-${name}`): ToolSpec {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: "object", properties: {} },
    riskTier: "safe",
    handler: async () => ({ content: reply }),
  };
}

function spinMs(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // busy work stands in for heavyweight tool construction
  }
}

function depsFor(root: string): ToolDeps {
  return {
    identity: { type: "user" as const },
    capabilities: FULL_CAPABILITIES,
    sandbox: new SandboxBoundary(root),
  };
}

const noopHttp: HttpClient = { fetch: async () => new Response() };

function scriptedTransport(tracker: { starts: number; closes: number }, startupMs = 0): McpTransport {
  let handler: ((msg: Record<string, unknown>) => void) | undefined;
  return {
    async start() {
      tracker.starts++;
      if (startupMs > 0) await new Promise((r) => setTimeout(r, startupMs));
    },
    async send(message: Record<string, unknown>) {
      const id = message.id as number;
      if (message.method === "initialize") handler?.({ jsonrpc: "2.0", id, result: {} });
      else if (message.method === "tools/list")
        handler?.({
          jsonrpc: "2.0",
          id,
          result: { tools: [{ name: "tool", description: "deferred mcp tool" }] },
        });
      else if (message.method === "tools/call")
        handler?.({ jsonrpc: "2.0", id, result: { content: "mcp-ok", isError: false } });
    },
    onMessage(h) {
      handler = h;
    },
    async close() {
      tracker.closes++;
    },
  };
}

describe("ToolRegistry deferred loading", () => {
  test("construction waits for the first passing forAgent, then caches", () => {
    const reg = new ToolRegistry();
    let calls = 0;
    reg.register(makeSpec("eager"));
    reg.registerDeferred("lazy", () => {
      calls++;
      return makeSpec("lazy");
    });
    expect(calls).toBe(0);
    expect(reg.has("lazy")).toBe(true);
    expect(reg.names()).toContain("lazy");
    expect(calls).toBe(0);

    const offered = reg.forAgent(() => true);
    expect(calls).toBe(1);
    expect(offered.map((t) => t.name).sort()).toEqual(["eager", "lazy"]);
    expect(reg.isPromoted("lazy")).toBe(true);

    reg.forAgent(() => true);
    reg.get("lazy");
    expect(calls).toBe(1);
  });

  test("gate-denied deferred tools never construct", () => {
    const reg = new ToolRegistry();
    let calls = 0;
    reg.registerDeferred("lazy", () => {
      calls++;
      return makeSpec("lazy", "should-never-build");
    });
    const offered = reg.forAgent(() => false);
    expect(offered).toEqual([]);
    expect(calls).toBe(0);
    expect(reg.isPromoted("lazy")).toBe(false);
  });

  test("unpromoted calls fail closed naming the promotion path", async () => {
    const reg = new ToolRegistry();
    let calls = 0;
    reg.registerDeferred(
      "gated",
      () => {
        calls++;
        return makeSpec("gated");
      },
      { riskTier: "moderate", description: "gated tool", predicate: () => false },
    );

    // The gate still sees the tool: forAgent admits it as a placeholder.
    const offered = reg.forAgent(() => true);
    expect(offered.map((t) => t.name)).toEqual(["gated"]);
    expect(offered[0]?.riskTier).toBe("moderate");
    const result = await offered[0]!.handler({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("[deferred-unpromoted:gated]");
    expect(result.content).toContain('promote("gated")');
    expect(calls).toBe(0);

    const viaGet = reg.get("gated")!;
    const result2 = await viaGet.handler({}, ctx);
    expect(result2.isError).toBe(true);
    expect(result2.content).toContain("[deferred-unpromoted:gated]");
    await expect(reg.promote("gated")).rejects.toThrow("[deferred-unpromoted:gated]");
  });

  test("a throwing loader surfaces a typed promotion failure, never silent", async () => {
    const reg = new ToolRegistry();
    reg.registerDeferred("broken", () => {
      throw new Error("boom-construct");
    });
    const spec = reg.get("broken")!;
    const result = await spec.handler({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("[deferred-promotion-failed:broken]");
    expect(result.content).toContain("boom-construct");
    // Sticky: repeated promotion attempts surface the same typed failure.
    await expect(reg.promote("broken")).rejects.toThrow("[deferred-promotion-failed:broken]");
    await expect(reg.promote("broken")).rejects.toThrow("boom-construct");
  });

  test("a throwing predicate fails closed with a typed error", async () => {
    const reg = new ToolRegistry();
    let calls = 0;
    reg.registerDeferred(
      "twitchy",
      () => {
        calls++;
        return makeSpec("twitchy");
      },
      {
        predicate: () => {
          throw new Error("predicate-blew-up");
        },
      },
    );
    const result = await reg.get("twitchy")!.handler({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("[deferred-promotion-failed:twitchy]");
    expect(result.content).toContain("predicate threw");
    expect(result.content).toContain("predicate-blew-up");
    expect(calls).toBe(0);
    await expect(reg.promote("twitchy")).rejects.toThrow("[deferred-promotion-failed:twitchy]");
  });

  test("duplicate names throw in both directions", () => {
    const reg = new ToolRegistry();
    reg.register(makeSpec("dup"));
    expect(() => reg.registerDeferred("dup", () => makeSpec("dup"))).toThrow("already registered");
    const reg2 = new ToolRegistry();
    reg2.registerDeferred("dup", () => makeSpec("dup"));
    expect(() => reg2.register(makeSpec("dup"))).toThrow("already registered");
    expect(() => reg2.registerDeferred("dup", () => makeSpec("dup"))).toThrow("already registered");
  });

  test("async loaders single-flight concurrent first calls", async () => {
    const reg = new ToolRegistry();
    let calls = 0;
    reg.registerDeferred("slow", async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return makeSpec("slow", "slow-ok");
    });
    const p1 = reg.promote("slow");
    const p2 = reg.promote("slow");
    // A sync get mid-flight yields a placeholder that awaits the same flight.
    const mid = reg.get("slow")!;
    const [s1, s2, midResult] = await Promise.all([p1, p2, mid.handler({}, ctx)]);
    expect(calls).toBe(1);
    expect(s1.name).toBe("slow");
    expect(s2.handler).toBe(s1.handler);
    expect(midResult).toEqual({ content: "slow-ok" });
    expect(reg.isPromoted("slow")).toBe(true);
  });

  test("promote on eager names returns the spec; unknown names throw typed", async () => {
    const reg = new ToolRegistry();
    const spec = makeSpec("eager");
    reg.register(spec);
    await expect(reg.promote("eager")).resolves.toBe(spec);
    await expect(reg.promote("nope")).rejects.toThrow("[deferred-unknown:nope]");
    expect(reg.isPromoted("eager")).toBe(false);
  });

  test("unregister drops deferred entries; namespace renames adopted specs", async () => {
    const reg = new ToolRegistry();
    let calls = 0;
    reg.registerDeferred("gone", () => {
      calls++;
      return makeSpec("gone");
    });
    expect(reg.unregister("gone")).toBe(true);
    expect(reg.has("gone")).toBe(false);
    expect(reg.get("gone")).toBeUndefined();
    expect(calls).toBe(0);

    reg.registerDeferred("tool", () => makeSpec("tool"), { namespace: "srv" });
    expect(reg.names()).toContain("srv_tool");
    const resolved = await reg.promote("srv_tool");
    expect(resolved.name).toBe("srv_tool");
  });

  test("eager tools keep byte-identical registry behavior", () => {
    const reg = new ToolRegistry();
    reg.register({ ...makeSpec("read"), riskTier: "safe" });
    reg.register({ ...makeSpec("bash"), riskTier: "dangerous" });
    expect(reg.list().map((t) => t.name)).toEqual(["read", "bash"]);
    expect(reg.get("read")?.riskTier).toBe("safe");
    expect(reg.filter("b").map((t) => t.name)).toEqual(["bash"]);
    const safe = reg.forAgent((_name, tier) => tier === "safe");
    expect(safe.map((t) => t.name)).toEqual(["read"]);
    expect(reg.names()).toEqual(["read", "bash"]);
    expect(reg.has("read")).toBe(true);
    expect(reg.unregister("read")).toBe(true);
    expect(reg.has("read")).toBe(false);
  });
});

describe("session-scope deferred wiring", () => {
  test("browser resolves lazily with unchanged metadata", async () => {
    const root = mkdtempSync(join(tmpdir(), "agency-deferred-scope-"));
    dirs.push(root);
    const scope = await createSessionScope({
      deps: depsFor(root),
      http: noopHttp,
      workspaceRoot: root,
      snapshotDir: join(root, "snapshots"),
    });
    try {
      expect(scope.registry.has("browser")).toBe(true);
      expect(scope.registry.names()).toContain("browser");
      // Scope creation snapshots tools via list(), which promotes the
      // always-promote browser through the deferred path exactly once.
      expect(scope.registry.isPromoted("browser")).toBe(true);
      const spec = scope.registry.get("browser")!;
      expect(spec.name).toBe("browser");
      expect(spec.riskTier).toBe("moderate");
      expect(spec.description.length).toBeGreaterThan(0);
      expect(scope.registry.get("browser")).toBe(spec);
      expect(scope.tools.map((t) => t.name)).toContain("browser");
      const offered = scope.registry.forAgent(() => true);
      expect(offered.map((t) => t.name)).toContain("browser");
    } finally {
      await scope.dispose();
    }
  });

  test("deferred MCP startup stays idle until promoteMcp, then behaves eagerly", async () => {
    const root = mkdtempSync(join(tmpdir(), "agency-deferred-mcp-"));
    dirs.push(root);
    const tracker = { starts: 0, closes: 0 };
    const scope = await createSessionScope({
      deps: depsFor(root),
      http: noopHttp,
      workspaceRoot: root,
      snapshotDir: join(root, "snapshots"),
      mcpServers: { srv: { command: "fake" } },
      mcpTransportFor: () => scriptedTransport(tracker),
      mcpDeferred: true,
    });
    try {
      expect(tracker.starts).toBe(0);
      expect(scope.mcp).toBeUndefined();
      expect(scope.registry.names()).not.toContain("srv_tool");

      // Concurrent promotions share one startup.
      await Promise.all([scope.promoteMcp(), scope.promoteMcp()]);
      expect(tracker.starts).toBe(1);
      expect(scope.mcp).toBeDefined();
      expect(scope.registry.names()).toContain("srv_tool");

      const tool = scope.registry.get("srv_tool")!;
      const result = await tool.handler({}, ctx);
      expect(result.content).toBe("mcp-ok");
      // Idempotent once started.
      await scope.promoteMcp();
      expect(tracker.starts).toBe(1);
    } finally {
      await scope.dispose();
    }
    expect(tracker.closes).toBeGreaterThanOrEqual(1);
  });

  test("default scope still starts MCP eagerly (semantics unchanged)", async () => {
    const root = mkdtempSync(join(tmpdir(), "agency-deferred-mcp-eager-"));
    dirs.push(root);
    const tracker = { starts: 0, closes: 0 };
    const scope = await createSessionScope({
      deps: depsFor(root),
      http: noopHttp,
      workspaceRoot: root,
      snapshotDir: join(root, "snapshots"),
      mcpServers: { srv: { command: "fake" } },
      mcpTransportFor: () => scriptedTransport(tracker),
    });
    try {
      expect(tracker.starts).toBe(1);
      expect(scope.registry.names()).toContain("srv_tool");
    } finally {
      await scope.dispose();
    }
  });

  test("latency: deferred tool-offer build never regresses; startup wins", async () => {
    const HEAVY = 25;
    const SPIN_MS = 3;

    const buildEager = () => {
      const reg = new ToolRegistry();
      for (let i = 0; i < HEAVY; i++) {
        spinMs(SPIN_MS);
        reg.register(makeSpec(`heavy_${i}`));
      }
      return reg;
    };
    const buildDeferred = () => {
      const reg = new ToolRegistry();
      for (let i = 0; i < HEAVY; i++) {
        const name = `heavy_${i}`;
        reg.registerDeferred(name, () => {
          spinMs(SPIN_MS);
          return makeSpec(name);
        });
      }
      return reg;
    };

    let t0 = performance.now();
    const eager = buildEager();
    const eagerBuildMs = performance.now() - t0;

    t0 = performance.now();
    const deferred = buildDeferred();
    const deferredBuildMs = performance.now() - t0;

    // Steady-state offer after warmup: parity (generous margin, not exact).
    eager.forAgent(() => true);
    deferred.forAgent(() => true);
    const ROUNDS = 20;
    t0 = performance.now();
    for (let i = 0; i < ROUNDS; i++) eager.forAgent(() => true);
    const eagerOfferMs = (performance.now() - t0) / ROUNDS;
    t0 = performance.now();
    for (let i = 0; i < ROUNDS; i++) deferred.forAgent(() => true);
    const deferredOfferMs = (performance.now() - t0) / ROUNDS;

    // Scope startup with a slow MCP transport: eager awaits it, deferred skips it.
    const root = mkdtempSync(join(tmpdir(), "agency-deferred-lat-"));
    dirs.push(root);
    const scopeOpts = (defer: boolean, tracker: { starts: number; closes: number }) => ({
      deps: depsFor(root),
      http: noopHttp,
      workspaceRoot: root,
      snapshotDir: join(root, "snapshots"),
      mcpServers: { srv: { command: "fake" } },
      mcpTransportFor: () => scriptedTransport(tracker, 100),
      ...(defer ? { mcpDeferred: true as const } : {}),
    });
    t0 = performance.now();
    const eagerScope = await createSessionScope(scopeOpts(false, { starts: 0, closes: 0 }));
    const eagerScopeMs = performance.now() - t0;
    t0 = performance.now();
    const lazyScope = await createSessionScope(scopeOpts(true, { starts: 0, closes: 0 }));
    const lazyScopeMs = performance.now() - t0;

    console.log(
      `deferred-latency build eager=${eagerBuildMs.toFixed(1)}ms deferred=${deferredBuildMs.toFixed(1)}ms ` +
        `offer/round eager=${eagerOfferMs.toFixed(3)}ms deferred=${deferredOfferMs.toFixed(3)}ms ` +
        `scope-startup eager=${eagerScopeMs.toFixed(1)}ms deferred=${lazyScopeMs.toFixed(1)}ms`,
    );
    await eagerScope.dispose();
    await lazyScope.dispose();

    expect(deferredBuildMs).toBeLessThan(eagerBuildMs);
    expect(deferredOfferMs).toBeLessThanOrEqual(eagerOfferMs + 25);
    expect(lazyScopeMs).toBeLessThan(eagerScopeMs);
  });
});

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/events.ts";
import {
  collectPluginInstructions,
  collectPluginTierFiles,
  createPluginHookContext,
  scopeCapabilitiesForPlugin,
  wrapHookHandler,
} from "../src/plugins/context.ts";
import { loadPlugins } from "../src/plugins/loader.ts";

function setupWs(): string {
  return mkdtempSync(join(tmpdir(), "agency-plugin-ctx47-"));
}

function writePlugin(dir: string, name: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.js`), body);
}

describe("hierarchical AGENTS.md injection (project → user → npm)", () => {
  test("project plugin instructions inject before user plugin instructions", async () => {
    const ws = setupWs();
    const userConfig = mkdtempSync(join(tmpdir(), "agency-plugin-ctx47-user-"));
    try {
      writePlugin(join(ws, ".agency", "plugins"), "alpha", `export const agentsMd = "project-alpha";`);
      writePlugin(join(userConfig, "plugins"), "beta", `export const agentsMd = "user-beta";`);
      const bus = new EventBus();
      const result = await loadPlugins({ workspaceRoot: ws, configDirOverride: userConfig, bus });
      expect(result.plugins.map((p) => `${p.tier}:${p.id}`)).toEqual(["project:alpha", "user:beta"]);
      expect(result.instructions).toEqual(["project-alpha", "user-beta"]);
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(userConfig, { recursive: true, force: true });
    }
  });

  test("tier-level AGENTS.md files inject before per-plugin contributions", async () => {
    const ws = setupWs();
    const userConfig = mkdtempSync(join(tmpdir(), "agency-plugin-ctx47-tier-"));
    try {
      mkdirSync(join(ws, ".agency", "plugins"), { recursive: true });
      writeFileSync(join(ws, ".agency", "plugins", "AGENTS.md"), "project-tier-file");
      mkdirSync(join(userConfig, "plugins"), { recursive: true });
      writeFileSync(join(userConfig, "plugins", "AGENTS.md"), "user-tier-file");
      writePlugin(join(ws, ".agency", "plugins"), "alpha", `export const agentsMd = "project-alpha";`);
      const bus = new EventBus();
      const result = await loadPlugins({ workspaceRoot: ws, configDirOverride: userConfig, bus });
      expect(result.instructions).toEqual(["project-tier-file", "user-tier-file", "project-alpha"]);
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(userConfig, { recursive: true, force: true });
    }
  });

  test("sibling <id>.md file is injected for file-loaded plugins", async () => {
    const ws = setupWs();
    try {
      writePlugin(
        join(ws, ".agency", "plugins"),
        "hello",
        `export const hooks = { "session.created": async () => {} };`,
      );
      writeFileSync(join(ws, ".agency", "plugins", "hello.md"), "sibling hello text");
      const bus = new EventBus();
      const result = await loadPlugins({ workspaceRoot: ws, bus });
      expect(result.plugins.length).toBe(1);
      expect(result.instructions).toEqual(["sibling hello text"]);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("oversized contributions truncate with a visible notice", async () => {
    const ws = setupWs();
    try {
      writePlugin(join(ws, ".agency", "plugins"), "big", `export const agentsMd = "0123456789ABCDEF";`);
      const bus = new EventBus();
      const result = await loadPlugins({ workspaceRoot: ws, bus, maxInstructionBytes: 10 });
      expect(result.instructions.length).toBe(1);
      expect(result.instructions[0]).toContain("[plugin instruction truncated to 10 bytes: big]");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("non-string agentsMd degrades to no instructions without failing the load", async () => {
    const ws = setupWs();
    try {
      writePlugin(
        join(ws, ".agency", "plugins"),
        "sloppy",
        `export const agentsMd = 12345; export const hooks = { "session.created": async () => {} };`,
      );
      const bus = new EventBus();
      const result = await loadPlugins({ workspaceRoot: ws, bus });
      expect(result.plugins.some((p) => p.id === "sloppy")).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.instructions).toEqual([]);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("collectPluginInstructions preserves load order across tiers (incl. npm)", () => {
    const ordered = collectPluginInstructions([
      {
        id: "p",
        path: "/ws/.agency/plugins/p.js",
        tier: "project",
        definition: { id: "p", agentsMd: "p-text" },
        unsubscribes: [],
      },
      {
        id: "u",
        path: "/cfg/plugins/u.js",
        tier: "user",
        definition: { id: "u", agentsMd: ["u-text"] },
        unsubscribes: [],
      },
      {
        id: "n",
        path: "some-npm-pkg",
        tier: "npm",
        definition: { id: "n", agentsMd: "n-text" },
        unsubscribes: [],
      },
    ]);
    expect(ordered).toEqual(["p-text", "u-text", "n-text"]);
  });

  test("collectPluginTierFiles returns project before user", () => {
    const ws = setupWs();
    const userConfig = mkdtempSync(join(tmpdir(), "agency-plugin-ctx47-ord-"));
    try {
      mkdirSync(join(ws, ".agency", "plugins"), { recursive: true });
      writeFileSync(join(ws, ".agency", "plugins", "AGENTS.md"), "proj");
      mkdirSync(join(userConfig, "plugins"), { recursive: true });
      writeFileSync(join(userConfig, "plugins", "AGENTS.md"), "usr");
      expect(collectPluginTierFiles(ws, userConfig)).toEqual(["proj", "usr"]);
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(userConfig, { recursive: true, force: true });
    }
  });
});

describe("capability-scoped PluginHookContext", () => {
  test("each plugin gets an isolated frozen copy — no shared reference", async () => {
    const ws = setupWs();
    try {
      writePlugin(
        join(ws, ".agency", "plugins"),
        "a",
        `export const hooks = { "session.created": async (p, ctx) => { globalThis.__ctxA = ctx; } };`,
      );
      writePlugin(
        join(ws, ".agency", "plugins"),
        "b",
        `export const hooks = { "session.created": async (p, ctx) => { globalThis.__ctxB = ctx; } };`,
      );
      const bus = new EventBus();
      const base = { tools: ["read"], pathScopes: [ws], network: "none" as const };
      await loadPlugins({ workspaceRoot: ws, bus, capabilities: base });
      await bus.emitAsync("session.created", { sessionId: "s1" });
      const ctxA = (globalThis as unknown as Record<string, { capabilities: { tools: readonly string[] } }>)
        .__ctxA;
      const ctxB = (globalThis as unknown as Record<string, { capabilities: { tools: readonly string[] } }>)
        .__ctxB;
      expect(ctxA?.capabilities).not.toBe(ctxB?.capabilities);
      expect(Object.isFrozen(ctxA?.capabilities)).toBe(true);
      expect(Object.isFrozen(ctxB?.capabilities)).toBe(true);
      expect(ctxA?.capabilities.tools).toEqual(["read"]);
      expect(base.tools).toEqual(["read"]);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("scopeCapabilitiesForPlugin clones arrays and freezes", () => {
    const base = { tools: ["read"], pathScopes: ["/ws"], network: ["example.com"] as readonly string[] };
    const scoped = scopeCapabilitiesForPlugin(base, "p1");
    expect(scoped).not.toBe(base);
    expect(scoped.tools).not.toBe(base.tools);
    expect(Object.isFrozen(scoped)).toBe(true);
    (base.tools as string[]).push("write");
    expect(scoped.tools).toEqual(["read"]);
  });

  test("createPluginHookContext tags per-plugin identity", () => {
    const bus = new EventBus();
    const ctx = createPluginHookContext(
      bus,
      { tools: "*", pathScopes: "*", network: "none" },
      "myplug",
      "/ws",
    );
    expect(ctx.identity).toEqual({ type: "plugin", id: "myplug" });
    expect(ctx.workspaceRoot).toBe("/ws");
    expect(Object.isFrozen(ctx)).toBe(true);
  });
});

describe("error isolation wrapper", () => {
  test("a throwing hook does not break sibling hooks or reject", async () => {
    const bus = new EventBus();
    const order: string[] = [];
    const ctx = createPluginHookContext(bus, { tools: "*", pathScopes: "*", network: "none" }, "p", "/ws");
    const bad = wrapHookHandler(
      "p",
      "session.created",
      () => {
        throw new Error("boom");
      },
      ctx,
    );
    const good = wrapHookHandler(
      "q",
      "session.created",
      async () => {
        order.push("good");
      },
      ctx,
    );
    bus.on("session.created", bad);
    bus.on("session.created", good);
    await expect(bus.emitAsync("session.created", { sessionId: "s" })).resolves.toBeUndefined();
    await expect(bad({})).resolves.toBeUndefined();
    expect(order).toEqual(["good"]);
  });

  test("loader-level: one throwing plugin hook still lets others fire", async () => {
    const ws = setupWs();
    try {
      writePlugin(
        join(ws, ".agency", "plugins"),
        "bad",
        `export const hooks = { "session.created": async () => { throw new Error("bad boom"); } };`,
      );
      writePlugin(
        join(ws, ".agency", "plugins"),
        "good",
        `export const hooks = { "session.created": async () => { globalThis.__goodFired47 = true; } };`,
      );
      const bus = new EventBus();
      (globalThis as unknown as Record<string, unknown>).__goodFired47 = false;
      await loadPlugins({ workspaceRoot: ws, bus });
      await bus.emitAsync("session.created", { sessionId: "s1" });
      expect((globalThis as unknown as Record<string, unknown>).__goodFired47).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

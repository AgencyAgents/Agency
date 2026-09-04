import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/events.ts";
import { loadPlugins, unloadPlugins } from "../src/plugins/loader.ts";
import { HOOK_NAMES } from "../src/plugins/types.ts";

/**
 * Item 45 — plugin hook surface parity.
 * Locks: wildcard subscriptions (tool.* -> .*, bare *), async
 * emit/emitAsync/emitCollect with error isolation, and delivery of every
 * listed hook event through the plugin loader registry.
 */
describe("item 45: plugin hook surface", () => {
  test("HOOK_NAMES exposes every required hook event", () => {
    for (const name of [
      "event",
      "tool.execute.before",
      "tool.execute.after",
      "session.created",
      "session.compacted",
      "session.idle",
      "file.edited",
      "permission.asked",
      "permission.replied",
      "shell.env",
    ] as const) {
      expect([...HOOK_NAMES]).toContain(name);
    }
  });

  test("wildcard tool.* matches before+after but not session events", async () => {
    const bus = new EventBus();
    const hits: string[] = [];
    bus.on("tool.*", async (p) => {
      hits.push((p as { tool: string }).tool);
    });
    await bus.emitAsync("tool.execute.before", { tool: "bash", input: {} });
    await bus.emitAsync("tool.execute.after", { tool: "bash", input: {}, result: { content: "ok" } });
    await bus.emitAsync("session.created", { sessionId: "s1" });
    expect(hits).toEqual(["bash", "bash"]);
  });

  test("emitAsync isolates errors and preserves order of survivors", async () => {
    const bus = new EventBus();
    const order: string[] = [];
    bus.on("shell.env", async () => {
      order.push("first");
    });
    bus.on("shell.env", async () => {
      throw new Error("env boom");
    });
    bus.on("shell.env", async () => {
      order.push("third");
    });
    await bus.emitAsync("shell.env", { env: { A: "1" } });
    expect(order).toEqual(["first", "third"]);
  });

  test("emitCollect reports per-listener errors for short-circuit callers", async () => {
    const bus = new EventBus();
    bus.on("tool.execute.before", () => {
      throw new Error("deny");
    });
    bus.on("tool.execute.before", () => {});
    const { errors } = await bus.emitCollect("tool.execute.before", { tool: "bash", input: {} });
    expect(errors.length).toBe(1);
    expect((errors[0] as Error).message).toBe("deny");
  });

  test("loader: exact hooks receive every listed event; event hook gets all via *", async () => {
    const ws = join(tmpdir(), `agency-hooks-45-${Date.now()}`);
    mkdirSync(join(ws, ".agency", "plugins"), { recursive: true });
    writeFileSync(
      join(ws, ".agency", "plugins", "all.js"),
      `export const hooks = {
        "tool.execute.before": async (p) => { (globalThis.__seen45 ||= []).push("tool.execute.before"); },
        "tool.execute.after": async (p) => { (globalThis.__seen45 ||= []).push("tool.execute.after"); },
        "session.created": async (p) => { (globalThis.__seen45 ||= []).push("session.created"); },
        "session.compacted": async (p) => { (globalThis.__seen45 ||= []).push("session.compacted"); },
        "session.idle": async (p) => { (globalThis.__seen45 ||= []).push("session.idle"); },
        "file.edited": async (p) => { (globalThis.__seen45 ||= []).push("file.edited"); },
        "permission.asked": async (p) => { (globalThis.__seen45 ||= []).push("permission.asked"); },
        "permission.replied": async (p) => { (globalThis.__seen45 ||= []).push("permission.replied"); },
        "shell.env": async (p) => { (globalThis.__seen45 ||= []).push("shell.env"); },
        "event": async (p) => { (globalThis.__star45 ||= []).push(1); },
      };`,
    );
    const g = globalThis as unknown as Record<string, unknown[]>;
    g.__seen45 = [];
    g.__star45 = [];
    const bus = new EventBus();
    const { plugins, errors } = await loadPlugins({ workspaceRoot: ws, bus });
    try {
      expect(errors).toEqual([]);
      expect(plugins.length).toBe(1);
      await bus.emitAsync("tool.execute.before", { tool: "read", input: {} });
      await bus.emitAsync("tool.execute.after", { tool: "read", input: {}, result: { content: "ok" } });
      await bus.emitAsync("session.created", { sessionId: "s1" });
      await bus.emitAsync("session.compacted", { sessionId: "s1", tipId: "t1" });
      await bus.emitAsync("session.idle", { sessionId: "s1" });
      await bus.emitAsync("file.edited", { path: "a.ts" });
      await bus.emitAsync("permission.asked", { tool: "bash", decision: "ask" });
      await bus.emitAsync("permission.replied", { tool: "bash", decision: "allow" });
      await bus.emitAsync("shell.env", { env: {} });
      expect([...(g.__seen45 as string[])].sort()).toEqual(
        [
          "file.edited",
          "permission.asked",
          "permission.replied",
          "session.compacted",
          "session.created",
          "session.idle",
          "shell.env",
          "tool.execute.after",
          "tool.execute.before",
        ].sort(),
      );
      // "event" hook subscribes to "*": fires once per emit above (9).
      expect((g.__star45 as unknown[]).length).toBe(9);
      // Throwing exact hook does not block the wildcard listener on the same event.
      bus.on("file.edited", () => {
        throw new Error("exact boom");
      });
      const before = (g.__star45 as unknown[]).length;
      await bus.emitAsync("file.edited", { path: "b.ts" });
      expect((g.__star45 as unknown[]).length).toBe(before + 1);
    } finally {
      unloadPlugins(plugins);
      rmSync(ws, { recursive: true, force: true });
      delete g.__seen45;
      delete g.__star45;
    }
  });

  test("loader: tool.* wildcard hook fires for before+after", async () => {
    const ws = join(tmpdir(), `agency-hookwild-45-${Date.now()}`);
    mkdirSync(join(ws, ".agency", "plugins"), { recursive: true });
    writeFileSync(
      join(ws, ".agency", "plugins", "wild.js"),
      `export const hooks = { "tool.*": async () => { globalThis.__wild45 = (globalThis.__wild45 || 0) + 1; } };`,
    );
    const g = globalThis as unknown as Record<string, unknown>;
    g.__wild45 = 0;
    const bus = new EventBus();
    const { plugins } = await loadPlugins({ workspaceRoot: ws, bus });
    try {
      await bus.emitAsync("tool.execute.before", { tool: "read", input: {} });
      await bus.emitAsync("tool.execute.after", { tool: "read", input: {}, result: { content: "ok" } });
      await bus.emitAsync("session.idle", { sessionId: "s9" });
      expect(g.__wild45).toBe(2);
    } finally {
      unloadPlugins(plugins);
      rmSync(ws, { recursive: true, force: true });
      delete g.__wild45;
    }
  });
});

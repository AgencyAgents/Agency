import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/events.ts";
import { runTurn } from "../src/loop.ts";
import { loadPlugins } from "../src/plugins/loader.ts";

class FakeRegistry {
  private m = new Map<string, unknown>();
  register(spec: { name: string }) {
    if (this.m.has(spec.name)) throw new Error(`tool "${spec.name}" is already registered`);
    this.m.set(spec.name, spec);
  }
  has(name: string) {
    return this.m.has(name);
  }
  list() {
    return [...this.m.values()] as never[];
  }
}

import type { HttpClient } from "@agency/net";
import type { ProviderAdapter } from "@agency/providers";

describe("plugin loader", () => {
  test("discovers and loads project plugin", async () => {
    const ws = join(tmpdir(), `agency-plugin-ws-${Date.now()}`);
    mkdirSync(join(ws, ".agency", "plugins"), { recursive: true });
    const pluginPath = join(ws, ".agency", "plugins", "hello.js");
    writeFileSync(
      pluginPath,
      `export const hooks = { "tool.execute.before": async () => {} }; export const tools = [{ name: "mytool", description: "hi", inputSchema: { type: "object", properties: {} }, riskTier: "safe", handler: async () => ({ content: "ok" }) }];`,
    );
    const bus = new EventBus();
    const registry = new FakeRegistry();
    const result = await loadPlugins({ workspaceRoot: ws, bus, registry: registry as never });
    expect(result.plugins.length).toBe(1);
    expect(result.plugins[0]!.id).toBe("hello");
    expect(registry.has("hello_mytool")).toBe(true);
    rmSync(ws, { recursive: true, force: true });
  });

  test("plugin tool namespacing: registry uses pluginId_toolName", async () => {
    const ws = join(tmpdir(), `agency-plugin-ns-${Date.now()}`);
    mkdirSync(join(ws, ".agency", "plugins"), { recursive: true });
    writeFileSync(
      join(ws, ".agency", "plugins", "myplugin.js"),
      `export const tools = [{ name: "greet", description: "g", inputSchema: { type: "object" }, riskTier: "safe", handler: async () => ({ content: "hi" }) }];`,
    );
    const bus = new EventBus();
    const registry = new FakeRegistry();
    await loadPlugins({ workspaceRoot: ws, bus, registry: registry as never });
    expect(registry.has("myplugin_greet")).toBe(true);
    expect(registry.has("greet")).toBe(false);
    rmSync(ws, { recursive: true, force: true });
  });

  test("one bad plugin does not break others (error isolation)", async () => {
    const ws = join(tmpdir(), `agency-plugin-bad-${Date.now()}`);
    mkdirSync(join(ws, ".agency", "plugins"), { recursive: true });
    writeFileSync(join(ws, ".agency", "plugins", "bad.js"), `throw new Error("load fail");`);
    writeFileSync(
      join(ws, ".agency", "plugins", "good.js"),
      `export const hooks = { "session.created": async () => {} };`,
    );
    const bus = new EventBus();
    const result = await loadPlugins({ workspaceRoot: ws, bus });
    expect(result.plugins.some((p) => p.id === "good")).toBe(true);
    expect(result.errors.some((e) => e.id === "bad")).toBe(true);
    rmSync(ws, { recursive: true, force: true });
  });

  test("hooks firing: plugin hook receives bus event", async () => {
    const ws = join(tmpdir(), `agency-plugin-hook-${Date.now()}`);
    mkdirSync(join(ws, ".agency", "plugins"), { recursive: true });
    writeFileSync(
      join(ws, ".agency", "plugins", "hooktest.js"),
      `export const hooks = { "tool.execute.before": async (payload, ctx) => { globalThis.__hookCalled = (globalThis.__hookCalled || 0) + 1; }, "file.edited": async (payload) => { globalThis.__fileEdited = payload.path; } };`,
    );
    const bus = new EventBus();
    (globalThis as unknown as Record<string, unknown>).__hookCalled = 0;
    await loadPlugins({ workspaceRoot: ws, bus });
    await bus.emitAsync("tool.execute.before", { tool: "bash", input: {} });
    expect((globalThis as unknown as Record<string, unknown>).__hookCalled).toBe(1);
    await bus.emitAsync("file.edited", { path: "src/foo.ts" });
    expect((globalThis as unknown as Record<string, unknown>).__fileEdited).toBe("src/foo.ts");
    rmSync(ws, { recursive: true, force: true });
  });

  test("tool.execute.before hook can short-circuit tool execution via error isolation + emitCollect", async () => {
    const bus = new EventBus();
    bus.on("tool.execute.before", () => {
      throw new Error("deny this tool");
    });
    const fakeAdapter: ProviderAdapter = {
      family: "fake",
      stream: async function* () {
        yield { type: "tool_call_start", id: "c1", name: "bash" } as never;
        yield {
          type: "tool_call_delta",
          id: "c1",
          inputJsonDelta: JSON.stringify({ command: "echo hi" }),
        } as never;
        yield { type: "tool_call_end", id: "c1" } as never;
        yield {
          type: "message_stop",
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "tool_use",
        } as never;
      },
    };
    const fakeScheduler = {
      schedule: (fn: () => Promise<never>) => fn(),
    } as unknown as import("@agency/providers").Scheduler;
    const http = {} as HttpClient;
    const result = await runTurn(fakeAdapter, fakeScheduler as never, http, {
      identity: { type: "user" },
      capabilities: { tools: "*", pathScopes: "*", network: "*" },
      systemPrompt: "test",
      tools: [
        {
          name: "bash",
          description: "bash",
          inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
          riskTier: "dangerous",
          handler: async () => ({ content: "should not run" }),
        },
      ],
      model: "m",
      apiKey: "k",
      session: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      eventBus: bus,
      maxToolIterations: 1,
    });
    const userMsg = result.messages.find(
      (m) => m.role === "user" && m.content.some((b) => b.type === "tool_result"),
    );
    const toolResult = userMsg?.content.find((b) => b.type === "tool_result") as
      | { content: string; isError: boolean }
      | undefined;
    expect(toolResult?.isError).toBe(true);
    expect(toolResult?.content).toContain("deny this tool");
  });

  test("wildcard hook receives multiple event types", async () => {
    const ws = join(tmpdir(), `agency-plugin-wild-${Date.now()}`);
    mkdirSync(join(ws, ".agency", "plugins"), { recursive: true });
    writeFileSync(
      join(ws, ".agency", "plugins", "wild.js"),
      `export const hooks = { "tool.*": async (payload) => { globalThis.__wildCount = (globalThis.__wildCount || 0) + 1; } };`,
    );
    const bus = new EventBus();
    (globalThis as unknown as Record<string, unknown>).__wildCount = 0;
    await loadPlugins({ workspaceRoot: ws, bus });
    await bus.emitAsync("tool.execute.before", { tool: "read", input: {} });
    await bus.emitAsync("tool.execute.after", { tool: "read", input: {}, result: { content: "ok" } });
    expect((globalThis as unknown as Record<string, unknown>).__wildCount).toBe(2);
    rmSync(ws, { recursive: true, force: true });
  });

  test("plugin hook throwing does not crash bus (error isolation)", async () => {
    const bus = new EventBus();
    let secondCalled = false;
    bus.on("session.created", () => {
      throw new Error("plugin boom");
    });
    bus.on("session.created", () => {
      secondCalled = true;
    });
    await bus.emitAsync("session.created", { sessionId: "s1" });
    expect(secondCalled).toBe(true);
  });
});

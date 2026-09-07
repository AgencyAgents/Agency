import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/events.ts";
import { loadPlugins, pluginMcpServers } from "../src/plugins/loader.ts";

function makeWorkspace(tag: string): string {
  const ws = join(tmpdir(), `agency-skill-mcp-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(join(ws, ".agency", "plugins"), { recursive: true });
  return ws;
}

describe("skill-embedded mcpServers declarations", () => {
  test("plugin exporting only mcpServers loads with declarations preserved", async () => {
    const ws = makeWorkspace("only");
    writeFileSync(
      join(ws, ".agency", "plugins", "skill.js"),
      `export const mcpServers = { helper: { command: "fake-helper" } };`,
    );
    const result = await loadPlugins({ workspaceRoot: ws, bus: new EventBus() });
    expect(result.errors).toEqual([]);
    expect(result.plugins.length).toBe(1);
    expect(result.plugins[0]!.definition.mcpServers).toEqual({ helper: { command: "fake-helper" } });
    rmSync(ws, { recursive: true, force: true });
  });

  test("mcpServers coexist with hooks and tools", async () => {
    const ws = makeWorkspace("combo");
    writeFileSync(
      join(ws, ".agency", "plugins", "combo.js"),
      `export const hooks = { "session.created": async () => {} };
       export const tools = [{ name: "t", description: "d", inputSchema: { type: "object" }, handler: async () => ({ content: "ok" }) }];
       export const mcpServers = { srv: { command: "fake" } };`,
    );
    const result = await loadPlugins({ workspaceRoot: ws, bus: new EventBus() });
    expect(result.errors).toEqual([]);
    const def = result.plugins[0]!.definition;
    expect(def.hooks).toBeDefined();
    expect(def.tools?.length).toBe(1);
    expect(def.mcpServers).toEqual({ srv: { command: "fake" } });
    rmSync(ws, { recursive: true, force: true });
  });

  test("non-record mcpServers entries are dropped; empty map means no declaration", async () => {
    const ws = makeWorkspace("filter");
    writeFileSync(
      join(ws, ".agency", "plugins", "weird.js"),
      `export const hooks = { "session.created": async () => {} };
       export const mcpServers = { good: { command: "fake" }, bad: 42, alsoBad: "nope" };`,
    );
    const result = await loadPlugins({ workspaceRoot: ws, bus: new EventBus() });
    expect(result.plugins[0]!.definition.mcpServers).toEqual({ good: { command: "fake" } });

    const ws2 = makeWorkspace("empty");
    writeFileSync(
      join(ws2, ".agency", "plugins", "empty.js"),
      `export const hooks = { "session.created": async () => {} };
       export const mcpServers = { bad: 42 };`,
    );
    const result2 = await loadPlugins({ workspaceRoot: ws2, bus: new EventBus() });
    expect(result2.plugins[0]!.definition.mcpServers).toBeUndefined();
    rmSync(ws, { recursive: true, force: true });
    rmSync(ws2, { recursive: true, force: true });
  });

  test("invalid plugin shape error mentions mcpServers", async () => {
    const ws = makeWorkspace("invalid");
    writeFileSync(join(ws, ".agency", "plugins", "junk.js"), `export const nothing = 42;`);
    const result = await loadPlugins({ workspaceRoot: ws, bus: new EventBus() });
    expect(result.plugins.length).toBe(0);
    expect(result.errors[0]!.error).toContain("mcpServers");
    rmSync(ws, { recursive: true, force: true });
  });

  test("pluginMcpServers helper returns undefined when nothing declared", () => {
    expect(pluginMcpServers({ mcpServers: undefined })).toBeUndefined();
    expect(pluginMcpServers({ mcpServers: {} })).toBeUndefined();
    expect(pluginMcpServers({ mcpServers: { a: { command: "x" } } })).toEqual({ a: { command: "x" } });
  });
});

import { describe, expect, test } from "bun:test";
import { FULL_CAPABILITIES } from "@agency/guard";
import { startSkillMcpServers, withSkillMcp } from "../../src/mcp/skill-mcp.ts";
import type { McpTransport } from "../../src/mcp/transport.ts";
import { ToolRegistry } from "../../src/registry.ts";

function scriptedTransport(toolName: string, tracker: { starts: number; closes: number }): McpTransport {
  let handler: ((msg: Record<string, unknown>) => void) | undefined;
  let closeCb: (() => void) | undefined;
  return {
    async start() {
      tracker.starts++;
    },
    async send(message: Record<string, unknown>) {
      const id = message.id as number;
      if (message.method === "initialize") handler?.({ jsonrpc: "2.0", id, result: {} });
      else if (message.method === "notifications/initialized") {
        /* no response */
      } else if (message.method === "tools/list")
        handler?.({ jsonrpc: "2.0", id, result: { tools: [{ name: toolName }] } });
      else if (message.method === "tools/call") handler?.({ jsonrpc: "2.0", id, result: { content: "ok" } });
    },
    onMessage(h) {
      handler = h;
    },
    onClose(cb) {
      closeCb = cb;
    },
    async close() {
      tracker.closes++;
      closeCb?.();
    },
  };
}

describe("skill-embedded MCP on-demand scope", () => {
  test("no declaration starts nothing and returns undefined", async () => {
    const tracker = { starts: 0, closes: 0 };
    expect(
      await startSkillMcpServers(
        { id: "plain" },
        {
          capabilities: FULL_CAPABILITIES,
          transportFor: () => scriptedTransport("t", tracker),
        },
      ),
    ).toBeUndefined();
    expect(
      await startSkillMcpServers(
        { id: "empty", mcpServers: {} },
        {
          capabilities: FULL_CAPABILITIES,
          transportFor: () => scriptedTransport("t", tracker),
        },
      ),
    ).toBeUndefined();
    expect(tracker.starts).toBe(0);
  });

  test("invalid declaration throws a legible skill-scoped error", async () => {
    await expect(
      startSkillMcpServers(
        { id: "bad", mcpServers: { srv: 42 as unknown as Record<string, unknown> } },
        {
          capabilities: FULL_CAPABILITIES,
        },
      ),
    ).rejects.toThrow(/invalid mcpServers for skill "bad"/);
  });

  test("spawn on demand exposes tools and dispose closes transports (idempotent)", async () => {
    const tracker = { starts: 0, closes: 0 };
    const manager = await startSkillMcpServers(
      { id: "helper", mcpServers: { srv: { command: "fake" } } },
      { capabilities: FULL_CAPABILITIES, transportFor: () => scriptedTransport("helperTool", tracker) },
    );
    expect(manager).toBeDefined();
    expect(manager!.tools.map((t) => t.name)).toEqual(["srv_helperTool"]);
    expect(tracker.starts).toBe(1);
    await manager!.dispose();
    expect(manager!.tools.length).toBe(0);
    expect(tracker.closes).toBeGreaterThanOrEqual(1);
    const closesAfterFirst = tracker.closes;
    await manager!.dispose();
    expect(tracker.closes).toBe(closesAfterFirst);
  });

  test("scoped tools are unregistered from the task registry on dispose (no context bloat)", async () => {
    const tracker = { starts: 0, closes: 0 };
    const registry = new ToolRegistry();
    const manager = await startSkillMcpServers(
      { id: "helper", mcpServers: { srv: { command: "fake" } } },
      {
        capabilities: FULL_CAPABILITIES,
        transportFor: () => scriptedTransport("helperTool", tracker),
        registry,
      },
    );
    expect(registry.has("srv_helperTool")).toBe(true);
    await manager!.dispose();
    expect(registry.has("srv_helperTool")).toBe(false);
    expect(registry.list().length).toBe(0);
  });

  test("withSkillMcp cleans up on success", async () => {
    const tracker = { starts: 0, closes: 0 };
    const registry = new ToolRegistry();
    const result = await withSkillMcp(
      { id: "helper", mcpServers: { srv: { command: "fake" } } },
      {
        capabilities: FULL_CAPABILITIES,
        transportFor: () => scriptedTransport("helperTool", tracker),
        registry,
      },
      async (manager) => {
        expect(manager!.tools.map((t) => t.name)).toEqual(["srv_helperTool"]);
        return "done";
      },
    );
    expect(result).toBe("done");
    expect(tracker.closes).toBeGreaterThanOrEqual(1);
    expect(registry.list().length).toBe(0);
  });

  test("withSkillMcp cleans up even when the task throws (no leak)", async () => {
    const tracker = { starts: 0, closes: 0 };
    const registry = new ToolRegistry();
    await expect(
      withSkillMcp(
        { id: "helper", mcpServers: { srv: { command: "fake" } } },
        {
          capabilities: FULL_CAPABILITIES,
          transportFor: () => scriptedTransport("helperTool", tracker),
          registry,
        },
        async () => {
          throw new Error("task boom");
        },
      ),
    ).rejects.toThrow("task boom");
    expect(tracker.closes).toBeGreaterThanOrEqual(1);
    expect(registry.list().length).toBe(0);
  });

  test("withSkillMcp passes undefined through when the skill declares nothing", async () => {
    const seen: unknown[] = [];
    await withSkillMcp({ id: "plain" }, { capabilities: FULL_CAPABILITIES }, async (manager) => {
      seen.push(manager);
    });
    expect(seen).toEqual([undefined]);
  });
});

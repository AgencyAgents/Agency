import { describe, expect, test } from "bun:test";
import { FULL_CAPABILITIES } from "@agency/guard";
import { startMcpServers } from "../../src/mcp/manager.ts";
import type { McpTransport } from "../../src/mcp/transport.ts";

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

describe("McpManager per-session isolation", () => {
  test("two managers are isolated: tools and failures do not leak", async () => {
    const trackA = { starts: 0, closes: 0 };
    const trackB = { starts: 0, closes: 0 };
    const mgrA = await startMcpServers({
      servers: { srv: { command: "fake-a" } },
      capabilities: FULL_CAPABILITIES,
      transportFor: () => scriptedTransport("toolA", trackA),
    });
    const mgrB = await startMcpServers({
      servers: { srv: { command: "fake-b" } },
      capabilities: FULL_CAPABILITIES,
      transportFor: () => scriptedTransport("toolB", trackB),
    });

    expect(mgrA.tools.map((t) => t.name)).toEqual(["srv_toolA"]);
    expect(mgrB.tools.map((t) => t.name)).toEqual(["srv_toolB"]);
    expect(mgrA.tools).not.toBe(mgrB.tools);
    expect(mgrA.failures).not.toBe(mgrB.failures);
    expect(trackA.starts).toBe(1);
    expect(trackB.starts).toBe(1);

    await mgrA.dispose();
    // Disposing A must not touch B's tools
    expect(mgrA.tools.length).toBe(0);
    expect(mgrB.tools.map((t) => t.name)).toEqual(["srv_toolB"]);
    expect(trackA.closes).toBeGreaterThanOrEqual(1);
    expect(trackB.closes).toBe(0);

    await mgrB.dispose();
    expect(mgrB.tools.length).toBe(0);
  });

  test("dispose closes transports and is idempotent", async () => {
    const tracker = { starts: 0, closes: 0 };
    const mgr = await startMcpServers({
      servers: { srv: { command: "fake" } },
      capabilities: FULL_CAPABILITIES,
      transportFor: () => scriptedTransport("t", tracker),
    });
    expect(tracker.starts).toBe(1);
    await mgr.dispose();
    expect(tracker.closes).toBeGreaterThanOrEqual(1);
    const closesAfterFirst = tracker.closes;
    await mgr.dispose();
    expect(tracker.closes).toBe(closesAfterFirst);
  });

  test("identity differs per handle via manager.identityFor", async () => {
    const tracker = { starts: 0, closes: 0 };
    const mgr = await startMcpServers({
      servers: { srv: { command: "fake" } },
      capabilities: FULL_CAPABILITIES,
      transportFor: () => scriptedTransport("t", tracker),
    });
    expect(mgr.identityFor("srv", "alice")).toEqual({ type: "agent", name: "alice" });
    expect(mgr.identityFor("srv", "bob")).toEqual({ type: "agent", name: "bob" });
    expect(mgr.identityFor("srv", "alice")).not.toEqual(mgr.identityFor("srv", "bob"));
    expect(mgr.identityFor("srv")).toEqual({ type: "agent", name: "main" });
    await mgr.dispose();
  });

  test("custom identityFor is threaded through the manager", async () => {
    const tracker = { starts: 0, closes: 0 };
    const mgr = await startMcpServers({
      servers: { srv: { command: "fake" } },
      capabilities: FULL_CAPABILITIES,
      transportFor: () => scriptedTransport("t", tracker),
      identityFor: (_server, handle) => ({ type: "agent", name: `scoped-${handle ?? "main"}` }),
    });
    expect(mgr.identityFor("srv", "alice")).toEqual({ type: "agent", name: "scoped-alice" });
    expect(mgr.identityFor("srv", "bob")).toEqual({ type: "agent", name: "scoped-bob" });
    await mgr.dispose();
  });
});

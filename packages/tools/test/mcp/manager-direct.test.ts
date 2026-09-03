import { describe, expect, test } from "bun:test";
import { FULL_CAPABILITIES } from "@agency/guard";
import { ToolRegistry } from "../../src/registry.ts";
import { startMcpServers } from "../../src/mcp/manager.ts";
import type { McpTransport } from "../../src/mcp/transport.ts";

function scriptedTransport(
  defs: { tools: { name: string; description?: string }[] },
  hooks?: {
    delayMs?: number;
    onClose?: (cb: () => void) => void;
    stderrTail?: string;
  },
): McpTransport {
  let handler: ((msg: Record<string, unknown>) => void) | undefined;
  let closeCb: (() => void) | undefined;
  return {
    async start() {
      if (hooks?.delayMs) await new Promise((r) => setTimeout(r, hooks.delayMs));
    },
    async send(message: Record<string, unknown>) {
      const id = message.id as number;
      if (message.method === "initialize") handler?.({ jsonrpc: "2.0", id, result: {} });
      else if (message.method === "notifications/initialized") { /* no response */ }
      else if (message.method === "tools/list") handler?.({ jsonrpc: "2.0", id, result: { tools: defs.tools } });
      else if (message.method === "tools/call") handler?.({ jsonrpc: "2.0", id, result: { content: "ok" } });
    },
    onMessage(h) {
      handler = h;
    },
    onClose(cb) {
      closeCb = cb;
      hooks?.onClose?.(cb);
    },
    stderrTail() {
      return hooks?.stderrTail ?? "";
    },
    async close() {
      closeCb?.();
    },
  };
}

describe("McpManager direct", () => {
  test("parallel start both servers", async () => {
    const start = Date.now();
    const mgr = await startMcpServers({
      servers: {
        a: { command: "fake-a" },
        b: { command: "fake-b" },
      },
      capabilities: FULL_CAPABILITIES,
      transportFor: (name) =>
        scriptedTransport({ tools: [{ name: "t" }] }, { delayMs: 80 }),
    });
    const elapsed = Date.now() - start;
    expect(mgr.tools.length).toBe(2);
    expect(elapsed).toBeLessThan(250);
    expect(mgr.failures.size).toBe(0);
    await mgr.dispose();
  });

  test("stderr tail included in failure detail", async () => {
    const mgr = await startMcpServers({
      servers: {
        broken: { command: "fake" },
      },
      capabilities: FULL_CAPABILITIES,
      transportFor: () =>
        ({
          async start() {},
          async send(msg: Record<string, unknown>) {
            throw new Error("start failed");
          },
          onMessage() {},
          stderrTail() {
            return "last stderr line: boom";
          },
          async close() {},
        }) as unknown as McpTransport,
    });
    expect(mgr.failures.get("broken")).toContain("boom");
    await mgr.dispose();
  });

  test("tool-list refresh re-fetches and updates registry", async () => {
    const registry = new ToolRegistry();
    let listCalls = 0;
    let changeHandler: (() => void) | undefined;
    const transport: McpTransport = {
      async start() {},
      async send(message: Record<string, unknown>) {
        const id = message.id as number;
        if (message.method === "initialize") {
          (transport as unknown as { _handler?: (m: Record<string, unknown>) => void })._handler?.({
            jsonrpc: "2.0",
            id,
            result: {},
          });
        } else if (message.method === "tools/list") {
          listCalls++;
          const tools = listCalls === 1 ? [{ name: "old" }] : [{ name: "new" }];
          (transport as unknown as { _handler?: (m: Record<string, unknown>) => void })._handler?.({
            jsonrpc: "2.0",
            id,
            result: { tools },
          });
        }
      },
      onMessage(h) {
        (transport as unknown as { _handler: typeof h })._handler = h;
      },
      onClose() {},
      async close() {},
    };
    // hack to capture list_changed handler via client.onListChanged
    // we let manager set it; then trigger refresh by calling the client path directly
    // Simpler: test via manager's onListChanged indirectly: we simulate notification after start
    const mgr = await startMcpServers({
      servers: { srv: { command: "fake" } },
      capabilities: FULL_CAPABILITIES,
      transportFor: () => transport,
      registry,
    });
    expect(registry.has("srv_old")).toBe(true);
    expect(registry.has("srv_new")).toBe(false);
    // Trigger refresh: we need access to client's onListChanged; simulate by sending notification through transport
    const handler = (transport as unknown as { _handler: (m: Record<string, unknown>) => void })._handler;
    handler({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    // wait for async refresh
    await new Promise((r) => setTimeout(r, 100));
    expect(registry.has("srv_old")).toBe(false);
    expect(registry.has("srv_new")).toBe(true);
    await mgr.dispose();
  });

  test("crash removes tools and schedules restart with backoff", async () => {
    const registry = new ToolRegistry();
    let crashClose: (() => void) | undefined;
    let startCount = 0;
    const transportFor = (): McpTransport => {
      startCount++;
      let msgHandler: ((m: Record<string, unknown>) => void) | undefined;
      let closeHandler: (() => void) | undefined;
      const shouldCrash = startCount === 1;
      return {
        async start() {},
        async send(msg: Record<string, unknown>) {
          const id = msg.id as number;
          if (msg.method === "initialize") msgHandler?.({ jsonrpc: "2.0", id, result: {} });
          else if (msg.method === "tools/list") msgHandler?.({ jsonrpc: "2.0", id, result: { tools: [{ name: "t" }] } });
        },
        onMessage(h) {
          msgHandler = h;
        },
        onClose(cb) {
          closeHandler = cb;
          if (shouldCrash) crashClose = cb;
        },
        stderrTail() {
          return "crash stderr";
        },
        async close() {
          closeHandler?.();
        },
      };
    };
    const mgr = await startMcpServers({
      servers: { srv: { command: "fake" } },
      capabilities: FULL_CAPABILITIES,
      transportFor,
      registry,
      baseBackoffMs: 30,
      maxRestarts: 2,
    });
    expect(registry.has("srv_t")).toBe(true);
    expect(mgr.failures.size).toBe(0);
    // simulate crash
    crashClose?.();
    await new Promise((r) => setTimeout(r, 20));
    expect(mgr.failures.get("srv")).toContain("crashed");
    expect(registry.has("srv_t")).toBe(false);
    // wait for restart backoff
    await new Promise((r) => setTimeout(r, 80));
    expect(registry.has("srv_t")).toBe(true);
    expect(mgr.failures.has("srv")).toBe(false);
    await mgr.dispose();
  });
});

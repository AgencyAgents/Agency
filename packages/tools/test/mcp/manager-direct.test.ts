import { describe, expect, test } from "bun:test";
import { FULL_CAPABILITIES } from "@agency/guard";
import { McpClient } from "../../src/mcp/client.ts";
import { mcpIdentityFor, startMcpServers } from "../../src/mcp/manager.ts";
import type { McpTransport } from "../../src/mcp/transport.ts";
import { ToolRegistry } from "../../src/registry.ts";

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
      else if (message.method === "notifications/initialized") {
        /* no response */
      } else if (message.method === "tools/list")
        handler?.({ jsonrpc: "2.0", id, result: { tools: defs.tools } });
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
      transportFor: (_name) => scriptedTransport({ tools: [{ name: "t" }] }, { delayMs: 80 }),
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
          async send(_msg: Record<string, unknown>) {
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

  test("callTool abort via signal cancels pending request", async () => {
    let msgHandler: ((m: Record<string, unknown>) => void) | undefined;
    const transport: McpTransport = {
      async start() {},
      async send() {},
      onMessage(h) {
        msgHandler = h;
      },
      async close() {},
    };
    void msgHandler;
    const client = new McpClient("srv", transport, {
      requestTimeoutMs: 5000,
      toolCallTimeoutMs: 5000,
    });
    const controller = new AbortController();
    const pending = client.callTool("foo", {}, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/);
    await client.close();
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
          else if (msg.method === "tools/list")
            msgHandler?.({ jsonrpc: "2.0", id, result: { tools: [{ name: "t" }] } });
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

  test("crash restart gives up after 3 retries and stays failed", async () => {
    const registry = new ToolRegistry();
    let startCount = 0;
    const transportFor = (): McpTransport => {
      startCount++;
      let msgHandler: ((m: Record<string, unknown>) => void) | undefined;
      let closeHandler: (() => void) | undefined;
      return {
        async start() {
          setTimeout(() => closeHandler?.(), 5);
        },
        async send(msg: Record<string, unknown>) {
          const id = msg.id as number;
          if (msg.method === "initialize") msgHandler?.({ jsonrpc: "2.0", id, result: {} });
          else if (msg.method === "tools/list")
            msgHandler?.({ jsonrpc: "2.0", id, result: { tools: [{ name: "t" }] } });
        },
        onMessage(h) {
          msgHandler = h;
        },
        onClose(cb) {
          closeHandler = cb;
        },
        stderrTail() {
          return "always crashes";
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
      baseBackoffMs: 20,
      maxRestarts: 3,
    });
    await new Promise((r) => setTimeout(r, 600));
    expect(startCount).toBe(4);
    expect(mgr.failures.get("srv")).toContain("crashed");
    expect(registry.has("srv_t")).toBe(false);
    await new Promise((r) => setTimeout(r, 250));
    expect(startCount).toBe(4);
    await mgr.dispose();
  });
});

describe("mcpIdentityFor", () => {
  test("returns main when no handle is provided", () => {
    const identity = mcpIdentityFor("any-server");
    expect(identity).toEqual({ type: "agent", name: "main" });
  });

  test("returns the given handle when provided", () => {
    const identity = mcpIdentityFor("any-server", "coder");
    expect(identity).toEqual({ type: "agent", name: "coder" });
  });

  test("accepts different handles per call", () => {
    expect(mcpIdentityFor("srv1", "alice")).toEqual({ type: "agent", name: "alice" });
    expect(mcpIdentityFor("srv2", "bob")).toEqual({ type: "agent", name: "bob" });
    expect(mcpIdentityFor("srv3")).toEqual({ type: "agent", name: "main" });
  });
});

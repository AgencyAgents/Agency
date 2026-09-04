import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CallerIdentity, type Capabilities, SandboxBoundary } from "@agency/guard";
import type { HttpClient } from "@agency/net";
import type { ToolDeps } from "../src/contract.ts";
import type { McpTransport } from "../src/mcp/transport.ts";
import { createSessionScope } from "../src/session-scope.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(label: string): string {
  const d = mkdtempSync(join(tmpdir(), `agency-scope-mcp-${label}-`));
  dirs.push(d);
  return d;
}

function makeDeps(workspaceRoot: string): ToolDeps {
  const identity: CallerIdentity = { type: "agent", name: "test" };
  const capabilities: Capabilities = { tools: "*", pathScopes: "*", network: "*" };
  const sandbox = new SandboxBoundary(workspaceRoot);
  return { identity, capabilities, sandbox };
}

const noopHttp: HttpClient = { fetch: () => Promise.resolve(new Response()) };

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

describe("SessionScope MCP per-session isolation", () => {
  test("two scopes get isolated McpManagers with separate transports", async () => {
    const ws = tempDir("ws");
    const sd = tempDir("snap");
    const trackA = { starts: 0, closes: 0 };
    const trackB = { starts: 0, closes: 0 };

    const scopeA = await createSessionScope({
      deps: makeDeps(ws),
      http: noopHttp,
      workspaceRoot: ws,
      snapshotDir: sd,
      mcpServers: { srv: { command: "fake" } },
      mcpTransportFor: () => scriptedTransport("toolA", trackA),
    });
    const scopeB = await createSessionScope({
      deps: makeDeps(ws),
      http: noopHttp,
      workspaceRoot: ws,
      snapshotDir: sd,
      mcpServers: { srv: { command: "fake" } },
      mcpTransportFor: () => scriptedTransport("toolB", trackB),
    });

    expect(scopeA.mcp).toBeDefined();
    expect(scopeB.mcp).toBeDefined();
    expect(scopeA.mcp).not.toBe(scopeB.mcp);
    expect(trackA.starts).toBe(1);
    expect(trackB.starts).toBe(1);

    const namesA = scopeA.registry.names();
    const namesB = scopeB.registry.names();
    expect(namesA).toContain("srv_toolA");
    expect(namesA).not.toContain("srv_toolB");
    expect(namesB).toContain("srv_toolB");
    expect(namesB).not.toContain("srv_toolA");

    await scopeA.dispose();
    // B's transport untouched by A's dispose
    expect(trackA.closes).toBeGreaterThanOrEqual(1);
    expect(trackB.closes).toBe(0);
    expect(scopeB.registry.names()).toContain("srv_toolB");

    await scopeB.dispose();
    expect(trackB.closes).toBeGreaterThanOrEqual(1);
  });

  test("dispose cleans MCP transports", async () => {
    const ws = tempDir("ws");
    const sd = tempDir("snap");
    const tracker = { starts: 0, closes: 0 };
    const scope = await createSessionScope({
      deps: makeDeps(ws),
      http: noopHttp,
      workspaceRoot: ws,
      snapshotDir: sd,
      mcpServers: { srv: { command: "fake" } },
      mcpTransportFor: () => scriptedTransport("t", tracker),
    });
    expect(tracker.starts).toBe(1);
    await scope.dispose();
    expect(tracker.closes).toBeGreaterThanOrEqual(1);
  });

  test("mcpIdentityFor differs per handle", async () => {
    const ws = tempDir("ws");
    const sd = tempDir("snap");
    const tracker = { starts: 0, closes: 0 };
    const scope = await createSessionScope({
      deps: makeDeps(ws),
      http: noopHttp,
      workspaceRoot: ws,
      snapshotDir: sd,
      mcpServers: { srv: { command: "fake" } },
      mcpTransportFor: () => scriptedTransport("t", tracker),
      identityFor: (_server, handle) => ({ type: "agent", name: handle ?? "main" }),
    });
    expect(scope.mcpIdentityFor("srv", "alice")).toEqual({ type: "agent", name: "alice" });
    expect(scope.mcpIdentityFor("srv", "bob")).toEqual({ type: "agent", name: "bob" });
    expect(scope.mcpIdentityFor("srv", "alice")).not.toEqual(scope.mcpIdentityFor("srv", "bob"));
    expect(scope.mcp?.identityFor("srv", "alice")).toEqual({ type: "agent", name: "alice" });
    await scope.dispose();
  });

  test("scope without mcpServers still resolves default identity per handle", async () => {
    const ws = tempDir("ws");
    const sd = tempDir("snap");
    const scope = await createSessionScope({
      deps: makeDeps(ws),
      http: noopHttp,
      workspaceRoot: ws,
      snapshotDir: sd,
    });
    expect(scope.mcp).toBeUndefined();
    expect(scope.mcpIdentityFor("srv", "alice")).toEqual({ type: "agent", name: "alice" });
    expect(scope.mcpIdentityFor("srv")).toEqual({ type: "agent", name: "main" });
    await scope.dispose();
  });
});

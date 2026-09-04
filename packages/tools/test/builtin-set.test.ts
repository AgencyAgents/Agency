import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FULL_CAPABILITIES, SandboxBoundary } from "@agency/guard";
import type { HttpClient } from "@agency/net";
import { createBuiltinTools } from "../src/builtin-set.ts";
import { createFetchTool } from "../src/builtins/fetch.ts";
import type { McpServerConfig, McpTransport } from "../src/mcp/index.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const noopHttp: HttpClient = { fetch: async () => new Response() };

function depsFor(root: string) {
  return {
    identity: { type: "user" as const },
    capabilities: FULL_CAPABILITIES,
    sandbox: new SandboxBoundary(root),
  };
}

/** In-memory MCP transport scripted with the responses a tools/list handshake needs. */
function fakeTransport(responses: Record<string, unknown>): McpTransport {
  let handler: ((msg: Record<string, unknown>) => void) | undefined;
  return {
    async start() {},
    async send(message: Record<string, unknown>) {
      const id = message.id as number;
      if (message.method === "initialize") {
        handler?.({ jsonrpc: "2.0", id, result: {} });
      } else if (message.method === "tools/list") {
        handler?.({ jsonrpc: "2.0", id, result: responses["tools/list"] });
      } else if (message.method === "tools/call") {
        handler?.({ jsonrpc: "2.0", id, result: responses["tools/call"] });
      }
    },
    onMessage(h: (msg: Record<string, unknown>) => void) {
      handler = h;
    },
    async close() {},
  };
}

describe("createBuiltinTools", () => {
  test("without mcpServers the set is the fourteen built-ins with no failures", async () => {
    const root = mkdtempSync(join(tmpdir(), "agency-builtin-set-"));
    dirs.push(root);

    const builtins = await createBuiltinTools({
      deps: depsFor(root),
      http: noopHttp,
      workspaceRoot: root,
      snapshotDir: join(root, "snapshots"),
    });

    expect(builtins.tools.map((t: { name: string }) => t.name).sort()).toEqual([
      "bash",
      "edit",
      "execute_plan",
      "fetch",
      "glob",
      "grep",
      "process_kill",
      "process_list",
      "process_output",
      "question",
      "read",
      "todo_read",
      "todo_write",
      "write",
    ]);
    expect(builtins.mcpFailures.size).toBe(0);
    await builtins.dispose();
  });

  test("websearch registers only when an endpoint is configured", async () => {
    const root = mkdtempSync(join(tmpdir(), "agency-builtin-set-"));
    dirs.push(root);

    const configured = await createBuiltinTools({
      deps: depsFor(root),
      http: noopHttp,
      workspaceRoot: root,
      snapshotDir: join(root, "snapshots"),
      websearch: { endpoint: "https://search.example.com/api" },
    });
    expect(configured.registry.get("websearch")).toBeDefined();
    await configured.dispose();

    const unconfigured = await createBuiltinTools({
      deps: depsFor(root),
      http: noopHttp,
      workspaceRoot: root,
      snapshotDir: join(root, "snapshots"),
    });
    expect(unconfigured.registry.get("websearch")).toBeUndefined();
    await unconfigured.dispose();
  });

  test("the registry supports register/unregister/filter and per-agent subsets", async () => {
    const root = mkdtempSync(join(tmpdir(), "agency-builtin-set-"));
    dirs.push(root);

    const builtins = await createBuiltinTools({
      deps: depsFor(root),
      http: noopHttp,
      workspaceRoot: root,
      snapshotDir: join(root, "snapshots"),
    });
    try {
      expect(builtins.tools).toEqual(builtins.registry.list());

      builtins.registry.unregister("fetch");
      expect(builtins.registry.has("fetch")).toBe(false);
      expect(builtins.registry.list().map((t) => t.name)).not.toContain("fetch");
      builtins.registry.register(createFetchTool(depsFor(root), noopHttp));
      expect(builtins.registry.has("fetch")).toBe(true);

      expect(
        builtins.registry
          .filter("process_")
          .map((t) => t.name)
          .sort(),
      ).toEqual(["process_kill", "process_list", "process_output"]);

      // A5 permissions predicate: a read-only agent sees only safe tools.
      const readOnly = builtins.registry.forAgent((_name, tier) => tier === "safe");
      expect(readOnly.map((t) => t.name).sort()).toEqual([
        "glob",
        "grep",
        "process_list",
        "process_output",
        "question",
        "read",
        "todo_read",
        "todo_write",
      ]);
    } finally {
      await builtins.dispose();
    }
  });

  test("mcpServers config adds the server's tools under the capability model", async () => {
    const root = mkdtempSync(join(tmpdir(), "agency-builtin-set-"));
    dirs.push(root);

    const builtins = await createBuiltinTools({
      deps: depsFor(root),
      http: noopHttp,
      workspaceRoot: root,
      snapshotDir: join(root, "snapshots"),
      mcpServers: { weather: { command: "fake" } as McpServerConfig },
      mcpTransportFor: () =>
        fakeTransport({
          "tools/list": {
            tools: [
              {
                name: "forecast",
                description: "Get a forecast",
                inputSchema: { type: "object", properties: {} },
              },
            ],
          },
          "tools/call": { content: "sunny", isError: false },
        }),
    });

    try {
      const forecast = builtins.tools.find((t: { name: string }) => t.name === "weather_forecast");
      expect(forecast).toBeDefined();
      expect(forecast?.riskTier).toBe("moderate");

      const result = await forecast!.handler({ city: "Oslo" }, { signal: new AbortController().signal });
      expect(result.content).toBe("sunny");
      expect(builtins.mcpFailures.size).toBe(0);
    } finally {
      await builtins.dispose();
    }
  });

  test("a failing MCP server lands in mcpFailures and never aborts the built-in set", async () => {
    const root = mkdtempSync(join(tmpdir(), "agency-builtin-set-"));
    dirs.push(root);

    const builtins = await createBuiltinTools({
      deps: depsFor(root),
      http: noopHttp,
      workspaceRoot: root,
      snapshotDir: join(root, "snapshots"),
      mcpServers: {
        broken: { command: "definitely-missing-binary-xyz" } as McpServerConfig,
      },
    });

    try {
      expect(builtins.mcpFailures.get("broken")).toBeDefined();
      expect(builtins.tools.map((t: { name: string }) => t.name)).toContain("read");
    } finally {
      await builtins.dispose();
    }
  });

  test("invalid mcpServers config throws a legible error", async () => {
    const root = mkdtempSync(join(tmpdir(), "agency-builtin-set-"));
    dirs.push(root);

    await expect(
      createBuiltinTools({
        deps: depsFor(root),
        http: noopHttp,
        workspaceRoot: root,
        snapshotDir: join(root, "snapshots"),
        mcpServers: { bad: 42 },
      }),
    ).rejects.toThrow(/invalid mcpServers config/);
  });
});

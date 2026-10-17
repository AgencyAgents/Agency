import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FULL_CAPABILITIES, OsSandboxBackend, SandboxBoundary } from "@agency/guard";
import { createBashTool } from "../src/builtins/bash.ts";
import { ProcessManager } from "../src/process-manager.ts";
import { resolveShell } from "../src/shell.ts";

const ws = mkdtempSync(join(tmpdir(), "agency-bash-net-"));
const site = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("site body") });
afterAll(() => {
  site.stop(true);
  rmSync(ws, { recursive: true, force: true });
});

const sandbox = new OsSandboxBackend(ws);
const runs =
  (process.platform === "linux" || process.platform === "darwin") &&
  Bun.which("curl") !== null &&
  (await sandbox.isAvailable());

function bash(backend: ConstructorParameters<typeof SandboxBoundary>[0] | OsSandboxBackend) {
  return createBashTool(
    {
      identity: { type: "user" },
      capabilities: FULL_CAPABILITIES,
      sandbox: typeof backend === "string" ? new SandboxBoundary(backend) : backend,
    },
    resolveShell(process.platform),
    { cwd: ws },
    new ProcessManager(),
  );
}

test("only a sandbox with no network offers the network to a command", () => {
  const properties = (tool: ReturnType<typeof bash>) =>
    Object.keys((tool.inputSchema as { properties: Record<string, unknown> }).properties);
  expect(properties(bash(new OsSandboxBackend(ws)))).toContain("network");
  expect(properties(bash(new OsSandboxBackend(ws, {}, undefined, { allowNetwork: true })))).not.toContain(
    "network",
  );
  expect(properties(bash(ws))).not.toContain("network");
});

test.skipIf(!runs)("a command gets the network only when the user allows it, each time", async () => {
  const tool = bash(sandbox);
  const signal = new AbortController().signal;
  const command = `curl -s --max-time 5 http://127.0.0.1:${site.port}/`;
  const asked: string[] = [];
  const answer = (response: "once" | "reject") => async (request: { source?: string }) => {
    asked.push(String(request.source));
    return response;
  };
  const without = await tool.handler({ command }, { signal, requestApproval: answer("once") });
  expect(without.content).not.toContain("site body");
  expect(asked).toEqual([]);
  const refused = await tool.handler(
    { command, network: true },
    { signal, requestApproval: answer("reject") },
  );
  expect(refused.isError).toBe(true);
  expect(refused.content).not.toContain("site body");
  const allowed = await tool.handler({ command, network: true }, { signal, requestApproval: answer("once") });
  expect(allowed.content).toContain("site body");
  expect(asked).toEqual(["sandbox:network", "sandbox:network"]);
  // No one to ask: refused.
  expect((await tool.handler({ command, network: true }, { signal })).isError).toBe(true);
});

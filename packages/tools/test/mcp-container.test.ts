import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SandboxBackend } from "@agency/guard";
import {
  DockerSandboxBackend,
  FULL_CAPABILITIES,
  hasLocalImage,
  isDockerAvailable,
  SandboxBoundary,
  translateHostToMount,
  translateMountToHost,
} from "@agency/guard";
import type { HttpClient } from "@agency/net";
import { AgencyError, ErrorCode } from "@agency/schema";
import { asContainerStdioBackend, type ContainerStdioOptions } from "../src/container-exec.ts";
import type { ToolDeps } from "../src/contract.ts";
import { McpClient } from "../src/mcp/client.ts";
import { startMcpServers } from "../src/mcp/manager.ts";
import { TEAM_MCP_PROCESS_CAP, TeamMcpPool } from "../src/mcp/team-policy.ts";
import { createContainerStdioTransport, transportForWithContainerSandbox } from "../src/mcp/transport.ts";
import { createSessionScope } from "../src/session-scope.ts";

// MCP servers in containers (wave1-todo5). A fake stdio backend stands in for
// the Docker daemon: it runs the server argv locally like the software path
// but records routing (argv, host cwd, env) and proves mount translation
// through the real helpers, so routing and kill wiring are unit-tested
// daemon-free. The fake server below speaks JSONL MCP over stdio.
const SERVER_SCRIPT = [
  `const readline = require('node:readline');`,
  `const fs = require('node:fs');`,
  `const rl = readline.createInterface({ input: process.stdin, terminal: false });`,
  `const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');`,
  `rl.on('line', (raw) => {`,
  `  const line = raw.trim();`,
  `  if (!line) return;`,
  `  let msg; try { msg = JSON.parse(line); } catch { return; }`,
  `  if (msg.id === undefined) return;`,
  `  if (msg.method === 'initialize') reply(msg.id, {});`,
  `  else if (msg.method === 'tools/list') {`,
  `    reply(msg.id, { tools: [{ name: 'echo', description: 'echo tool', inputSchema: { type: 'object', properties: {} } }] });`,
  `    const counterFile = process.env['MCP_COUNTER_FILE'];`,
  `    if (counterFile) {`,
  `      try {`,
  `        const n = parseInt(fs.readFileSync(counterFile, 'utf8') || '0', 10);`,
  `        fs.writeFileSync(counterFile, String(n + 1));`,
  `        if (n === 0) setTimeout(() => process.exit(1), 100);`,
  `      } catch {}`,
  `    }`,
  `    if (process.env['MCP_NOTIFY'] === '1') {`,
  `      setTimeout(() => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }) + '\\n'), 200);`,
  `    }`,
  `  }`,
  `  else if (msg.method === 'tools/call') reply(msg.id, { content: 'echo:' + JSON.stringify(msg.params?.arguments ?? null) });`,
  `  else reply(msg.id, {});`,
  `});`,
].join("\n");

function serverConfig(env?: Record<string, string>) {
  return {
    command: process.execPath,
    args: ["-e", SERVER_SCRIPT],
    ...(env ? { env } : {}),
  };
}

class FakeStdioBackend extends SandboxBoundary {
  readonly containerRoot = "/workspace";
  readonly spawnCalls: { argv: string[]; cwd?: string; env?: Record<string, string> }[] = [];
  readonly kills: string[] = [];
  private readonly children: { kill: () => void }[] = [];
  private readonly hostRoot: string;

  constructor(root: string, commandPolicy?: ConstructorParameters<typeof SandboxBoundary>[1]) {
    super(root, commandPolicy);
    this.hostRoot = resolve(root);
  }

  toContainerPath(candidate: string): string {
    return translateHostToMount(this.resolvePath(candidate), this.hostRoot, this.containerRoot);
  }

  toHostPath(containerPath: string): string {
    return translateMountToHost(containerPath, this.hostRoot, this.containerRoot);
  }

  async spawnStdio(argv: string[], opts: ContainerStdioOptions = {}) {
    this.checkCommand(argv.join(" "));
    const cwd = opts.cwd ? this.resolvePath(opts.cwd) : this.hostRoot;
    this.spawnCalls.push({ argv, cwd: opts.cwd, env: opts.env });
    translateHostToMount(cwd, this.hostRoot, this.containerRoot);
    const child = Bun.spawn(argv, {
      cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...(opts.env ?? {}) } as Record<string, string>,
    });
    this.children.push(child);
    return {
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      exited: child.exited,
      pid: child.pid,
      kill: () => {
        this.kills.push(argv[0] ?? "");
        try {
          child.kill(9);
        } catch {
          // Already exited; the exited promise still settles.
        }
      },
    };
  }

  killAll(): void {
    for (const child of this.children.splice(0)) {
      try {
        child.kill();
      } catch {
        // Already exited.
      }
    }
  }
}

class ExecOnlyBackend extends SandboxBoundary {
  async exec() {
    return { stdout: "", stderr: "", exitCode: 0 };
  }
}

const dirs: string[] = [];
const fakes: FakeStdioBackend[] = [];
afterEach(async () => {
  for (const f of fakes.splice(0)) f.killAll();
  await new Promise((r) => setTimeout(r, 100));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

function tempRoot(label: string): string {
  const d = mkdtempSync(join(tmpdir(), `agency-mcp-container-${label}-`));
  dirs.push(d);
  return d;
}

function fakeBackend(root: string): FakeStdioBackend {
  const backend = new FakeStdioBackend(root);
  fakes.push(backend);
  return backend;
}

function makeDeps(sandbox: SandboxBackend, root: string): ToolDeps {
  return {
    identity: { type: "agent", name: "test" },
    capabilities: { ...FULL_CAPABILITIES, pathScopes: [root] },
    sandbox,
  };
}

const noopHttp: HttpClient = { fetch: () => Promise.resolve(new Response()) };

async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("container transport selection", () => {
  test("software sandbox yields undefined, keeping the manager default path", () => {
    const root = tempRoot("select");
    expect(transportForWithContainerSandbox(new SandboxBoundary(root))).toBeUndefined();
    const impostor = new FakeStdioBackend(root) as unknown as Record<string, unknown>;
    impostor.spawnStdio = 42;
    expect(asContainerStdioBackend(impostor as unknown as SandboxBackend)).toBeUndefined();
  });

  test("stdio backend routes commands to the container, urls stay on HTTP", async () => {
    const root = tempRoot("route");
    const backend = fakeBackend(root);
    const transportFor = transportForWithContainerSandbox(backend, { cwd: root });
    expect(transportFor).toBeDefined();
    const stdio = transportFor!("srv", serverConfig());
    await stdio.start();
    expect(backend.spawnCalls.length).toBe(1);
    expect(backend.spawnCalls[0]?.argv).toEqual([process.execPath, "-e", SERVER_SCRIPT]);
    expect(backend.spawnCalls[0]?.cwd).toBe(root);
    await stdio.close();
    const http = transportFor!("srv", { url: "https://example.com/mcp" });
    expect(http.stderrTail?.()).toBe("");
    await http.close();
    expect(backend.spawnCalls.length).toBe(1);
  });

  test("exec-only container backend fails closed with a typed error when selected", async () => {
    const root = tempRoot("execonly");
    const transportFor = transportForWithContainerSandbox(new ExecOnlyBackend(root));
    expect(transportFor).toBeDefined();
    const http = transportFor!("srv", { url: "https://example.com/mcp" });
    await http.close();
    let error: unknown;
    try {
      transportFor!("srv", serverConfig());
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AgencyError);
    expect((error as AgencyError).code).toBe(ErrorCode.INTERNAL);
  });

  test("server env rides into the spawn, adopt tracks the child", async () => {
    const root = tempRoot("env");
    const backend = fakeBackend(root);
    const adopted: { pid?: number; command: string }[] = [];
    const transport = createContainerStdioTransport(backend, serverConfig({ FOO: "bar" }), {
      cwd: root,
      adopt: (proc, command) => adopted.push({ pid: proc.pid, command }),
    });
    await transport.start();
    expect(backend.spawnCalls[0]?.env).toEqual({ FOO: "bar" });
    expect(adopted.length).toBe(1);
    expect(adopted[0]?.command).toBe(process.execPath);
    await transport.close();
    expect(backend.kills.length).toBe(1);
  });

  test("send before start rejects, missing command throws", async () => {
    const root = tempRoot("malformed");
    const backend = fakeBackend(root);
    const transport = createContainerStdioTransport(backend, serverConfig(), { cwd: root });
    await expect(transport.send({ jsonrpc: "2.0", id: 1, method: "ping", params: {} })).rejects.toThrow(
      /not started/,
    );
    expect(() => createContainerStdioTransport(backend, { url: undefined } as never)).toThrow(
      /needs command or url/,
    );
    expect(backend.spawnCalls.length).toBe(0);
  });

  test("spawn denial and escaped cwd fail closed with typed errors", async () => {
    const root = tempRoot("deny");
    const denied = fakeBackend(root);
    const deniedPolicy = new FakeStdioBackend(root, { deny: [/definitely-blocked/] });
    fakes.push(deniedPolicy);
    const blocked = createContainerStdioTransport(deniedPolicy, { command: "definitely-blocked-server" });
    await expect(blocked.start()).rejects.toBeInstanceOf(AgencyError);
    const escaped = createContainerStdioTransport(denied, serverConfig(), {
      cwd: join(root, "..", "outside"),
    });
    const err = await escaped.start().catch((e) => e);
    expect(err).toBeInstanceOf(AgencyError);
    expect((err as AgencyError).code).toBe(ErrorCode.PERMISSION_DENIED);
    expect(denied.spawnCalls.length).toBe(0);
  });
});

describe("container MCP round trip", () => {
  test("listTools and callTool cross the boundary", async () => {
    const root = tempRoot("roundtrip");
    const backend = fakeBackend(root);
    const transport = createContainerStdioTransport(backend, serverConfig(), { cwd: root });
    const client = new McpClient("srv", transport);
    await transport.start();
    await client.initialize();
    const defs = await client.listTools();
    expect(defs.map((d) => d.name)).toEqual(["echo"]);
    const result = await client.callTool("echo", { hello: "container" });
    expect(String(result.content)).toContain("container");
    await transport.close();
    expect(backend.kills.length).toBe(1);
  }, 30_000);

  test("server notifications arrive over piped stdout", async () => {
    const root = tempRoot("notify");
    const backend = fakeBackend(root);
    const received: Record<string, unknown>[] = [];
    const transport = createContainerStdioTransport(backend, serverConfig({ MCP_NOTIFY: "1" }), {
      cwd: root,
    });
    transport.onMessage((msg) => received.push(msg));
    await transport.start();
    await transport.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    await waitFor(
      () => received.some((m) => m.method === "notifications/tools/list_changed"),
      10_000,
      "list_changed",
    );
    await transport.close();
  }, 30_000);

  test("manager registers tools, crash restarts with backoff, list settles healthy", async () => {
    const root = tempRoot("restart");
    const backend = fakeBackend(root);
    const counterFile = join(root, "crash-counter.txt");
    writeFileSync(counterFile, "0");
    const mgr = await startMcpServers({
      servers: { srv: serverConfig({ MCP_COUNTER_FILE: counterFile }) },
      capabilities: { ...FULL_CAPABILITIES, pathScopes: [root] },
      transportFor: transportForWithContainerSandbox(backend, { cwd: root })!,
      baseBackoffMs: 50,
    });
    try {
      expect(mgr.tools.map((t) => t.name)).toContain("srv_echo");
      await waitFor(() => backend.spawnCalls.length >= 2, 15_000, "container restart");
      await waitFor(
        () => mgr.tools.some((t) => t.name === "srv_echo") && mgr.failures.size === 0,
        15_000,
        "healthy tools",
      );
    } finally {
      await mgr.dispose();
    }
    expect(backend.kills.length).toBeGreaterThanOrEqual(1);
  }, 30_000);

  test("team pool cap holds across the container boundary", async () => {
    const root = tempRoot("pool");
    const backend = fakeBackend(root);
    const servers: Record<string, ReturnType<typeof serverConfig>> = {};
    for (let i = 0; i < 10; i++) servers[`srv${i}`] = { ...serverConfig(), readOnly: true };
    const pool = new TeamMcpPool("team1", servers, {
      capabilities: { ...FULL_CAPABILITIES, pathScopes: [root] },
      transportFor: transportForWithContainerSandbox(backend, { cwd: root }),
    });
    try {
      await pool.start();
      expect(pool.usage()).toEqual({ sharedServers: 8, sharedProcesses: 8, cap: TEAM_MCP_PROCESS_CAP });
      expect(backend.spawnCalls.length).toBe(8);
      expect(pool.sharedTools().length).toBe(8);
      expect(pool.failures().size).toBe(0);
    } finally {
      await pool.dispose();
    }
    expect(backend.kills.length).toBeGreaterThanOrEqual(8);
  }, 60_000);
});

describe("session-scope container wiring", () => {
  test("container sandbox routes MCP without an explicit transportFor", async () => {
    const ws = tempRoot("scope");
    const sd = tempRoot("snap");
    const backend = fakeBackend(ws);
    const scope = await createSessionScope({
      deps: makeDeps(backend, ws),
      http: noopHttp,
      workspaceRoot: ws,
      snapshotDir: sd,
      mcpServers: { srv: serverConfig() },
    });
    try {
      expect(backend.spawnCalls.length).toBe(1);
      expect(backend.spawnCalls[0]?.cwd).toBe(ws);
      expect(scope.registry.names()).toContain("srv_echo");
    } finally {
      await scope.dispose();
    }
    expect(backend.kills.length).toBeGreaterThanOrEqual(1);
  }, 30_000);

  test("explicit transportFor still wins over the container wiring", async () => {
    const ws = tempRoot("override");
    const sd = tempRoot("snap");
    const backend = fakeBackend(ws);
    let explicitStarts = 0;
    const scope = await createSessionScope({
      deps: makeDeps(backend, ws),
      http: noopHttp,
      workspaceRoot: ws,
      snapshotDir: sd,
      mcpServers: { srv: serverConfig() },
      mcpTransportFor: () => ({
        async start() {
          explicitStarts++;
        },
        async send(message: Record<string, unknown>) {
          void message;
          throw new Error("explicit transport never serves");
        },
        onMessage() {},
        async close() {},
      }),
    });
    try {
      expect(explicitStarts).toBe(1);
      expect(backend.spawnCalls.length).toBe(0);
      expect(scope.mcp?.failures.size).toBe(1);
    } finally {
      await scope.dispose();
    }
  }, 30_000);

  test("software sandbox keeps the default spawn path through the new wiring", async () => {
    const ws = tempRoot("software");
    const sd = tempRoot("snap");
    const scope = await createSessionScope({
      deps: makeDeps(new SandboxBoundary(ws), ws),
      http: noopHttp,
      workspaceRoot: ws,
      snapshotDir: sd,
      mcpServers: { srv: serverConfig() },
    });
    try {
      expect(scope.registry.names()).toContain("srv_echo");
      expect(scope.mcp?.failures.size).toBe(0);
    } finally {
      await scope.dispose();
    }
  }, 30_000);
});

const DOCKER_IMAGE = process.env.AGENCY_DOCKER_MCP_TEST_IMAGE ?? "node:22-alpine";
const haveDocker = await isDockerAvailable(undefined, 5_000);
const haveImage = haveDocker && hasLocalImage(DOCKER_IMAGE);
const itContainer = haveDocker && haveImage ? test : test.skip;

describe("mcp-container docker integration (gated)", () => {
  itContainer(
    `real DockerSandboxBackend.spawnStdio round-trips listTools [skip unless daemon+${DOCKER_IMAGE} reachable]`,
    async () => {
      const dir = tempRoot("docker");
      const root = join(dir, "ws");
      const backend = new DockerSandboxBackend(root, {}, undefined, { image: DOCKER_IMAGE });
      const transport = createContainerStdioTransport(
        backend,
        { command: "node", args: ["-e", SERVER_SCRIPT] },
        { cwd: root },
      );
      const client = new McpClient("srv", transport);
      try {
        await transport.start();
        await client.initialize();
        const defs = await client.listTools();
        expect(defs.map((d) => d.name)).toEqual(["echo"]);
      } finally {
        await transport.close();
      }
    },
    120_000,
  );
});

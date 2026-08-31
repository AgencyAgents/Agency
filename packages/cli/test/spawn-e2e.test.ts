import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDaemon, hashWorkspaceRoot, PROTOCOL_VERSION, type DaemonClient } from "@agency/rpc";

const DAEMON_ENTRY = join(import.meta.dir, "..", "src", "daemon-entry.ts");

const clients: DaemonClient[] = [];
const dirs: string[] = [];
const spawned: ReturnType<typeof Bun.spawn>[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const proc of spawned.splice(0)) proc.kill();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agency-spawn-e2e-"));
  dirs.push(dir);
  return dir;
}

function spawnDaemonEntry(workspaceRoot: string, instanceFile: string) {
  const proc = Bun.spawn(
    ["bun", "run", DAEMON_ENTRY, "--workspace", workspaceRoot, "--instance-file", instanceFile, "--idle-linger-ms", "60000"],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  spawned.push(proc);
}

// Real child-process spawns via Bun.spawn; slower than the in-process
// daemon tests, generous per-test timeouts to absorb cold-start variance.
describe("daemon-entry.ts as a real spawned process", () => {
  test("a fresh workspace root spawns a real daemon process that responds over RPC", async () => {
    const instanceDir = tempDir();
    const { client } = await ensureDaemon({
      workspaceRoot: "/repo/spawn-e2e-a",
      instanceDir,
      spawnDaemon: (file) => spawnDaemonEntry("/repo/spawn-e2e-a", file),
      spawnTimeoutMs: 15_000,
    });
    clients.push(client);

    // No API key needed — cancel_turn on a nonexistent turn just proves the
    // real spawned process is alive and speaking the RPC protocol correctly.
    expect(await client.call("cancel_turn", { turnId: "nope" })).toEqual({ cancelled: false });
  }, 20_000);

  test("two different workspace roots run as two independent real daemon processes", async () => {
    const instanceDir = tempDir();
    const [a, b] = await Promise.all([
      ensureDaemon({
        workspaceRoot: "/repo/spawn-e2e-b1",
        instanceDir,
        spawnDaemon: (file) => spawnDaemonEntry("/repo/spawn-e2e-b1", file),
        spawnTimeoutMs: 15_000,
      }),
      ensureDaemon({
        workspaceRoot: "/repo/spawn-e2e-b2",
        instanceDir,
        spawnDaemon: (file) => spawnDaemonEntry("/repo/spawn-e2e-b2", file),
        spawnTimeoutMs: 15_000,
      }),
    ]);
    clients.push(a.client, b.client);

    expect(a.port).not.toBe(b.port);
    expect(await a.client.call("cancel_turn", { turnId: "x" })).toEqual({ cancelled: false });
    expect(await b.client.call("cancel_turn", { turnId: "x" })).toEqual({ cancelled: false });
  }, 25_000);

  test("reconnecting to the same workspace root reuses the running process, no second spawn", async () => {
    const instanceDir = tempDir();
    const first = await ensureDaemon({
      workspaceRoot: "/repo/spawn-e2e-c",
      instanceDir,
      spawnDaemon: (file) => spawnDaemonEntry("/repo/spawn-e2e-c", file),
      spawnTimeoutMs: 15_000,
    });
    clients.push(first.client);

    let spawnCalledAgain = false;
    const second = await ensureDaemon({
      workspaceRoot: "/repo/spawn-e2e-c",
      instanceDir,
      spawnDaemon: () => {
        spawnCalledAgain = true;
      },
    });
    clients.push(second.client);

    expect(spawnCalledAgain).toBe(false);
    expect(second.port).toBe(first.port);
  }, 20_000);

  test("a stale instance file (dead process) is detected and a fresh daemon replaces it", async () => {
    const instanceDir = tempDir();
    const instanceFile = join(instanceDir, `${hashWorkspaceRoot("/repo/spawn-e2e-d")}.json`);
    // Points at a port nothing is listening on — simulates a daemon that
    // crashed without cleaning up its instance file.
    writeFileSync(
      instanceFile,
      JSON.stringify({ port: 1, pid: 999999, startedAt: new Date().toISOString(), version: PROTOCOL_VERSION }),
    );

    let spawnCalled = false;
    const { client } = await ensureDaemon({
      workspaceRoot: "/repo/spawn-e2e-d",
      instanceDir,
      spawnDaemon: (file) => {
        spawnCalled = true;
        spawnDaemonEntry("/repo/spawn-e2e-d", file);
      },
      spawnTimeoutMs: 15_000,
    });
    clients.push(client);

    expect(spawnCalled).toBe(true);
    expect(await client.call("cancel_turn", { turnId: "x" })).toEqual({ cancelled: false });
  }, 20_000);
});

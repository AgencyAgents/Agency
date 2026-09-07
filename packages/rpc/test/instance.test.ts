import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DaemonClient } from "../src/client.ts";
import { ensureDaemon, hashWorkspaceRoot, writeInstanceFile } from "../src/instance.ts";
import { PROTOCOL_VERSION } from "../src/protocol.ts";
import { type DaemonServer, startDaemonServer } from "../src/server.ts";

const servers: DaemonServer[] = [];
const clients: DaemonClient[] = [];
const dirs: string[] = [];
// Spawn completions, drained in afterEach before closing servers: the
// fake daemon resolves asynchronously, so awaiting these guarantees no
// server lands in `servers` after the splice and leaks a live listener.
const pendingSpawns: Promise<DaemonServer>[] = [];

afterEach(async () => {
  // Servers before clients (same Windows TCP teardown race as
  // server-client.test.ts): destroy while client sockets are fully open.
  await Promise.all(pendingSpawns.splice(0));
  for (const server of servers.splice(0)) await server.close();
  for (const client of clients.splice(0)) await client.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agency-instance-test-"));
  dirs.push(dir);
  return dir;
}

/** Stands in for "spawn a real OS process": starts an in-process daemon and
 *  writes its own instance file, exactly as a real spawned daemon would. */
function fakeSpawnDaemon(instanceFile: string) {
  pendingSpawns.push(
    startDaemonServer({ handlers: { ping: async () => "pong" } }).then((server) => {
      servers.push(server);
      writeInstanceFile(instanceFile, {
        port: server.port,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        version: PROTOCOL_VERSION,
      });
      return server;
    }),
  );
}

describe("hashWorkspaceRoot", () => {
  test("is stable for the same path", () => {
    expect(hashWorkspaceRoot("/repo/project")).toBe(hashWorkspaceRoot("/repo/project"));
  });

  test("differs for different paths", () => {
    expect(hashWorkspaceRoot("/repo/a")).not.toBe(hashWorkspaceRoot("/repo/b"));
  });
});

describe("ensureDaemon", () => {
  test("spawns a fresh daemon when no instance file exists", async () => {
    const { client } = await ensureDaemon({
      workspaceRoot: "/repo/project-a",
      instanceDir: tempDir(),
      spawnDaemon: fakeSpawnDaemon,
    });
    clients.push(client);
    expect(await client.call("ping", {})).toBe("pong");
  });

  test("reuses an existing daemon whose instance file points to a live server", async () => {
    const instanceDir = tempDir();
    const server = await startDaemonServer({ handlers: { ping: async () => "already-running" } });
    servers.push(server);
    writeInstanceFile(join(instanceDir, `${hashWorkspaceRoot("/repo/project-b")}.json`), {
      port: server.port,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      version: PROTOCOL_VERSION,
    });

    let spawnCalled = false;
    const { client } = await ensureDaemon({
      workspaceRoot: "/repo/project-b",
      instanceDir,
      spawnDaemon: () => {
        spawnCalled = true;
      },
    });
    clients.push(client);

    expect(spawnCalled).toBe(false);
    expect(await client.call("ping", {})).toBe("already-running");
  });

  test("detects a stale instance file (dead daemon) and spawns a replacement", async () => {
    const instanceDir = tempDir();
    const staleFile = join(instanceDir, `${hashWorkspaceRoot("/repo/project-c")}.json`);
    writeFileSync(
      staleFile,
      JSON.stringify({
        port: 1,
        pid: 999999,
        startedAt: new Date().toISOString(),
        version: PROTOCOL_VERSION,
      }),
    );

    let spawnCalled = false;
    const { client } = await ensureDaemon({
      workspaceRoot: "/repo/project-c",
      instanceDir,
      spawnDaemon: (file) => {
        spawnCalled = true;
        fakeSpawnDaemon(file);
      },
    });
    clients.push(client);

    expect(spawnCalled).toBe(true);
    expect(await client.call("ping", {})).toBe("pong");
  });

  test("two different workspace roots get two independent daemons", async () => {
    const instanceDir = tempDir();
    const a = await ensureDaemon({ workspaceRoot: "/repo/one", instanceDir, spawnDaemon: fakeSpawnDaemon });
    const b = await ensureDaemon({ workspaceRoot: "/repo/two", instanceDir, spawnDaemon: fakeSpawnDaemon });
    clients.push(a.client, b.client);

    expect(a.port).not.toBe(b.port);
    expect(await a.client.call("ping", {})).toBe("pong");
    expect(await b.client.call("ping", {})).toBe("pong");
  });

  test("throws if the daemon never becomes ready within the timeout", async () => {
    await expect(
      ensureDaemon({
        workspaceRoot: "/repo/never-ready",
        instanceDir: tempDir(),
        spawnDaemon: () => {}, // never writes the instance file
        spawnTimeoutMs: 150,
        pollIntervalMs: 20,
      }),
    ).rejects.toThrow(/did not become ready/);
  });
});

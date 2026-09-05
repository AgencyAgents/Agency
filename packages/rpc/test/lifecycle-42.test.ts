import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SPAWN_TIMEOUT_MS,
  ensureDaemon,
  hashWorkspaceRoot,
  INSTANCE_FILE_MODE,
  newInstanceToken,
  SPAWN_LOCK_STALE_MS,
  writeInstanceFile,
} from "../src/instance.ts";
import { PROTOCOL_VERSION } from "../src/protocol.ts";
import { type DaemonServer, startDaemonServer } from "../src/server.ts";

const servers: DaemonServer[] = [];
const dirs: string[] = [];
// Spawn completions, drained in afterEach before closing servers: the
// fake daemon resolves asynchronously, so awaiting these guarantees no
// server lands in `servers` after the splice and leaks a live listener.
const pendingSpawns: Promise<DaemonServer>[] = [];

afterEach(async () => {
  await Promise.all(pendingSpawns.splice(0));
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agency-lifecycle42-"));
  dirs.push(dir);
  return dir;
}

function fakeSpawnDaemon(instanceFile: string) {
  pendingSpawns.push(
    startDaemonServer({ handlers: { ping: async () => "pong" } }).then((server) => {
      servers.push(server);
      writeInstanceFile(instanceFile, {
        port: server.port,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        version: PROTOCOL_VERSION,
        token: newInstanceToken(),
      });
      return server;
    }),
  );
}

describe("daemon lifecycle constants (item 42)", () => {
  test("spawn lock stale detection is 10s and default deadline is 5s", () => {
    expect(SPAWN_LOCK_STALE_MS).toBe(10_000);
    expect(DEFAULT_SPAWN_TIMEOUT_MS).toBe(5_000);
  });

  test("instance file mode is user-only 0600", () => {
    expect(INSTANCE_FILE_MODE).toBe(0o600);
  });
});

describe("authToken 256-bit (item 42)", () => {
  test("newInstanceToken carries 256 bits of entropy as 64 hex chars", () => {
    const token = newInstanceToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  test("tokens are unique per call", () => {
    const seen = new Set(Array.from({ length: 20 }, () => newInstanceToken()));
    expect(seen.size).toBe(20);
  });
});

describe("instance file atomic temp+rename chmod 0600 (item 42)", () => {
  test("writes valid JSON with no temp leftovers", () => {
    const dir = tempDir();
    const path = join(dir, "inst.json");
    writeInstanceFile(path, {
      port: 1234,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      version: PROTOCOL_VERSION,
      token: newInstanceToken(),
    });
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { port: number };
    expect(parsed.port).toBe(1234);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("file is user-only where the OS supports modes", () => {
    if (process.platform === "win32") return;
    const dir = tempDir();
    const path = join(dir, "inst.json");
    writeInstanceFile(path, {
      port: 1,
      pid: 1,
      startedAt: new Date().toISOString(),
      version: PROTOCOL_VERSION,
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("overwrite replaces atomically without temp leftovers", () => {
    const dir = tempDir();
    const path = join(dir, "inst.json");
    writeInstanceFile(path, { port: 1, pid: 1, startedAt: "a", version: PROTOCOL_VERSION });
    writeInstanceFile(path, { port: 2, pid: 1, startedAt: "b", version: PROTOCOL_VERSION });
    expect((JSON.parse(readFileSync(path, "utf8")) as { port: number }).port).toBe(2);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("O_EXCL spawn lock with stale detection (item 42)", () => {
  test("a stale lock held by a dead pid is stolen and the daemon spawns", async () => {
    const instanceDir = tempDir();
    const ws = join(tempDir(), "ws-stale-lock");
    const lockFile = join(instanceDir, `${hashWorkspaceRoot(ws)}.json.lock`);
    writeFileSync(lockFile, JSON.stringify({ pid: 999999999, acquiredAt: new Date(0).toISOString() }));
    utimesSync(lockFile, new Date(0), new Date(Date.now() - SPAWN_LOCK_STALE_MS - 1_000));

    let spawned = false;
    const { client } = await ensureDaemon({
      workspaceRoot: ws,
      instanceDir,
      spawnDaemon: (file) => {
        spawned = true;
        fakeSpawnDaemon(file);
      },
    });
    expect(spawned).toBe(true);
    expect(await client.call("ping", {})).toBe("pong");
    await client.close();
  });

  test("a pathological lock older than staleMs is stolen even with an unparseable holder", async () => {
    const instanceDir = tempDir();
    const ws = join(tempDir(), "ws-old-lock");
    const lockFile = join(instanceDir, `${hashWorkspaceRoot(ws)}.json.lock`);
    writeFileSync(lockFile, "not-json");
    utimesSync(lockFile, new Date(0), new Date(Date.now() - SPAWN_LOCK_STALE_MS - 1_000));

    let spawned = false;
    const { client } = await ensureDaemon({
      workspaceRoot: ws,
      instanceDir,
      spawnDaemon: (file) => {
        spawned = true;
        fakeSpawnDaemon(file);
      },
    });
    expect(spawned).toBe(true);
    await client.close();
  });

  test("5s default deadline: a daemon that never appears rejects", async () => {
    const start = Date.now();
    await expect(
      ensureDaemon({
        workspaceRoot: join(tempDir(), "ws-never"),
        instanceDir: tempDir(),
        spawnDaemon: () => {},
        spawnTimeoutMs: 150,
        pollIntervalMs: 20,
      }),
    ).rejects.toThrow(/did not become ready/);
    expect(Date.now() - start).toBeLessThan(DEFAULT_SPAWN_TIMEOUT_MS);
  });
});

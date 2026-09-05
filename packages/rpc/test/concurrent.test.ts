import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectToDaemon, type DaemonClient } from "../src/client.ts";
import { ensureDaemon } from "../src/instance.ts";
import { type DaemonServer, startDaemonServer } from "../src/server.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(p: string): string {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
}

describe("concurrent RPC", () => {
  test("concurrent run_turn RPC: two clients can run turns concurrently", async () => {
    const server = await startDaemonServer({
      token: "test-token",
      handlers: {
        async run_turn(params) {
          const { turnId } = params as { turnId: string };
          await new Promise((r) => setTimeout(r, 50));
          return {
            messages: [],
            stopReason: "end_turn",
            usage: { inputTokens: 1, outputTokens: 1 },
            budgetExceeded: false,
            cancelled: false,
            echo: turnId,
          };
        },
      },
    });
    const c1 = await connectToDaemon(server.port, "127.0.0.1", { token: "test-token" });
    const c2 = await connectToDaemon(server.port, "127.0.0.1", { token: "test-token" });
    try {
      const [r1, r2] = await Promise.all([
        c1.call("run_turn", { turnId: "t1" }),
        c2.call("run_turn", { turnId: "t2" }),
      ]);
      expect((r1 as { echo: string }).echo).toBe("t1");
      expect((r2 as { echo: string }).echo).toBe("t2");
    } finally {
      await c1.close();
      await c2.close();
      await server.close();
    }
  }, 10000);

  test("concurrent ensureDaemon yields exactly one daemon", async () => {
    const instanceDir = tmp("agency-concur-inst-");
    const ws = tmp("agency-concur-ws-");
    let spawnCount = 0;
    // Tracked so the test closes the daemon deterministically instead of
    // leaving it listening on a timer: a stray server + its sockets keep
    // the bun process alive after the summary on Windows CI.
    const spawned: DaemonServer[] = [];
    const spawnSettled: Promise<void>[] = [];
    const spawn = (file: string) => {
      spawnCount += 1;
      // Simulate daemon start: write instance file with a random port server
      // We'll use startDaemonServer directly and write file via helper.
      spawnSettled.push(
        (async () => {
          const s = await startDaemonServer({
            token: "tok",
            handlers: {
              async ping() {
                return { ok: true };
              },
            },
          });
          spawned.push(s);
          const { writeInstanceFile } = await import("../src/instance.ts");
          writeInstanceFile(file, {
            port: s.port,
            pid: process.pid,
            startedAt: new Date().toISOString(),
            version: (await import("../src/protocol.ts")).PROTOCOL_VERSION,
            token: "tok",
          });
        })(),
      );
    };

    const pendingClients: DaemonClient[] = [];
    try {
      const results = await Promise.all([
        ensureDaemon({ workspaceRoot: ws, instanceDir, spawnDaemon: spawn }),
        ensureDaemon({ workspaceRoot: ws, instanceDir, spawnDaemon: spawn }),
        ensureDaemon({ workspaceRoot: ws, instanceDir, spawnDaemon: spawn }),
      ]);
      for (const r of results) pendingClients.push(r.client);
      const ports = results.map((r) => r.port);
      expect(new Set(ports).size).toBe(1);
      expect(spawnCount).toBeGreaterThanOrEqual(1);
      expect(spawnCount).toBeLessThanOrEqual(3);
    } finally {
      await Promise.all(spawnSettled);
      // Servers before clients: destroy while client sockets are fully
      // open (same Windows TCP teardown race as server-client.test.ts).
      for (const s of spawned.splice(0)) await s.close();
      for (const c of pendingClients.splice(0)) await c.close();
    }
  }, 15000);
});

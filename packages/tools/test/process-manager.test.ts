import { afterEach, describe, expect, test } from "bun:test";
import { ProcessManager } from "../src/process-manager.ts";

let manager: ProcessManager | undefined;
afterEach(() => {
  manager?.killAll();
  manager = undefined;
});

describe("ProcessManager", () => {
  test("spawns a process and reports it as running", () => {
    manager = new ProcessManager();
    const info = manager.spawn(["node", "-e", "setInterval(() => {}, 1000)"]);
    expect(info.running).toBe(true);
    expect(info.pid).toBeGreaterThan(0);
  });

  test("captures stdout into the log buffer", async () => {
    manager = new ProcessManager();
    const info = manager.spawn(["node", "-e", "console.log('hello from child')"]);
    // A fixed wait of 300 ms failed on a slow machine, where node needs seconds to start.
    for (let i = 0; i < 300 && manager.getLogs(info.id) === ""; i++)
      await new Promise((r) => setTimeout(r, 50));
    expect(manager.getLogs(info.id)).toContain("hello from child");
  });

  test("a background process does not get the provider keys of the harness", async () => {
    manager = new ProcessManager();
    process.env.AGENCY_ENVTEST_API_KEY = "harness-key-71f3";
    process.env.ENVTEST_PLAIN = "plain-value-52c1";
    try {
      const info = manager.spawn([
        "node",
        "-e",
        "console.log('key=[' + (process.env.AGENCY_ENVTEST_API_KEY ?? '') + '] plain=[' + process.env.ENVTEST_PLAIN + ']')",
      ]);
      for (let i = 0; i < 300 && manager.getLogs(info.id) === ""; i++)
        await new Promise((r) => setTimeout(r, 50));
      expect(manager.getLogs(info.id)).toContain("key=[] plain=[plain-value-52c1]");
    } finally {
      delete process.env.AGENCY_ENVTEST_API_KEY;
      delete process.env.ENVTEST_PLAIN;
    }
  });

  test("kill stops a tracked process", async () => {
    manager = new ProcessManager();
    const info = manager.spawn(["node", "-e", "setInterval(() => {}, 1000)"]);
    expect(manager.kill(info.id)).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    expect(manager.list().find((p) => p.id === info.id)?.running).toBe(false);
  });

  test("kill on an unknown id returns false instead of throwing", () => {
    manager = new ProcessManager();
    expect(manager.kill("not-a-real-id")).toBe(false);
  });

  test("a refused kill does not mark the process as exited", () => {
    manager = new ProcessManager();
    const id = manager.adopt(
      {
        kill: () => {
          throw new Error("EPERM: operation not permitted");
        },
      },
      "unkillable",
    );
    manager.kill(id);
    expect(manager.list().find((p) => p.id === id)?.running).toBe(true);
  });

  test("a process confirmed gone by the OS is marked exited even if kill() throws", async () => {
    manager = new ProcessManager();
    const doomed = Bun.spawn(["node", "-e", "process.exit(0)"]);
    await doomed.exited;
    const id = manager.adopt(
      {
        pid: doomed.pid,
        kill: () => {
          throw new Error("ESRCH: no such process");
        },
      },
      "already-dead",
    );
    manager.kill(id);
    expect(manager.list().find((p) => p.id === id)?.running).toBe(false);
  });

  test("killAll stops every tracked process", async () => {
    manager = new ProcessManager();
    const a = manager.spawn(["node", "-e", "setInterval(() => {}, 1000)"]);
    const b = manager.spawn(["node", "-e", "setInterval(() => {}, 1000)"]);
    manager.killAll();
    await new Promise((r) => setTimeout(r, 200));
    const list = manager.list();
    expect(list.find((p) => p.id === a.id)?.running).toBe(false);
    expect(list.find((p) => p.id === b.id)?.running).toBe(false);
  });

  test("list reports every spawned process", () => {
    manager = new ProcessManager();
    manager.spawn(["node", "-e", "setInterval(() => {}, 1000)"]);
    manager.spawn(["node", "-e", "setInterval(() => {}, 1000)"]);
    expect(manager.list()).toHaveLength(2);
  });
});

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
    await new Promise((r) => setTimeout(r, 300));
    expect(manager.getLogs(info.id)).toContain("hello from child");
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

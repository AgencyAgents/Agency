import { describe, expect, test } from "bun:test";
import { counterIds, PendingRequestManager } from "../src/pending-request.ts";

describe("PendingRequestManager", () => {
  test("counterIds increment from the start value and the registered promise resolves with the response", async () => {
    const manager = new PendingRequestManager({ makeId: counterIds() });

    const first = manager.register(1_000, () => new Error("timed out"));
    const second = manager.register(1_000, () => new Error("timed out"));

    expect(first.id).toBe(1);
    expect(second.id).toBe(2);
    expect(manager.has(1)).toBe(true);
    expect(manager.size).toBe(2);

    expect(manager.resolve(1, "result")).toBe(true);

    await expect(first.promise).resolves.toBe("result");
    expect(manager.has(1)).toBe(false);
    expect(manager.size).toBe(1);

    // Every registration must settle: an unsettled entry's timer fires later
    // as an unhandled rejection, which the runner attributes to whatever test
    // happens to be running then (a 1000ms stray failing an unrelated suite).
    expect(manager.resolve(2, "second-result")).toBe(true);
    await expect(second.promise).resolves.toBe("second-result");
    expect(manager.size).toBe(0);
  });

  test("reject rejects with the given error and cleans up", async () => {
    const manager = new PendingRequestManager({ makeId: counterIds() });
    const { id, promise } = manager.register(1_000, () => new Error("timed out"));

    expect(manager.reject(id, new Error("server said no"))).toBe(true);

    await expect(promise).rejects.toThrow("server said no");
    expect(manager.has(id)).toBe(false);
  });

  test("a timed-out request rejects with the caller's error and cleans up", async () => {
    const manager = new PendingRequestManager({ makeId: counterIds() });
    const { id, promise } = manager.register(10, () => new Error("MCP slow timed out"));

    await expect(promise).rejects.toThrow("MCP slow timed out");
    expect(manager.has(id)).toBe(false);
  });

  test("resolve/reject after a timeout are no-ops", async () => {
    const manager = new PendingRequestManager({ makeId: counterIds() });
    const { promise } = manager.register(10, () => new Error("timed out"));

    await expect(promise).rejects.toThrow("timed out");
    expect(manager.resolve(1, "late result")).toBe(false);
    expect(manager.reject(1, new Error("late error"))).toBe(false);
  });

  test("unknown IDs report false instead of throwing", () => {
    const manager = new PendingRequestManager({ makeId: counterIds() });
    expect(manager.resolve(99, "value")).toBe(false);
    expect(manager.reject(99, new Error("nope"))).toBe(false);
    expect(manager.has(99)).toBe(false);
  });

  test("failAll rejects every pending request with the transport error and clears", async () => {
    const manager = new PendingRequestManager({ makeId: counterIds() });
    const a = manager.register(1_000, () => new Error("timed out"));
    const b = manager.register(1_000, () => new Error("timed out"));

    manager.failAll(new Error("connection closed"));

    await expect(a.promise).rejects.toThrow("connection closed");
    await expect(b.promise).rejects.toThrow("connection closed");
    expect(manager.size).toBe(0);
  });

  test("a custom ID factory produces the IDs used on the wire", async () => {
    let counter = 0;
    const manager = new PendingRequestManager<string>({ makeId: () => `id-${++counter}` });

    const { id, promise } = manager.register(1_000, () => new Error("timed out"));
    expect(id).toBe("id-1");

    manager.resolve(id, 42);
    await expect(promise).resolves.toBe(42);
  });

  test("a resolved request's timeout never fires", async () => {
    const manager = new PendingRequestManager({ makeId: counterIds() });
    const { promise } = manager.register(20, () => new Error("fired anyway"));

    manager.resolve(1, "fast");
    await expect(promise).resolves.toBe("fast");
    // Long enough for a 20ms timer to have fired if it hadn't been cleared.
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
});

import { describe, expect, test } from "bun:test";
import { EventBus } from "../src/events.ts";

describe("EventBus hardening", () => {
  test("wildcard * matches any event", () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.on("*", (p) => {
      seen.push((p as { event: string }).event);
    });
    bus.emit("tool.execute.before", { tool: "bash", input: {} });
    bus.emit("session.created", { sessionId: "s1" });
    expect(seen.length).toBe(2);
  });

  test("wildcard tool.* matches tool.execute.before and after", () => {
    const bus = new EventBus();
    const calls: string[] = [];
    bus.on("tool.*", () => {
      calls.push("hit");
    });
    bus.emit("tool.execute.before", { tool: "read", input: {} });
    bus.emit("tool.execute.after", { tool: "read", input: {}, result: { content: "ok" } });
    bus.emit("session.created", { sessionId: "x" });
    expect(calls).toEqual(["hit", "hit"]);
  });

  test("error isolation: throwing listener does not break emit loop", () => {
    const bus = new EventBus();
    const calls: string[] = [];
    bus.on("log.entry", () => {
      throw new Error("boom");
    });
    bus.on("log.entry", () => {
      calls.push("second");
    });
    bus.emit("log.entry", { level: "info", message: "hi" });
    expect(calls).toEqual(["second"]);
  });

  test("async listener throwing does not break loop (emit)", () => {
    const bus = new EventBus();
    const calls: string[] = [];
    bus.on("log.entry", async () => {
      throw new Error("async boom");
    });
    bus.on("log.entry", () => {
      calls.push("ok");
    });
    bus.emit("log.entry", { level: "info", message: "hi" });
    expect(calls).toEqual(["ok"]);
  });

  test("emitAsync awaits listeners and isolates errors", async () => {
    const bus = new EventBus();
    const order: string[] = [];
    bus.on("tool.execute.before", async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push("a");
    });
    bus.on("tool.execute.before", () => {
      throw new Error("fail");
    });
    bus.on("tool.execute.before", async () => {
      order.push("c");
    });
    await bus.emitAsync("tool.execute.before", { tool: "bash", input: {} });
    expect(order).toEqual(["a", "c"]);
  });

  test("emitCollect captures throwing listener errors for short-circuit", async () => {
    const bus = new EventBus();
    bus.on("tool.execute.before", () => {
      throw new Error("short-circuit");
    });
    bus.on("tool.execute.before", () => {});
    const { errors } = await bus.emitCollect("tool.execute.before", { tool: "bash", input: {} });
    expect(errors.length).toBe(1);
    expect((errors[0] as Error).message).toBe("short-circuit");
  });

  test("unsubscribe stops delivery for wildcards", () => {
    const bus = new EventBus();
    let count = 0;
    const off = bus.on("tool.*", () => {
      count++;
    });
    bus.emit("tool.execute.before", {});
    off();
    bus.emit("tool.execute.after", {});
    expect(count).toBe(1);
  });

  test("off method removes specific listener", () => {
    const bus = new EventBus();
    let count = 0;
    const fn = () => {
      count++;
    };
    bus.on("file.edited", fn);
    bus.emit("file.edited", { path: "a" });
    bus.off("file.edited", fn);
    bus.emit("file.edited", { path: "b" });
    expect(count).toBe(1);
  });

  test("wildcard pattern with prefix * suffix", () => {
    const bus = new EventBus();
    const hits: string[] = [];
    bus.on("*.edited", (p) => {
      hits.push((p as { path: string }).path);
    });
    bus.emit("file.edited", { path: "x" });
    bus.emit("tool.execute.before", {});
    expect(hits).toEqual(["x"]);
  });

  test("event hook via * receives all bus events", () => {
    const bus = new EventBus();
    const events: string[] = [];
    bus.on("event", () => {
      events.push("event");
    });
    bus.on("*", (_p) => {
      events.push("star");
    });
    bus.emit("permission.asked", { tool: "bash" });
    expect(events).toContain("star");
  });
});

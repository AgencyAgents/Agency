import { describe, expect, test } from "bun:test";
import { EventBus } from "../src/events.ts";

describe("EventBus", () => {
  test("delivers a payload to a subscribed listener", () => {
    const bus = new EventBus();
    let received: unknown;
    bus.on("config.loaded", (payload) => {
      received = payload;
    });

    bus.emit("config.loaded", { config: { logLevel: "debug" } });

    expect(received).toEqual({ config: { logLevel: "debug" } });
  });

  test("supports multiple listeners on the same event", () => {
    const bus = new EventBus();
    const calls: string[] = [];
    bus.on("log.entry", () => {
      calls.push("a");
    });
    bus.on("log.entry", () => {
      calls.push("b");
    });

    bus.emit("log.entry", { level: "info", message: "hi" });

    expect(calls).toEqual(["a", "b"]);
  });

  test("unsubscribe stops further delivery", () => {
    const bus = new EventBus();
    let count = 0;
    const off = bus.on("log.entry", () => {
      count += 1;
    });

    bus.emit("log.entry", { level: "info", message: "one" });
    off();
    bus.emit("log.entry", { level: "info", message: "two" });

    expect(count).toBe(1);
  });

  test("emitting an event with no listeners is a no-op", () => {
    const bus = new EventBus();
    expect(() => bus.emit("config.loaded", { config: {} })).not.toThrow();
  });
});

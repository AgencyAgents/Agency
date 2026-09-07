import { describe, expect, test } from "bun:test";
import { pruneCommand, storageCommand, whereCommand, wherePaths } from "../src/storage-commands.ts";

describe("whereCommand", () => {
  test("lists config, data, cache, and log directories", () => {
    const output = whereCommand();
    expect(output).toContain("config:");
    expect(output).toContain("data:");
    expect(output).toContain("cache:");
    expect(output).toContain("logs:");
  });

  test("text and JSON agree on every path (wherePaths parity)", () => {
    const paths = wherePaths();
    const text = whereCommand();
    for (const value of Object.values(paths)) {
      expect(text).toContain(value);
    }
    expect(Object.keys(paths).sort()).toEqual(["cache", "config", "data", "logs"]);
  });
});

describe("storageCommand", () => {
  test("reports sizes for every category", async () => {
    const output = await storageCommand();
    expect(output).toContain("data:");
    expect(output).toContain("cache:");
    expect(output).toContain("safe to delete");
  });
});

describe("pruneCommand", () => {
  test("always clears the cache, and mentions session retention only when a policy is given", async () => {
    expect(await pruneCommand()).toBe("cache: cleared");
    expect(await pruneCommand({ maxAgeDays: 30 })).toContain("sessions: deleted");
  });
});

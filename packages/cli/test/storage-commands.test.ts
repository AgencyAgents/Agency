import { describe, expect, test } from "bun:test";
import { pruneCommand, storageCommand, whereCommand } from "../src/storage-commands.ts";

describe("whereCommand", () => {
  test("lists config, data, cache, and log directories", () => {
    const output = whereCommand();
    expect(output).toContain("config:");
    expect(output).toContain("data:");
    expect(output).toContain("cache:");
    expect(output).toContain("logs:");
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
  test("always clears the cache, and mentions session retention only when a policy is given", () => {
    expect(pruneCommand()).toBe("cache: cleared");
    expect(pruneCommand({ maxAgeDays: 30 })).toContain("sessions: deleted");
  });
});

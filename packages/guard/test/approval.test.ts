import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalManager, type ApprovalRequest } from "../src/approval.ts";

function bashRequest(command: string): ApprovalRequest {
  return { tool: "bash", title: command, command };
}

describe("ApprovalManager", () => {
  test("once approves exactly the pending ask; unknown ids resolve nothing", async () => {
    const manager = new ApprovalManager();
    expect(manager.respond("nope", "once")).toEqual({ resolved: false, retroactive: 0 });

    const { id, promise } = manager.createPending(bashRequest("rm -rf build"));
    manager.respond(id, "once");
    await expect(promise).resolves.toBe("once");
    expect(manager.hasAlways(bashRequest("rm -rf build"))).toBe(false);
  });

  test("always records a session grant that survives later asks", async () => {
    const manager = new ApprovalManager();
    const { id, promise } = manager.createPending(bashRequest("git push"));
    manager.respond(id, "always");
    await expect(promise).resolves.toBe("always");
    expect(manager.hasAlways(bashRequest("git push"))).toBe(true);
  });

  test("always scopes by arity-normalized command, not raw text", () => {
    const manager = new ApprovalManager();
    const { id } = manager.createPending(bashRequest("git status --short --branch"));
    manager.respond(id, "always");
    expect(manager.hasAlways(bashRequest("git status"))).toBe(true);
    expect(manager.hasAlways(bashRequest("git push origin main"))).toBe(false);
  });

  test("always retroactively resolves OTHER matching pending asks", async () => {
    const manager = new ApprovalManager();
    const first = manager.createPending(bashRequest("bun test"));
    const second = manager.createPending(bashRequest("bun test"));
    const unrelated = manager.createPending(bashRequest("rm -rf build"));

    const outcome = manager.respond(first.id, "always");
    expect(outcome.resolved).toBe(true);
    expect(outcome.retroactive).toBe(1);
    await expect(first.promise).resolves.toBe("always");
    await expect(second.promise).resolves.toBe("once");
    expect(manager.pendingCount()).toBe(1);

    manager.respond(unrelated.id, "reject");
  });

  test("reject resolves the ask and grants nothing", async () => {
    const manager = new ApprovalManager();
    const { id, promise } = manager.createPending(bashRequest("rm -rf build"));
    manager.respond(id, "reject");
    await expect(promise).resolves.toBe("reject");
    expect(manager.hasAlways(bashRequest("rm -rf build"))).toBe(false);
  });

  test("rejectTurn cleans up only that turn's pending asks", async () => {
    const manager = new ApprovalManager();
    const mine = manager.createPending(bashRequest("rm -rf build"), "turn-1");
    const other = manager.createPending(bashRequest("bun test"), "turn-2");
    expect(manager.rejectTurn("turn-1")).toBe(1);
    await expect(mine.promise).resolves.toBe("reject");
    expect(manager.pendingCount()).toBe(1);
    manager.rejectAll();
    await expect(other.promise).resolves.toBe("reject");
  });

  test("path asks grant per containing directory", () => {
    const manager = new ApprovalManager();
    const { id } = manager.createPending({ tool: "write", title: "x", path: "src/a/b.ts" });
    manager.respond(id, "always");
    expect(manager.hasAlways({ tool: "write", title: "x", path: "src/a/c.ts" })).toBe(true);
    expect(manager.hasAlways({ tool: "write", title: "x", path: "src/other.ts" })).toBe(false);
  });

  describe("persistence", () => {
    test("grant survives daemon restart (load from disk)", () => {
      const dir = mkdtempSync(join(tmpdir(), "approval-test-"));
      try {
        const sessionId = "test-session-1";
        const first = new ApprovalManager(dir, sessionId);
        const { id } = first.createPending(bashRequest("git push"));
        first.respond(id, "always");
        expect(first.hasAlways(bashRequest("git push"))).toBe(true);

        // Simulate daemon restart: create a fresh manager with same dir+sessionId
        const second = new ApprovalManager(dir, sessionId);
        expect(second.hasAlways(bashRequest("git push"))).toBe(true);
        expect(second.hasAlways(bashRequest("rm -rf build"))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("no file on disk starts with empty grants", () => {
      const dir = mkdtempSync(join(tmpdir(), "approval-test-"));
      try {
        rmSync(dir, { recursive: true, force: true });
        // Directory doesn't exist yet
        const manager = new ApprovalManager(dir, "fresh-session");
        expect(manager.hasAlways(bashRequest("anything"))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("in-memory path unchanged when no dir provided", async () => {
      const manager = new ApprovalManager();
      const { id, promise } = manager.createPending(bashRequest("bun test"));
      manager.respond(id, "always");
      await expect(promise).resolves.toBe("always");
      expect(manager.hasAlways(bashRequest("bun test"))).toBe(true);
    });
  });
});

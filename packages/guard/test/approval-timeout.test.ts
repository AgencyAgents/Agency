import { describe, expect, test } from "bun:test";
import { ApprovalManager, type ApprovalRequest } from "../src/approval.ts";

function bashRequest(command: string): ApprovalRequest {
  return { tool: "bash", title: command, command };
}

describe("ApprovalManager bounded timeout", () => {
  test("an ask with no responder fails closed with a typed timeout reason", async () => {
    const manager = new ApprovalManager();
    const { id, promise } = manager.createPending(bashRequest("rm -rf build"), "turn-1", { timeoutMs: 20 });
    await expect(promise).resolves.toBe("reject");
    expect(manager.closeReason(id)).toBe("timeout");
    expect(manager.pendingCount()).toBe(0);
  });

  test("an answered ask records answered, not timeout", async () => {
    const manager = new ApprovalManager();
    const { id, promise } = manager.createPending(bashRequest("git push"), "turn-1", { timeoutMs: 5_000 });
    manager.respond(id, "once");
    await expect(promise).resolves.toBe("once");
    expect(manager.closeReason(id)).toBe("answered");
  });

  test("rejectTurn and rejectAll record their typed reasons", async () => {
    const manager = new ApprovalManager();
    const first = manager.createPending(bashRequest("bun test"), "turn-1", { timeoutMs: 5_000 });
    const second = manager.createPending(bashRequest("bun lint"), "turn-2", { timeoutMs: 5_000 });
    expect(manager.rejectTurn("turn-1")).toBe(1);
    await expect(first.promise).resolves.toBe("reject");
    expect(manager.closeReason(first.id)).toBe("turn-rejected");
    expect(manager.rejectAll()).toBe(1);
    await expect(second.promise).resolves.toBe("reject");
    expect(manager.closeReason(second.id)).toBe("shutdown");
  });
});

import { describe, expect, test } from "bun:test";
import { AgencyError, ErrorCode } from "@agency/schema";
import { ApprovalManager } from "../src/approval.ts";
import { assertGitWriteAllowed } from "../src/git-write.ts";
import { gitWriteDecision } from "../src/policy.ts";

async function denialOf(promise: Promise<void>): Promise<AgencyError> {
  try {
    await promise;
  } catch (error) {
    return error as AgencyError;
  }
  throw new Error("expected PERMISSION_DENIED but the gate resolved");
}

describe("gitWriteDecision", () => {
  test("absent key denies (current no-git-write posture)", () => {
    expect(gitWriteDecision(undefined)).toBe("deny");
    expect(gitWriteDecision({})).toBe("deny");
  });

  test("bare allow|ask|deny entries win", () => {
    expect(gitWriteDecision({ git_write: "allow" })).toBe("allow");
    expect(gitWriteDecision({ git_write: "ask" })).toBe("ask");
    expect(gitWriteDecision({ git_write: "deny" })).toBe("deny");
  });

  test("pattern maps and unknown values fail closed to deny", () => {
    expect(gitWriteDecision({ git_write: { "*": "allow" } })).toBe("deny");
    expect(gitWriteDecision({ git_write: "sometimes" as never })).toBe("deny");
  });
});

describe("assertGitWriteAllowed", () => {
  test("allow passes without touching approval", async () => {
    let calls = 0;
    await assertGitWriteAllowed({
      permissions: { git_write: "allow" },
      ask: async () => {
        calls += 1;
        return "reject";
      },
    });
    expect(calls).toBe(0);
  });

  test("ask proceeds on once and always", async () => {
    await assertGitWriteAllowed({ permissions: { git_write: "ask" }, ask: async () => "once" });
    await assertGitWriteAllowed({ permissions: { git_write: "ask" }, ask: async () => "always" });
  });

  test("ask presents the git_write tool over the existing approval surface", async () => {
    let seenTool = "";
    await assertGitWriteAllowed({
      permissions: { git_write: "ask" },
      ask: async (request) => {
        seenTool = request.tool;
        return "once";
      },
    });
    expect(seenTool).toBe("git_write");
  });

  test("ask denies typed on reject", async () => {
    const err = await denialOf(
      assertGitWriteAllowed({ permissions: { git_write: "ask" }, ask: async () => "reject" }),
    );
    expect(err).toBeInstanceOf(AgencyError);
    expect(err.code).toBe(ErrorCode.PERMISSION_DENIED);
  });

  test("ask denies typed when the approval times out (fail closed)", async () => {
    const manager = new ApprovalManager();
    const { id, promise } = manager.createPending(
      { tool: "git_write", title: "materialize git commit" },
      undefined,
      { timeoutMs: 5 },
    );
    const err = await denialOf(
      assertGitWriteAllowed({ permissions: { git_write: "ask" }, ask: () => promise }),
    );
    expect(err.code).toBe(ErrorCode.PERMISSION_DENIED);
    expect(manager.closeReason(id)).toBe("timeout");
  });

  test("ask without an approval surface denies typed", async () => {
    const err = await denialOf(assertGitWriteAllowed({ permissions: { git_write: "ask" } }));
    expect(err.code).toBe(ErrorCode.PERMISSION_DENIED);
  });

  test("deny always refuses typed", async () => {
    const err = await denialOf(assertGitWriteAllowed({ permissions: { git_write: "deny" } }));
    expect(err).toBeInstanceOf(AgencyError);
    expect(err.code).toBe(ErrorCode.PERMISSION_DENIED);
  });

  test("non-interactive denies regardless of setting and never asks", async () => {
    let calls = 0;
    const spy = async () => {
      calls += 1;
      return "once" as const;
    };
    const allowErr = await denialOf(
      assertGitWriteAllowed({ permissions: { git_write: "allow" }, nonInteractive: true, ask: spy }),
    );
    expect(allowErr.code).toBe(ErrorCode.PERMISSION_DENIED);
    const askErr = await denialOf(
      assertGitWriteAllowed({ permissions: { git_write: "ask" }, nonInteractive: true, ask: spy }),
    );
    expect(askErr.code).toBe(ErrorCode.PERMISSION_DENIED);
    expect(calls).toBe(0);
  });
});

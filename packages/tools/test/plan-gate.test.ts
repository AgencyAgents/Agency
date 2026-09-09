import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxBoundary } from "@agency/guard";
import { isActTransitionAllowed } from "../../core/src/prompt/plan.ts";
import {
  assertActTransitionAllowed,
  assertPlanAgentWriteAllowed,
  createExecutePlanTool,
  createPlanExitTool,
  isPlanAgentWriteAllowed,
  PlanActTransitionDeniedError,
  PlanAgentWriteDeniedError,
  PlanApprovalDeniedError,
  PlanSidecarCorruptError,
  planContentHash,
  readApprovalRecord,
  type ToolDeps,
  writeApprovalRecord,
  writePlanIssues,
} from "../src/builtins/plan.ts";
import { TodoStore } from "../src/builtins/todo.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PLAN_BODY = `# Gate proof plan

- [ ] first step
- [ ] second step
`;

function setup(opts: { nonInteractive?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "agency-plan-gate-"));
  dirs.push(root);
  mkdirSync(join(root, ".opencode", "plans"), { recursive: true });
  const planPath = join(root, ".opencode", "plans", "gate-proof.md");
  writeFileSync(planPath, PLAN_BODY);
  const deps: ToolDeps = {
    identity: { type: "user" },
    capabilities: { tools: "*", pathScopes: "*", network: "*" },
    sandbox: new SandboxBoundary(root),
  };
  const todos = new TodoStore();
  const executePlan = createExecutePlanTool(deps, todos);
  const planExit = createPlanExitTool(deps, opts);
  const signal = new AbortController().signal;
  return { root, planPath, todos, executePlan, planExit, signal };
}

describe("happy path: clean plan approves and executes to todos", () => {
  test("writeApprovalRecord then execute_plan queues unchecked steps", async () => {
    const { planPath, todos, executePlan, signal } = setup();
    const record = writeApprovalRecord(planPath, { approvedBy: "tester" });
    expect(record.hash).toBe(planContentHash(PLAN_BODY));
    const result = await executePlan.handler({ path: planPath }, { signal });
    expect(result.isError).toBeUndefined();
    expect(todos.items.map((item) => item.content)).toEqual(["first step", "second step"]);
  });

  test("plan_exit Yes approves and execute_plan runs on the same record", async () => {
    const { planPath, todos, executePlan, planExit, signal } = setup();
    const rel = ".opencode/plans/gate-proof.md";
    const approved = await planExit.handler({ plan: rel, answer: "Yes" }, { signal });
    expect(approved.isError).toBeUndefined();
    expect(readApprovalRecord(planPath)?.approvedBy).toBe("user");
    const result = await executePlan.handler({ path: planPath }, { signal });
    expect(result.isError).toBeUndefined();
    expect(todos.items.length).toBe(2);
  });
});

describe("denial 1: unresolved comments block approval typed", () => {
  test("writeApprovalRecord throws PlanApprovalDeniedError naming the cause", () => {
    const { planPath } = setup();
    writeFileSync(
      `${planPath}.comments.json`,
      JSON.stringify({ comments: [{ text: "wrong step", resolved: false }] }),
    );
    let caught: unknown;
    try {
      writeApprovalRecord(planPath, {});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PlanApprovalDeniedError);
    expect((caught as PlanApprovalDeniedError).reason).toBe("unresolved-comments");
    expect((caught as Error).message).toContain("plan-approval-denied:unresolved-comments");
    expect((caught as Error).message).toContain("unresolved comment");
    expect(readApprovalRecord(planPath)).toBeUndefined();
  });

  test("plan_exit Yes surfaces the typed denial instead of approving", async () => {
    const { root, planPath, todos, planExit, signal } = setup();
    const rel = ".opencode/plans/gate-proof.md";
    writeFileSync(
      join(root, `${rel}.comments.json`),
      JSON.stringify({ comments: [{ text: "fix me", resolved: false }] }),
    );
    const result = await planExit.handler({ plan: rel, answer: "Yes" }, { signal });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("plan-approval-denied:unresolved-comments");
    expect(readApprovalRecord(planPath)).toBeUndefined();
    expect(todos.items).toEqual([]);
  });

  test("resolved comments approve cleanly (positive control)", () => {
    const { planPath } = setup();
    writeFileSync(
      `${planPath}.comments.json`,
      JSON.stringify({ comments: [{ text: "done", resolved: true }] }),
    );
    expect(() => writeApprovalRecord(planPath, {})).not.toThrow();
  });
});

describe("denial 2: tampered plan hash blocks execution typed", () => {
  test("edit after approval denies with hash-mismatch code", async () => {
    const { planPath, todos, executePlan, signal } = setup();
    writeApprovalRecord(planPath, { approvedBy: "tester" });
    writeFileSync(planPath, `${PLAN_BODY}- [ ] sneaky step\n`);
    const result = await executePlan.handler({ path: planPath }, { signal });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("plan-act-denied:hash-mismatch");
    expect(result.content).toContain("hash mismatch");
    expect(todos.items).toEqual([]);
  });

  test("assertActTransitionAllowed throws PlanActTransitionDeniedError on drift", () => {
    const { planPath } = setup();
    writeApprovalRecord(planPath, {});
    writeFileSync(planPath, `${PLAN_BODY}- [ ] drift\n`);
    let caught: unknown;
    try {
      assertActTransitionAllowed(planPath);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PlanActTransitionDeniedError);
    expect((caught as PlanActTransitionDeniedError).reason).toBe("hash-mismatch");
  });

  test("unmodified plan passes the transition assert (positive control)", () => {
    const { planPath } = setup();
    writeApprovalRecord(planPath, {});
    const transition = assertActTransitionAllowed(planPath);
    expect(transition.record.approvedBy).toBe("user");
    expect(transition.content).toBe(PLAN_BODY);
  });
});

describe("denial 3: plan agent cannot write outside plan dirs", () => {
  test("all three plan dirs allow, everything else denies", () => {
    for (const allowed of [
      ".opencode/plans/1-x.md",
      ".agency/plans/1-x.md",
      ".omo/plans/1-x.md",
      "sub/.opencode/plans/1-x.md",
    ]) {
      expect(isPlanAgentWriteAllowed(allowed)).toBe(true);
      expect(() => assertPlanAgentWriteAllowed(allowed)).not.toThrow();
    }
    for (const denied of [
      "src/app.ts",
      ".opencode/other/x.md",
      "plans/1-x.md",
      ".opencode/plans/../../src/evil.ts",
      "/tmp/.opencode/plans/x.md",
    ]) {
      expect(isPlanAgentWriteAllowed(denied)).toBe(false);
      let caught: unknown;
      try {
        assertPlanAgentWriteAllowed(denied);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(PlanAgentWriteDeniedError);
      expect((caught as Error).message).toContain("plan-agent-write-denied");
    }
  });
});

describe("denial 4: Act without an approval record is denied", () => {
  test("execute_plan with no record denies with missing-approval code", async () => {
    const { planPath, todos, executePlan, signal } = setup();
    const result = await executePlan.handler({ path: planPath }, { signal });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("plan-act-denied:missing-approval");
    expect(result.content).toContain("no plan_approval record");
    expect(todos.items).toEqual([]);
  });

  test("assertActTransitionAllowed denies missing approval typed", () => {
    const { planPath } = setup();
    let caught: unknown;
    try {
      assertActTransitionAllowed(planPath);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PlanActTransitionDeniedError);
    expect((caught as PlanActTransitionDeniedError).reason).toBe("missing-approval");
  });

  test("gate-blocked plans deny the transition even when approved", async () => {
    const { planPath, todos, executePlan, signal } = setup();
    writeApprovalRecord(planPath, { approvedBy: "tester" });
    writePlanIssues(planPath, [{ severity: "critical", message: "unsafe step" }]);
    const result = await executePlan.handler({ path: planPath }, { signal });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("plan-act-denied:gate-blocked");
    expect(result.content).toContain("fail-blocking-severity");
    expect(todos.items).toEqual([]);
  });

  test("core guard predicate mirrors the record rule (positive + negative)", () => {
    const hash = planContentHash(PLAN_BODY);
    expect(isActTransitionAllowed({ hash }, hash)).toBe(true);
    expect(isActTransitionAllowed(undefined, hash)).toBe(false);
    expect(isActTransitionAllowed({ hash: "stale" }, hash)).toBe(false);
  });
});

describe("malformed inputs fail closed", () => {
  test("corrupt comments sidecar throws PlanSidecarCorruptError on approve", () => {
    const { planPath } = setup();
    writeFileSync(`${planPath}.comments.json`, "not json");
    expect(() => writeApprovalRecord(planPath, {})).toThrow(PlanSidecarCorruptError);
  });

  test("corrupt review sidecar denies execution instead of running", async () => {
    const { planPath, todos, executePlan, signal } = setup();
    writeApprovalRecord(planPath, {});
    writeFileSync(`${planPath}.review.json`, "not json");
    const result = await executePlan.handler({ path: planPath }, { signal });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("corrupt plan sidecar");
    expect(todos.items).toEqual([]);
  });

  test("approval record for different bytes never validates drifted content", () => {
    const { planPath } = setup();
    const record = writeApprovalRecord(planPath, {});
    expect(record.hash).not.toBe(planContentHash(`${PLAN_BODY}extra`));
    expect(isActTransitionAllowed(record, planContentHash(`${PLAN_BODY}extra`))).toBe(false);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxBoundary } from "@agency/guard";
import {
  evaluatePlanGate,
  isBlockingSeverity,
  planIdForPath,
  readPlanIssues,
  readPlanRevisions,
  resubmitPlan,
  revisePlan,
  writePlanIssues,
} from "../../src/builtins/plan.ts";
import {
  copyPlanToCanonical,
  migratePlanDirectory,
  planModeAllowsTool,
} from "../../src/builtins/plan-paths.ts";
import {
  countUnresolvedComments,
  createExecutePlanTool,
  parsePlanSteps,
  planContentHash,
  readApprovalRecord,
  TodoStore,
  type ToolDeps,
  writeApprovalRecord,
} from "../../src/index.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PLAN_BODY = `# Ship the thing

Some prose the parser must ignore.

- [ ] write the module
- [x] already done
- [ ] verify with tests
`;

function setup() {
  const root = mkdtempSync(join(tmpdir(), "agency-plan-test-"));
  dirs.push(root);
  const plansDir = join(root, ".agency", "plans");
  mkdirSync(plansDir, { recursive: true });
  const planPath = join(plansDir, "ship-the-thing.md");
  writeFileSync(planPath, PLAN_BODY);

  const deps: ToolDeps = {
    identity: { type: "user" },
    capabilities: { tools: "*", pathScopes: "*", network: "*" },
    sandbox: new SandboxBoundary(root),
  };
  const todos = new TodoStore();
  const tool = createExecutePlanTool(deps, todos);
  const signal = new AbortController().signal;
  return { root, planPath, todos, tool, signal };
}

describe("parsePlanSteps", () => {
  test("extracts GFM task-list items in order with their checked state", () => {
    const steps = parsePlanSteps(PLAN_BODY);
    expect(steps.map((s) => s.text)).toEqual(["write the module", "already done", "verify with tests"]);
    expect(steps.map((s) => s.checked)).toEqual([false, true, false]);
  });

  test("files without task lists parse to nothing", () => {
    expect(parsePlanSteps("# just prose\n\nno steps here\n")).toEqual([]);
  });
});

describe("plan approval records", () => {
  test("the record carries path, content hash, and approver", () => {
    const { planPath } = setup();
    const record = writeApprovalRecord(planPath, { approvedBy: "tester" });
    expect(record.plan).toBe(planPath);
    expect(record.hash).toBe(planContentHash(PLAN_BODY));
    expect(record.approvedBy).toBe("tester");
    expect(readApprovalRecord(planPath)).toEqual(record);
  });

  test("a plan with unresolved comments cannot be approved", () => {
    const { planPath } = setup();
    writeFileSync(
      `${planPath}.comments.json`,
      JSON.stringify({ comments: [{ text: "step 2 is wrong", resolved: false }] }),
    );
    expect(countUnresolvedComments(planPath)).toBe(1);
    expect(() => writeApprovalRecord(planPath, {})).toThrow(/unresolved comment/);
    expect(readApprovalRecord(planPath)).toBeUndefined();
  });

  test("resolved comments do not block approval", () => {
    const { planPath } = setup();
    writeFileSync(
      `${planPath}.comments.json`,
      JSON.stringify({ comments: [{ text: "ok now", resolved: true }] }),
    );
    expect(() => writeApprovalRecord(planPath, {})).not.toThrow();
  });
});

describe("execute_plan", () => {
  test("refuses a plan with no approval record", async () => {
    const { tool, planPath, signal, todos } = setup();
    const result = await tool.handler({ path: planPath }, { signal });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("no plan_approval record");
    expect(todos.items).toEqual([]);
  });

  test("an edit after approval invalidates it (hash mismatch refuses)", async () => {
    const { tool, planPath, signal, todos } = setup();
    writeApprovalRecord(planPath, { approvedBy: "tester" });
    writeFileSync(planPath, `${PLAN_BODY}\n- [ ] sneaky extra step\n`);

    const result = await tool.handler({ path: planPath }, { signal });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("hash mismatch");
    expect(todos.items).toEqual([]);
  });

  test("an approved plan materializes its UNCHECKED steps as todos in order", async () => {
    const { tool, planPath, signal, todos } = setup();
    writeApprovalRecord(planPath, { approvedBy: "tester" });

    const result = await tool.handler({ path: planPath }, { signal });
    expect(result.isError).toBeUndefined();
    expect(todos.items.map((item) => item.content)).toEqual(["write the module", "verify with tests"]);
    expect(todos.items.every((item) => item.status === "pending")).toBe(true);
    expect(result.content).toContain("approved by tester");
  });

  test("a plan with nothing left unchecked says so and replaces nothing", async () => {
    const { tool, planPath, signal, todos } = setup();
    writeFileSync(planPath, "- [x] done\n- [x] also done\n");
    writeApprovalRecord(planPath, {});

    const result = await tool.handler({ path: planPath }, { signal });
    expect(result.content).toContain("no unchecked steps");
    expect(todos.items).toEqual([]);
  });

  test("the tool writes through the sandbox, not raw paths", async () => {
    const { tool, root, signal } = setup();
    await expect(tool.handler({ path: join(root, "..", "elsewhere.md") }, { signal })).rejects.toThrow(
      /outside the sandbox root/,
    );
  });

  test("the on-disk record file travels with the plan", async () => {
    const { planPath } = setup();
    writeApprovalRecord(planPath, {});
    expect(readFileSync(`${planPath}.approval.json`, "utf8")).toContain('"hash"');
  });
});

describe("plan dir copy-migration", () => {
  test("copyPlanToCanonical copies the plan without deleting the source", () => {
    const { root, planPath } = setup();
    const dest = copyPlanToCanonical(planPath);
    expect(dest).toBe(join(root, ".opencode", "plans", "ship-the-thing.md"));
    expect(readFileSync(dest, "utf8")).toBe(PLAN_BODY);
    expect(existsSync(planPath)).toBe(true);
  });

  test("copy carries the approval and comments sidecars", () => {
    const { planPath } = setup();
    writeApprovalRecord(planPath, { approvedBy: "tester" });
    writeFileSync(`${planPath}.comments.json`, JSON.stringify({ comments: [] }));
    const dest = copyPlanToCanonical(planPath);
    expect(readApprovalRecord(dest)?.approvedBy).toBe("tester");
    expect(countUnresolvedComments(dest)).toBe(0);
    expect(existsSync(`${planPath}.approval.json`)).toBe(true);
  });

  test("migratePlanDirectory copies a legacy dir wholesale and keeps sources", () => {
    const { root, planPath } = setup();
    const destDir = join(root, ".opencode", "plans");
    const copied = migratePlanDirectory(join(root, ".agency", "plans"), destDir);
    expect(copied).toEqual([join(destDir, "ship-the-thing.md")]);
    expect(readFileSync(join(destDir, "ship-the-thing.md"), "utf8")).toBe(PLAN_BODY);
    expect(existsSync(planPath)).toBe(true);
  });
});

describe("plan revise roundtrip", () => {
  test("revise keeps the same path and plan id", () => {
    const { planPath } = setup();
    const idBefore = planIdForPath(planPath);
    revisePlan(planPath, `${PLAN_BODY}\n- [ ] added on revise\n`, "tighten scope");
    expect(planIdForPath(planPath)).toBe(idBefore);
    expect(readFileSync(planPath, "utf8")).toContain("added on revise");
  });

  test("revise appends history entries in order", () => {
    const { planPath } = setup();
    expect(readPlanRevisions(planPath)).toEqual([]);
    const first = revisePlan(planPath, `${PLAN_BODY}\n- [ ] r1\n`, "first pass");
    const second = revisePlan(planPath, `${PLAN_BODY}\n- [ ] r2\n`, "second pass");
    const history = readPlanRevisions(planPath);
    expect(history.length).toBe(2);
    expect(history.map((r) => r.revision)).toEqual([1, 2]);
    expect(history[0]?.hash).toBe(first.hash);
    expect(history[1]?.hash).toBe(second.hash);
    expect(history[1]?.note).toBe("second pass");
  });

  test("revise preserves prior hashes while content changes", () => {
    const { planPath } = setup();
    const before = planContentHash(readFileSync(planPath, "utf8"));
    revisePlan(planPath, `${PLAN_BODY}\n- [ ] changed\n`);
    const history = readPlanRevisions(planPath);
    expect(history.length).toBe(1);
    expect(history[0]?.hash).not.toBe(before);
    expect(planContentHash(readFileSync(planPath, "utf8"))).toBe(history[0]!.hash);
  });
});

describe("plan resubmit", () => {
  test("resubmit returns the current content hash", () => {
    const { planPath } = setup();
    revisePlan(planPath, `${PLAN_BODY}\n- [ ] new step\n`);
    const { hash } = resubmitPlan(planPath);
    expect(hash).toBe(planContentHash(readFileSync(planPath, "utf8")));
  });

  test("resubmit clears the stale approval so re-approval is required", async () => {
    const { planPath, tool, signal, todos } = setup();
    writeApprovalRecord(planPath, { approvedBy: "tester" });
    revisePlan(planPath, `${PLAN_BODY}\n- [ ] drift\n`);
    resubmitPlan(planPath);
    expect(readApprovalRecord(planPath)).toBeUndefined();
    const result = await tool.handler({ path: planPath }, { signal });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("no plan_approval record");
    expect(todos.items).toEqual([]);
  });
});

describe("plan severity gate", () => {
  test("info and low issues pass with advisory reason codes", () => {
    const { planPath } = setup();
    writePlanIssues(planPath, [
      { severity: "info", message: "nit" },
      { severity: "low", message: "polish" },
    ]);
    expect(readPlanIssues(planPath).length).toBe(2);
    expect(isBlockingSeverity("info")).toBe(false);
    expect(isBlockingSeverity("low")).toBe(false);
    const decision = evaluatePlanGate(planPath);
    expect(decision.pass).toBe(true);
    expect(["pass-clean", "pass-advisory-only"]).toContain(decision.reason);
    expect(decision.blocking).toEqual([]);
  });

  test("high and critical issues fail with blocking reason code", () => {
    const { planPath } = setup();
    for (const severity of ["high", "critical"] as const) {
      writePlanIssues(planPath, [{ severity, message: `${severity} problem` }]);
      expect(isBlockingSeverity(severity)).toBe(true);
      const decision = evaluatePlanGate(planPath);
      expect(decision.pass).toBe(false);
      expect(decision.reason).toBe("fail-blocking-severity");
      expect(decision.blocking.map((b) => b.severity)).toEqual([severity]);
    }
  });

  test("unresolved comments fail the gate even with no issues", () => {
    const { planPath } = setup();
    writeFileSync(
      `${planPath}.comments.json`,
      JSON.stringify({ comments: [{ text: "fix", resolved: false }] }),
    );
    const decision = evaluatePlanGate(planPath);
    expect(decision.pass).toBe(false);
    expect(decision.reason).toBe("fail-unresolved-comments");
  });

  test("execute_plan refuses a gate-blocked plan with the reason code", async () => {
    const { planPath, tool, signal, todos } = setup();
    writeApprovalRecord(planPath, { approvedBy: "tester" });
    writePlanIssues(planPath, [{ severity: "high", message: "unsafe step" }]);
    const result = await tool.handler({ path: planPath }, { signal });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("fail-blocking-severity");
    expect(todos.items).toEqual([]);
  });

  test("execute_plan runs once blocking issues are cleared and plan is re-approved", async () => {
    const { planPath, tool, signal, todos } = setup();
    writeApprovalRecord(planPath, { approvedBy: "tester" });
    writePlanIssues(planPath, [{ severity: "critical", message: "bad" }]);
    expect((await tool.handler({ path: planPath }, { signal })).isError).toBe(true);
    writePlanIssues(planPath, [{ severity: "low", message: "ok now" }]);
    const result = await tool.handler({ path: planPath }, { signal });
    expect(result.isError).toBeUndefined();
    expect(todos.items.length).toBeGreaterThan(0);
  });
});

describe("plan mode inspect stays read-only", () => {
  test("inspect tools stay allowed and writes stay gated", () => {
    for (const tool of ["read", "glob", "grep", "question", "plan_exit"]) {
      expect(planModeAllowsTool(tool)).toBe(true);
    }
    expect(planModeAllowsTool("write", "src/app.ts")).toBe(false);
    expect(planModeAllowsTool("edit", "src/app.ts")).toBe(false);
    expect(planModeAllowsTool("bash")).toBe(false);
    expect(planModeAllowsTool("execute_plan")).toBe(false);
  });

  test("plan writes stay inside plan dirs only", () => {
    expect(planModeAllowsTool("write", ".opencode/plans/1-x.md")).toBe(true);
    expect(planModeAllowsTool("write", "src/app.ts")).toBe(false);
    expect(planModeAllowsTool("edit", ".agency/plans/1-x.md")).toBe(true);
    expect(planModeAllowsTool("edit", ".omo/plans/1-x.md")).toBe(true);
  });
});

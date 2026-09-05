import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxBoundary } from "@agency/guard";
import { planModeAllowsTool, planModeRejectReason, resolvePlanPath } from "../../src/builtins/plan-paths.ts";
import {
  collapsePlanBlockForScrollback,
  createPlanExitTool,
  createQuestionTool,
  isPlanExitYes,
  isPlanPath,
  PLAN_BLOCK_ICON,
  planAgentPermissions,
  planApprovedMessage,
  planFilePath,
  readApprovalRecord,
  renderPlanBlockForScrollback,
  slugifyPlanTitle,
  TodoStore,
  type ToolDeps,
} from "../../src/index.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(opts: { nonInteractive?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "agency-plan49-"));
  dirs.push(root);
  mkdirSync(join(root, ".opencode", "plans"), { recursive: true });
  const deps: ToolDeps = {
    identity: { type: "user" },
    capabilities: { tools: "*", pathScopes: "*", network: "*" },
    sandbox: new SandboxBoundary(root),
  };
  const planExit = createPlanExitTool(deps, opts);
  const question = createQuestionTool(opts);
  const signal = new AbortController().signal;
  return { root, deps, planExit, question, signal };
}

describe("plan file path", () => {
  test("builds .opencode/plans/<epoch>-<slug>.md", () => {
    expect(planFilePath("Add Auth Flow", 1700000000)).toBe(".opencode/plans/1700000000-add-auth-flow.md");
  });

  test("slugify handles noise and empty titles", () => {
    expect(slugifyPlanTitle("  Hello, World!  ")).toBe("hello-world");
    expect(slugifyPlanTitle("!!!")).toBe("plan");
  });

  test("isPlanPath accepts both spellings", () => {
    expect(isPlanPath(".opencode/plans/1-x.md")).toBe(true);
    expect(isPlanPath(".agency/plans/1-x.md")).toBe(true);
    expect(isPlanPath("src/app.ts")).toBe(false);
  });
});

describe("plan agent permission gate", () => {
  test("write/edit allow only plan dirs", () => {
    const perms = planAgentPermissions();
    expect(perms.write).toEqual({
      "*": "deny",
      ".opencode/plans/**": "allow",
      ".agency/plans/**": "allow",
      ".omo/plans/**": "allow",
    });
    expect(perms.edit).toEqual({
      "*": "deny",
      ".opencode/plans/**": "allow",
      ".agency/plans/**": "allow",
      ".omo/plans/**": "allow",
    });
    expect(perms.bash).toBe("deny");
  });
});

describe("scrollback icon rendering", () => {
  test("plan blocks collapse to the icon line", () => {
    const line = renderPlanBlockForScrollback(".opencode/plans/1-x.md");
    expect(line).toBe(`${PLAN_BLOCK_ICON} plan .opencode/plans/1-x.md`);
    expect(line.includes("\n")).toBe(false);
    expect(collapsePlanBlockForScrollback("# big plan\n- [ ] step", ".opencode/plans/1-x.md")).toBe(line);
  });

  test("plan_exit renderCall carries the icon", () => {
    const { planExit } = setup();
    expect(planExit.renderCall!({ plan: ".opencode/plans/1-x.md" })).toContain(PLAN_BLOCK_ICON);
  });
});

describe("plan_exit Yes/No question", () => {
  test("no answer presents the Yes/No question", async () => {
    const { planExit, signal } = setup();
    const result = await planExit.handler({ plan: ".opencode/plans/1-x.md" }, { signal });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('"Yes"');
    expect(result.content).toContain('"No"');
  });

  test("Yes writes the approval record and emits the synthetic message", async () => {
    const { root, planExit, signal } = setup();
    const rel = planFilePath("ship it", 1700000001);
    const abs = join(root, rel);
    writeFileSync(abs, "- [ ] do the thing\n");
    const result = await planExit.handler({ plan: rel, answer: "Yes" }, { signal });
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe(planApprovedMessage(rel));
    expect(readApprovalRecord(abs)?.approvedBy).toBe("user");
  });

  test("exact synthetic message shape", () => {
    expect(planApprovedMessage(".opencode/plans/1-x.md")).toBe(
      "The plan at .opencode/plans/1-x.md has been approved, you can now edit files. Execute the plan",
    );
    expect(isPlanExitYes("yes") && isPlanExitYes("Y") && !isPlanExitYes("no")).toBe(true);
  });

  test("No declines without writing a record", async () => {
    const { root, planExit, signal } = setup();
    const rel = planFilePath("ship it", 1700000002);
    const abs = join(root, rel);
    writeFileSync(abs, "- [ ] do the thing\n");
    const result = await planExit.handler({ plan: rel, answer: "No" }, { signal });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("not approved");
    expect(readApprovalRecord(abs)).toBeUndefined();
  });
});

describe("non-interactive force-deny", () => {
  test("plan_exit denies without an approval surface", async () => {
    const { planExit, signal } = setup({ nonInteractive: true });
    const result = await planExit.handler({ plan: ".opencode/plans/1-x.md", answer: "Yes" }, { signal });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("non-interactive");
  });

  test("question denies without an approval surface", async () => {
    const { question, signal } = setup({ nonInteractive: true });
    const result = await question.handler({ question: "proceed?" }, { signal });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("non-interactive");
  });

  test("interactive question still works", async () => {
    const { question, signal } = setup();
    const todos = new TodoStore();
    expect(todos.items).toEqual([]);
    const result = await question.handler({ question: "proceed?", choices: ["Yes", "No"] }, { signal });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("proceed?");
  });
});

describe("plan dir collapse", () => {
  test("resolvePlanPath redirects legacy and working paths to canonical", () => {
    expect(resolvePlanPath(".agency/plans/1-x.md")).toBe(".opencode/plans/1-x.md");
    expect(resolvePlanPath(".omo/plans/1-x.md")).toBe(".opencode/plans/1-x.md");
    expect(resolvePlanPath(".opencode/plans/1-x.md")).toBe(".opencode/plans/1-x.md");
  });

  test("resolvePlanPath redirects nested absolute aliases", () => {
    expect(resolvePlanPath("/root/.agency/plans/a.md")).toBe("/root/.opencode/plans/a.md");
    expect(resolvePlanPath("C:/work/.omo/plans/a.md")).toBe("C:/work/.opencode/plans/a.md");
  });

  test("resolvePlanPath leaves non-plan paths alone", () => {
    expect(resolvePlanPath("src/app.ts")).toBe("src/app.ts");
  });

  test("isPlanPath accepts the working spelling", () => {
    expect(isPlanPath(".omo/plans/1-x.md")).toBe(true);
  });

  test("plan agent permissions allow the working dir", () => {
    const perms = planAgentPermissions();
    expect(perms.write).toMatchObject({ ".omo/plans/**": "allow" });
    expect(perms.edit).toMatchObject({ ".omo/plans/**": "allow" });
  });
});

describe("plan mode read-only guard", () => {
  test("read-only inspection tools are allowed", () => {
    for (const tool of ["read", "glob", "grep", "question", "plan_exit"]) {
      expect(planModeAllowsTool(tool)).toBe(true);
      expect(planModeRejectReason(tool)).toBeUndefined();
    }
  });

  test("writes to non-plan paths are rejected", () => {
    expect(planModeAllowsTool("write", "src/app.ts")).toBe(false);
    expect(planModeAllowsTool("edit", "src/app.ts")).toBe(false);
    expect(planModeRejectReason("write", "src/app.ts")).toContain("plan mode");
  });

  test("writes to plan paths in any spelling are allowed", () => {
    expect(planModeAllowsTool("write", ".opencode/plans/1-x.md")).toBe(true);
    expect(planModeAllowsTool("edit", ".agency/plans/1-x.md")).toBe(true);
    expect(planModeAllowsTool("write", ".omo/plans/1-x.md")).toBe(true);
  });

  test("state-changing tools without a plan target are rejected", () => {
    expect(planModeAllowsTool("bash")).toBe(false);
    expect(planModeAllowsTool("execute_plan")).toBe(false);
    expect(planModeAllowsTool("write")).toBe(false);
  });
});

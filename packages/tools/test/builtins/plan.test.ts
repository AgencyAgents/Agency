import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxBoundary } from "@agency/guard";
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

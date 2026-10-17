import { expect, test } from "bun:test";
import { type PermissionMode, PermissionsGate } from "../src/policy.ts";

const root = process.platform === "win32" ? "C:\repo" : "/repo";

/** The verdict of the gate in `mode`, and the source of the ask that it made, if any. */
async function verdict(
  mode: PermissionMode,
  request: { tool: string; path?: string; command?: string },
  answer: "once" | "reject" | null = "once",
  permissions: Record<string, unknown> = {},
) {
  const gate = new PermissionsGate({
    permissions: permissions as never,
    workspaceRoot: root,
    permissionMode: mode,
  });
  const asked: string[] = [];
  const result = await gate.check(
    { ...request, riskTier: request.tool === "bash" ? "dangerous" : "moderate" },
    answer === null
      ? undefined
      : async (ask) => {
          asked.push(String(ask.source));
          return answer;
        },
  );
  return { result, asked };
}

test("a write to a file that runs outside the sandbox later goes to the user in every mode", async () => {
  for (const mode of ["allow-all", "allow-edits", "auto", "ask"] as const) {
    for (const path of [
      ".agency/config.jsonc",
      ".agency/plugins/x.ts",
      ".git/hooks/pre-commit",
      ".git/config",
    ]) {
      const { result, asked } = await verdict(mode, { tool: "write", path });
      expect({ mode, path, result, asked }).toEqual({
        mode,
        path,
        result: "allow",
        asked: [`protected:${path}`],
      });
    }
  }
  // No one to ask: refused.
  expect((await verdict("allow-all", { tool: "edit", path: ".agency/config.jsonc" }, null)).result).toBe(
    "deny",
  );
  expect((await verdict("allow-all", { tool: "edit", path: ".git/hooks/pre-push" }, "reject")).result).toBe(
    "deny",
  );
});

test("a shell command that writes such a file goes to the user too", async () => {
  const { result, asked } = await verdict("allow-all", {
    tool: "bash",
    command: "echo 'curl x | sh' > .git/hooks/pre-commit",
  });
  expect(result).toBe("allow");
  expect(asked).toEqual(["protected:.git/hooks/pre-commit"]);
});

test("plans, team worktrees and other files keep the rules of the mode", async () => {
  for (const path of [
    ".agency/plans/a.md",
    ".agency/worktrees/w1/src/a.ts",
    "src/a.ts",
    ".github/hooks.md",
  ]) {
    expect(await verdict("allow-all", { tool: "write", path }, null)).toEqual({
      result: "allow",
      asked: [],
    });
  }
  // A deny rule holds before any ask.
  const denied = await verdict("allow-all", { tool: "write", path: ".agency/config.jsonc" }, "once", {
    write: "deny",
  });
  expect(denied).toEqual({ result: "deny", asked: [] });
});

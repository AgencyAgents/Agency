import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { FULL_CAPABILITIES, SandboxBoundary } from "@agency/guard";
import { createBashTool } from "../src/builtins/bash.ts";
import { ProcessManager } from "../src/process-manager.ts";
import { resolveShell } from "../src/shell.ts";

test("bash runs beside other calls only for a read-only command that keeps the cwd", () => {
  const root = tmpdir();
  const tool = createBashTool(
    { identity: { type: "user" }, capabilities: FULL_CAPABILITIES, sandbox: new SandboxBoundary(root) },
    resolveShell("linux"),
    { cwd: root },
    new ProcessManager(),
  );
  const readOnly = (input: Record<string, unknown>) => tool.readOnly?.({ command: "", ...input });
  expect(readOnly({ command: "git status" })).toBe(true);
  expect(readOnly({ command: "ls -la && cat a.txt" })).toBe(true);
  expect(readOnly({ command: "cd src && ls" })).toBe(false);
  expect(readOnly({ command: "rm -rf build" })).toBe(false);
  expect(readOnly({ command: "echo hi > out.txt" })).toBe(false);
  expect(readOnly({ command: "git status", background: true })).toBe(false);
});

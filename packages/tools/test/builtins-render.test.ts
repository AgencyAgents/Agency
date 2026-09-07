import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FULL_CAPABILITIES, SandboxBoundary } from "@agency/guard";
import type { HttpClient } from "@agency/net";
import { createBuiltinTools } from "../src/builtin-set.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const noopHttp: HttpClient = { fetch: async () => new Response() };

async function builtinsFor() {
  const root = mkdtempSync(join(tmpdir(), "agency-builtin-render-"));
  dirs.push(root);
  return createBuiltinTools({
    deps: {
      identity: { type: "user" as const },
      capabilities: FULL_CAPABILITIES,
      sandbox: new SandboxBoundary(root),
    },
    http: noopHttp,
    workspaceRoot: root,
    snapshotDir: join(root, "snapshots"),
    websearch: { endpoint: "https://search.example.com" },
  });
}

type RenderableTool = {
  name: string;
  renderCall?: (input: Record<string, unknown>) => string;
  renderResult?: (result: { content: string; isError?: boolean; input?: Record<string, unknown> }) => string;
};

describe("built-in tool presentations", () => {
  test("all built-ins ship renderCall and renderResult", async () => {
    const builtins = await builtinsFor();
    try {
      const names = [
        "bash",
        "read",
        "write",
        "edit",
        "grep",
        "glob",
        "fetch",
        "todo_read",
        "todo_write",
        "execute_plan",
        "process_output",
        "process_list",
        "process_kill",
        "question",
        "websearch",
      ];
      for (const name of names) {
        const tool = builtins.tools.find((t: RenderableTool) => t.name === name);
        expect(tool, name).toBeDefined();
        expect(typeof tool!.renderCall, `${name}.renderCall`).toBe("function");
        expect(typeof tool!.renderResult, `${name}.renderResult`).toBe("function");
      }
    } finally {
      await builtins.dispose();
    }
  });

  test("bash renders the command and a one-line result", async () => {
    const builtins = await builtinsFor();
    try {
      const bash = builtins.tools.find((t: RenderableTool) => t.name === "bash")!;
      expect(bash.renderCall!({ command: "bun test" })).toBe("bash bun test");
      expect(
        bash.renderResult!({ content: "ok\nmore", isError: false, input: { command: "bun test" } }),
      ).toBe("bash: ok (+1 lines)");
      expect(bash.renderResult!({ content: "boom", isError: true })).toBe("bash failed: boom");
      expect(bash.renderResult!({ content: "", isError: false })).toBe("bash: (no output)");
    } finally {
      await builtins.dispose();
    }
  });

  test("read and write name the file in their results", async () => {
    const builtins = await builtinsFor();
    try {
      const read = builtins.tools.find((t: RenderableTool) => t.name === "read")!;
      expect(read.renderCall!({ path: "src/a.ts" })).toBe("read src/a.ts");
      expect(read.renderResult!({ content: "l1\nl2\nl3", isError: false, input: { path: "src/a.ts" } })).toBe(
        "read src/a.ts: 3 lines",
      );
      expect(read.renderResult!({ content: "no such file", isError: true, input: { path: "x.ts" } })).toBe(
        "read x.ts failed: no such file",
      );

      const write = builtins.tools.find((t: RenderableTool) => t.name === "write")!;
      expect(write.renderCall!({ path: "a.ts" })).toBe("write a.ts");
      expect(write.renderResult!({ content: "wrote 12 bytes to a.ts", isError: false })).toBe(
        "wrote 12 bytes to a.ts",
      );
    } finally {
      await builtins.dispose();
    }
  });

  test("grep and glob summarize match/file counts with the pattern", async () => {
    const builtins = await builtinsFor();
    try {
      const grep = builtins.tools.find((t: RenderableTool) => t.name === "grep")!;
      expect(grep.renderCall!({ pattern: "foo", path: "src" })).toBe("grep foo src");
      expect(
        grep.renderResult!({ content: "a.ts:1:x\nb.ts:2:y", isError: false, input: { pattern: "foo" } }),
      ).toBe("grep foo: 2 matches (a.ts:1:x)");
      expect(grep.renderResult!({ content: "no matches", isError: false, input: { pattern: "foo" } })).toBe(
        "grep foo: no matches",
      );

      const glob = builtins.tools.find((t: RenderableTool) => t.name === "glob")!;
      expect(glob.renderCall!({ pattern: "src/**/*.ts" })).toBe("glob src/**/*.ts");
      expect(
        glob.renderResult!({ content: "a.ts\nb.ts", isError: false, input: { pattern: "**/*.ts" } }),
      ).toBe("glob **/*.ts: 2 files (a.ts)");
      expect(
        glob.renderResult!({ content: "no files matched", isError: false, input: { pattern: "x" } }),
      ).toBe("glob x: no files matched");
    } finally {
      await builtins.dispose();
    }
  });

  test("edit, fetch, and the todo tools render bounded one-line results", async () => {
    const builtins = await builtinsFor();
    try {
      const edit = builtins.tools.find((t: RenderableTool) => t.name === "edit")!;
      expect(edit.renderCall!({ path: "a.ts" })).toBe("edit a.ts");
      expect(edit.renderResult!({ content: "edited a.ts", isError: false })).toBe("edited a.ts");
      expect(edit.renderResult!({ content: "oldText not found in a.ts", isError: true })).toBe(
        "edit failed: oldText not found in a.ts",
      );

      const fetch = builtins.tools.find((t: RenderableTool) => t.name === "fetch")!;
      expect(fetch.renderCall!({ url: "https://agency.dev" })).toBe("fetch https://agency.dev");
      expect(
        fetch.renderResult!({
          content: "<html>\nbody",
          isError: false,
          input: { url: "https://agency.dev" },
        }),
      ).toBe("fetch https://agency.dev: 11 chars (<html>)");
      expect(
        fetch.renderResult!({ content: "404 Not Found: gone", isError: true, input: { url: "u" } }),
      ).toBe("fetch u failed: 404 Not Found: gone");

      const todoRead = builtins.tools.find((t: RenderableTool) => t.name === "todo_read")!;
      expect(todoRead.renderCall!({})).toBe("todo_read");
      expect(todoRead.renderResult!({ content: "(empty)", isError: false })).toBe("todo list is empty");
      expect(todoRead.renderResult!({ content: "[pending] ship (1)\n[done] plan (2)", isError: false })).toBe(
        "todos: 2 ([pending] ship (1))",
      );

      const todoWrite = builtins.tools.find((t: RenderableTool) => t.name === "todo_write")!;
      expect(todoWrite.renderCall!({ items: [1, 2, 3] })).toBe("todo_write (3 items)");
      expect(todoWrite.renderResult!({ content: "updated 3 todo item(s)", isError: false })).toBe(
        "updated 3 todo item(s)",
      );
    } finally {
      await builtins.dispose();
    }
  });

  test("process tools render process id and status", async () => {
    const builtins = await builtinsFor();
    try {
      const procOutput = builtins.tools.find((t: RenderableTool) => t.name === "process_output")!;
      expect(procOutput.renderCall!({ id: "p1" })).toBe("process_output p1");
      expect(procOutput.renderResult!({ content: "build output", isError: false })).toBe(
        "process_output: build output",
      );
      expect(procOutput.renderResult!({ content: "not found", isError: true })).toBe(
        "process_output failed: not found",
      );

      const procList = builtins.tools.find((t: RenderableTool) => t.name === "process_list")!;
      expect(procList.renderCall!({})).toBe("process_list");
      expect(procList.renderResult!({ content: "running  p1  pid 123  bun dev", isError: false })).toBe(
        "running  p1  pid 123  bun dev",
      );
      expect(procList.renderResult!({ content: "no processes", isError: false })).toBe("no processes");

      const procKill = builtins.tools.find((t: RenderableTool) => t.name === "process_kill")!;
      expect(procKill.renderCall!({ id: "p1" })).toBe("process_kill p1");
      expect(procKill.renderResult!({ content: "killed p1", isError: false })).toBe("killed p1");
      expect(procKill.renderResult!({ content: "unknown process", isError: true })).toBe(
        "process_kill failed: unknown process",
      );
    } finally {
      await builtins.dispose();
    }
  });

  test("question and websearch render one-line summaries", async () => {
    const builtins = await builtinsFor();
    try {
      const question = builtins.tools.find((t: RenderableTool) => t.name === "question")!;
      expect(question.renderCall!({ question: "Which approach?" })).toBe("question Which approach?");
      expect(
        question.renderResult!({ content: '{"type":"question","question":"Which?"}', isError: false }),
      ).toBe('{"type":"question","question":"Which?"}');
      expect(question.renderResult!({ content: "empty question", isError: true })).toBe(
        "question failed: empty question",
      );

      const websearch = builtins.tools.find((t: RenderableTool) => t.name === "websearch")!;
      expect(websearch.renderCall!({ query: "latest news" })).toBe("websearch latest news");
      expect(websearch.renderResult!({ content: "result 1\nresult 2", isError: false })).toBe(
        "websearch: result 1 (+1 lines)",
      );
      expect(websearch.renderResult!({ content: "", isError: false })).toBe("websearch: (no results)");
      expect(websearch.renderResult!({ content: "API error", isError: true })).toBe(
        "websearch failed: API error",
      );
    } finally {
      await builtins.dispose();
    }
  });

  test("execute_plan renders plan path and step count", async () => {
    const builtins = await builtinsFor();
    try {
      const plan = builtins.tools.find((t: RenderableTool) => t.name === "execute_plan")!;
      expect(plan.renderCall!({ path: ".agency/plans/plan.md" })).toBe("execute_plan .agency/plans/plan.md");
      expect(
        plan.renderResult!({ content: "plan approved by user; queued 3 step(s) as todos", isError: false }),
      ).toBe("plan approved by user; queued 3 step(s) as todos");
      expect(plan.renderResult!({ content: "no approval record", isError: true })).toBe(
        "execute_plan failed: no approval record",
      );
    } finally {
      await builtins.dispose();
    }
  });

  test("every render result is a single line and stays bounded on huge output", async () => {
    const builtins = await builtinsFor();
    try {
      const huge = `${"x".repeat(5000)}\n${"y".repeat(5000)}`;
      const input = {
        command: "c",
        path: "p.ts",
        pattern: "pp",
        url: "https://u.dev",
        id: "p1",
        question: "q",
        query: "q",
        items: [1],
      };
      for (const name of [
        "bash",
        "read",
        "write",
        "edit",
        "grep",
        "glob",
        "fetch",
        "todo_read",
        "todo_write",
        "execute_plan",
        "process_output",
        "process_list",
        "process_kill",
        "question",
        "websearch",
      ]) {
        const tool = builtins.tools.find((t: RenderableTool) => t.name === name)!;
        const call = tool.renderCall!(input);
        const result = tool.renderResult!({ content: huge, isError: false, input });
        expect(call.includes("\n"), `${name} renderCall multiline`).toBe(false);
        expect(result.includes("\n"), `${name} renderResult multiline`).toBe(false);
        expect(call.length).toBeLessThan(300);
        expect(result.length).toBeLessThan(300);
      }
    } finally {
      await builtins.dispose();
    }
  });

  test("renders survive malformed model-produced input without throwing", async () => {
    const builtins = await builtinsFor();
    try {
      const bad = {
        command: 42,
        path: undefined,
        pattern: {},
        url: null,
        items: "not-an-array",
        id: 123,
        question: 42,
        query: 42,
      };
      for (const name of [
        "bash",
        "read",
        "write",
        "edit",
        "grep",
        "glob",
        "fetch",
        "todo_read",
        "todo_write",
        "execute_plan",
        "process_output",
        "process_list",
        "process_kill",
        "question",
        "websearch",
      ]) {
        const tool = builtins.tools.find((t: RenderableTool) => t.name === name)!;
        expect(() => tool.renderCall!(bad), `${name} renderCall throws`).not.toThrow();
        expect(
          () => tool.renderResult!({ content: "c", isError: false, input: bad }),
          `${name} renderResult throws`,
        ).not.toThrow();
      }
    } finally {
      await builtins.dispose();
    }
  });
});

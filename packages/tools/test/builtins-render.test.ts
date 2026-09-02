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
  });
}

type RenderableTool = {
  name: string;
  renderCall?: (input: Record<string, unknown>) => string;
  renderResult?: (result: { content: string; isError?: boolean; input?: Record<string, unknown> }) => string;
};

describe("built-in tool presentations", () => {
  test("all nine built-ins ship renderCall and renderResult", async () => {
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
      expect(bash.renderResult!({ content: "ok\nmore", isError: false, input: { command: "bun test" } })).toBe(
        "bash: ok (+1 lines)",
      );
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
      expect(glob.renderResult!({ content: "no files matched", isError: false, input: { pattern: "x" } })).toBe(
        "glob x: no files matched",
      );
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
        fetch.renderResult!({ content: "<html>\nbody", isError: false, input: { url: "https://agency.dev" } }),
      ).toBe("fetch https://agency.dev: 11 chars (<html>)");
      expect(fetch.renderResult!({ content: "404 Not Found: gone", isError: true, input: { url: "u" } })).toBe(
        "fetch u failed: 404 Not Found: gone",
      );

      const todoRead = builtins.tools.find((t: RenderableTool) => t.name === "todo_read")!;
      expect(todoRead.renderCall!({})).toBe("todo_read");
      expect(todoRead.renderResult!({ content: "(empty)", isError: false })).toBe("todo list is empty");
      expect(
        todoRead.renderResult!({ content: "[pending] ship (1)\n[done] plan (2)", isError: false }),
      ).toBe("todos: 2 ([pending] ship (1))");

      const todoWrite = builtins.tools.find((t: RenderableTool) => t.name === "todo_write")!;
      expect(todoWrite.renderCall!({ items: [1, 2, 3] })).toBe("todo_write (3 items)");
      expect(todoWrite.renderResult!({ content: "updated 3 todo item(s)", isError: false })).toBe(
        "updated 3 todo item(s)",
      );
    } finally {
      await builtins.dispose();
    }
  });

  test("every render result is a single line and stays bounded on huge output", async () => {
    const builtins = await builtinsFor();
    try {
      const huge = `${"x".repeat(5000)}\n${"y".repeat(5000)}`;
      const input = { command: "c", path: "p.ts", pattern: "pp", url: "https://u.dev" };
      for (const name of ["bash", "read", "write", "edit", "grep", "glob", "fetch", "todo_read", "todo_write"]) {
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
      const bad = { command: 42, path: undefined, pattern: {}, url: null, items: "not-an-array" };
      for (const name of ["bash", "read", "write", "edit", "grep", "glob", "fetch", "todo_read", "todo_write"]) {
        const tool = builtins.tools.find((t: RenderableTool) => t.name === name)!;
        expect(() => tool.renderCall!(bad)).not.toThrow();
        expect(() => tool.renderResult!({ content: "c", isError: false, input: bad })).not.toThrow();
      }
    } finally {
      await builtins.dispose();
    }
  });
});

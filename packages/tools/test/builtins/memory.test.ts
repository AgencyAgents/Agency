import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTool, MAX_MEMORY_NOTES, readMemoryNotes } from "../../src/builtins/memory.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const signal = new AbortController().signal;

test("the memory tool adds, shows and removes notes in its file, and refuses past the cap", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agency-memory-"));
  dirs.push(dir);
  const file = join(dir, "sub", "ws.md");
  const tool = createMemoryTool(file);
  const call = (input: Record<string, unknown>) => tool.handler(input, { signal });
  expect(await call({ action: "view" })).toEqual({ content: "No notes." });
  expect((await call({ action: "add", note: "Run tests with\n  bun test" })).content).toContain("1 notes");
  await call({ action: "add", note: "The user wants short answers" });
  expect(readFileSync(file, "utf8")).toBe("- Run tests with bun test\n- The user wants short answers\n");
  expect((await call({ action: "view" })).content).toBe(
    "- Run tests with bun test\n- The user wants short answers",
  );
  expect(await call({ action: "remove", note: "short answers" })).toEqual({ content: "Removed 1 notes." });
  expect(readMemoryNotes(file)).toEqual(["- Run tests with bun test"]);
  expect((await call({ action: "remove", note: "nothing like it" })).isError).toBe(true);
  expect((await call({ action: "add", note: " " })).isError).toBe(true);
  expect((await call({ action: "add", note: "x".repeat(1_001) })).isError).toBe(true);
  for (let i = 1; i < MAX_MEMORY_NOTES; i++) await call({ action: "add", note: `note ${i}` });
  const full = await call({ action: "add", note: "one too many" });
  expect(full.isError).toBe(true);
  expect(full.content).toContain("remove");
});

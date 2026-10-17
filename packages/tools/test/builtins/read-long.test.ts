import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FULL_CAPABILITIES, SandboxBoundary } from "@agency/guard";
import { createReadTool } from "../../src/builtins/read.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const signal = new AbortController().signal;

function readOf(name: string, text: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agency-read-long-")));
  dirs.push(root);
  writeFileSync(join(root, name), text);
  const tool = createReadTool({
    identity: { type: "user" },
    capabilities: FULL_CAPABILITIES,
    sandbox: new SandboxBoundary(root),
  });
  return tool.handler({ path: name }, { signal });
}

test("a read of a long file stops where the loop would cut it, and says where the rest starts", async () => {
  const text = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join("\n");
  const { content } = await readOf("long.txt", text);
  expect(content.startsWith("line 1\nline 2\n")).toBe(true);
  expect(content).toContain("line 2000\n");
  expect(content).not.toContain("line 2001");
  expect(content).toContain("The file has 5000 lines: these are lines 1 to 2000. Read with offset 2001");
});

test("lines that are long make the read stop before 50 KB", async () => {
  const text = Array.from({ length: 300 }, (_, i) => `${i + 1} ${"x".repeat(400)}`).join("\n");
  const { content } = await readOf("wide.txt", text);
  expect(Buffer.byteLength(content)).toBeLessThan(50_000);
  expect(content).toMatch(/these are lines 1 to \d+\. Read with offset \d+/);
});

test("a file under both limits comes whole, with no note", async () => {
  const text = "a\nb\n";
  expect((await readOf("short.txt", text)).content).toBe(text);
});

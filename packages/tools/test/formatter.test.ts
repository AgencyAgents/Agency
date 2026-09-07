import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFormatter } from "../src/formatter.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "agency-formatter-test-"));
  dirs.push(dir);
  const path = join(dir, "file.txt");
  writeFileSync(path, content);
  return path;
}

describe("runFormatter", () => {
  test("does nothing when no command is configured", async () => {
    const path = tempFile("unchanged");
    await runFormatter({}, path);
    expect(readFileSync(path, "utf8")).toBe("unchanged");
  });

  test("runs the configured command with the file path appended", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agency-formatter-test-"));
    dirs.push(dir);
    const marker = join(dir, "ran.txt");
    const path = tempFile("content");

    // Use node itself as a stand-in "formatter" that proves it was invoked
    // with the right argument, without depending on a real formatter binary.
    await runFormatter(
      { command: ["node", "-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, process.argv[1])`] },
      path,
    );

    expect(readFileSync(marker, "utf8")).toBe(path);
  });

  test("a failing/missing formatter command does not throw", async () => {
    const path = tempFile("content");
    await expect(runFormatter({ command: ["not-a-real-binary-xyz"] }, path)).resolves.toBeUndefined();
  });
});

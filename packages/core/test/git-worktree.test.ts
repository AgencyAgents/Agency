import { afterEach, describe, expect, it } from "bun:test";
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeWorktreeReadOnly } from "../src/git-worktree.ts";

describe("makeWorktreeReadOnly", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {}
    }
  });

  function tempDir(): string {
    const d = mkdtempSync(join(tmpdir(), "wt-ro-"));
    dirs.push(d);
    return d;
  }

  it("makes source files read-only so bash echo > file fails", () => {
    const root = tempDir();
    // Create a source file
    writeFileSync(join(root, "readme.md"), "content");
    // Create a subdirectory with a file
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "index.ts"), "const x = 1;");

    const scratchRel = ".agency/scratch/reviewer";
    const scratchAbs = makeWorktreeReadOnly(root, scratchRel);

    // Source file should be read-only — writing should fail
    expect(() => writeFileSync(join(root, "readme.md"), "new content")).toThrow();
    // Source dir file should be read-only
    expect(() => writeFileSync(join(root, "src", "index.ts"), "const x = 2;")).toThrow();

    // Scratch dir should be writable
    const scratchFile = join(scratchAbs, "test-output.txt");
    writeFileSync(scratchFile, "writable output");
    expect(readFileSync(scratchFile, "utf8")).toBe("writable output");
  });

  it("keeps scratch dir writable for logs and temp files", () => {
    const root = tempDir();
    writeFileSync(join(root, "source.ts"), "original");

    const scratchRel = ".agency/scratch/code-reviewer";
    const scratchAbs = makeWorktreeReadOnly(root, scratchRel);

    // Write multiple files in scratch
    writeFileSync(join(scratchAbs, "log.txt"), "log entry");
    writeFileSync(join(scratchAbs, "result.json"), '{"ok": true}');
    mkdirSync(join(scratchAbs, "sub"));
    writeFileSync(join(scratchAbs, "sub", "detail.txt"), "details");

    expect(readFileSync(join(scratchAbs, "log.txt"), "utf8")).toBe("log entry");
    expect(readFileSync(join(scratchAbs, "result.json"), "utf8")).toBe('{"ok": true}');
    expect(readFileSync(join(scratchAbs, "sub", "detail.txt"), "utf8")).toBe("details");

    // Source still read-only
    expect(() => writeFileSync(join(root, "source.ts"), "modified")).toThrow();
  });

  it("returns the absolute scratch path", () => {
    const root = tempDir();
    const scratchRel = ".agency/scratch/test";
    const result = makeWorktreeReadOnly(root, scratchRel);
    expect(result).toBe(join(root, scratchRel));
  });

  it("handles empty worktree gracefully", () => {
    const root = tempDir();
    const scratchRel = ".agency/scratch/empty";
    const result = makeWorktreeReadOnly(root, scratchRel);
    // Scratch should be writable
    writeFileSync(join(result, "test.txt"), "works");
    expect(readFileSync(join(result, "test.txt"), "utf8")).toBe("works");
  });

  it("does not affect files outside the worktree", () => {
    const root = tempDir();
    const outside = tempDir();
    writeFileSync(join(outside, "external.txt"), "external");

    makeWorktreeReadOnly(root, ".agency/scratch/x");

    // Outside file should still be writable
    writeFileSync(join(outside, "external.txt"), "modified");
    expect(readFileSync(join(outside, "external.txt"), "utf8")).toBe("modified");
  });

  it("sets the read-only attribute so W_OK access check fails on source files", () => {
    const root = tempDir();
    writeFileSync(join(root, "locked.txt"), "secret");
    mkdirSync(join(root, "lib"));
    writeFileSync(join(root, "lib", "util.ts"), "export const x = 1;");

    makeWorktreeReadOnly(root, ".agency/scratch/x");

    // accessSync with W_OK should throw on read-only files
    expect(() => accessSync(join(root, "locked.txt"), constants.W_OK)).toThrow();
    expect(() => accessSync(join(root, "lib", "util.ts"), constants.W_OK)).toThrow();

    // Scratch dir should pass W_OK
    const scratchAbs = join(root, ".agency/scratch/x");
    expect(() => accessSync(scratchAbs, constants.W_OK)).not.toThrow();
  });

  it("keeps scratch dir writable on deeply nested paths", () => {
    const root = tempDir();
    mkdirSync(join(root, "a", "b", "c"), { recursive: true });
    writeFileSync(join(root, "a", "b", "c", "deep.txt"), "deep");

    const scratchRel = ".agency/scratch/deep-agent";
    const scratchAbs = makeWorktreeReadOnly(root, scratchRel);

    // Deep source file should be read-only
    expect(() => writeFileSync(join(root, "a", "b", "c", "deep.txt"), "modified")).toThrow();

    // Scratch should be writable — create nested dir first
    mkdirSync(join(scratchAbs, "nested"), { recursive: true });
    writeFileSync(join(scratchAbs, "nested", "log.txt"), "nested log");
    expect(readFileSync(join(scratchAbs, "nested", "log.txt"), "utf8")).toBe("nested log");
  });

  it("handles Windows-style backslash paths on all platforms", () => {
    const root = tempDir();
    writeFileSync(join(root, "readme.md"), "content");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "index.ts"), "const x = 1;");

    // Use explicit backslash paths to simulate Windows-style input
    const winRoot = root.replace(/\//g, "\\");
    const scratchRel = ".agency\\scratch\\win-agent";
    const scratchAbs = makeWorktreeReadOnly(winRoot, scratchRel);

    // Source files should be read-only
    expect(() => writeFileSync(join(root, "readme.md"), "new content")).toThrow();
    expect(() => writeFileSync(join(root, "src", "index.ts"), "const x = 2;")).toThrow();

    // Scratch should be writable
    writeFileSync(join(scratchAbs, "output.txt"), "works");
    expect(readFileSync(join(scratchAbs, "output.txt"), "utf8")).toBe("works");
  });
});

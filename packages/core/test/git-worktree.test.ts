import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorktree,
  listWorktrees,
  makeWorktreeReadOnly,
  removeReadOnlyWorktree,
  restoreWorktreeWritable,
} from "../src/git-worktree.ts";

let gitAvailable = false;
try {
  execFileSync("git", ["--version"], { stdio: "ignore" });
  gitAvailable = true;
} catch {
  gitAvailable = false;
}

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

describe("restoreWorktreeWritable", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs.splice(0)) {
      try {
        restoreWorktreeWritable(d);
      } catch {}
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {}
    }
  });

  it("makes a hardened worktree writable again so cleanup can delete it", () => {
    const root = mkdtempSync(join(tmpdir(), "wt-restore-"));
    dirs.push(root);
    writeFileSync(join(root, "readme.md"), "content");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "index.ts"), "const x = 1;");

    makeWorktreeReadOnly(root, ".agency/scratch/x");
    expect(() => writeFileSync(join(root, "readme.md"), "new")).toThrow();

    restoreWorktreeWritable(root);

    writeFileSync(join(root, "readme.md"), "new");
    expect(readFileSync(join(root, "readme.md"), "utf8")).toBe("new");
    writeFileSync(join(root, "src", "index.ts"), "const x = 2;");
    expect(() => accessSync(join(root, "readme.md"), constants.W_OK)).not.toThrow();
  });
});

describe("removeReadOnlyWorktree", () => {
  it.skipIf(!gitAvailable)(
    "removes a hardened real git worktree (plain remove would fail with Permission denied)",
    async () => {
      const repo = mkdtempSync(join(tmpdir(), "wt-rm-repo-"));
      try {
        execFileSync("git", ["init", "-q"], { cwd: repo });
        execFileSync("git", ["config", "user.email", "qa@example.com"], { cwd: repo });
        execFileSync("git", ["config", "user.name", "qa"], { cwd: repo });
        writeFileSync(join(repo, "app.ts"), "export const v = 1;\n");
        execFileSync("git", ["add", "."], { cwd: repo });
        execFileSync("git", ["commit", "-qm", "init"], { cwd: repo });

        const wtPath = join(repo, ".agency", "worktrees", "reviewer");
        await createWorktree(repo, wtPath);
        makeWorktreeReadOnly(wtPath, join(".agency", "scratch", "reviewer"));
        expect(() => writeFileSync(join(wtPath, "app.ts"), "HACKED")).toThrow();

        await removeReadOnlyWorktree(repo, wtPath);

        const listed = await listWorktrees(repo);
        expect(listed.some((w) => w.path === wtPath)).toBe(false);
      } finally {
        try {
          restoreWorktreeWritable(repo);
        } catch {}
        rmSync(repo, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!gitAvailable)(
    "falls back to recursive delete when git already unregistered the worktree",
    async () => {
      const repo = mkdtempSync(join(tmpdir(), "wt-rm-fb-"));
      try {
        execFileSync("git", ["init", "-q"], { cwd: repo });
        execFileSync("git", ["config", "user.email", "qa@example.com"], { cwd: repo });
        execFileSync("git", ["config", "user.name", "qa"], { cwd: repo });
        writeFileSync(join(repo, "app.ts"), "export const v = 1;\n");
        execFileSync("git", ["add", "."], { cwd: repo });
        execFileSync("git", ["commit", "-qm", "init"], { cwd: repo });

        const wtPath = join(repo, ".agency", "worktrees", "reviewer");
        await createWorktree(repo, wtPath);
        makeWorktreeReadOnly(wtPath, join(".agency", "scratch", "reviewer"));

        // Simulate a partial cleanup: unregister the worktree in git metadata
        // while the locked files remain on disk.
        restoreWorktreeWritable(join(repo, ".git", "worktrees"));
        rmSync(join(repo, ".git", "worktrees", "reviewer"), { recursive: true, force: true });

        await removeReadOnlyWorktree(repo, wtPath);

        expect(() => accessSync(wtPath, constants.F_OK)).toThrow();
        const listed = await listWorktrees(repo);
        expect(listed.some((w) => w.path === wtPath)).toBe(false);
      } finally {
        try {
          restoreWorktreeWritable(repo);
        } catch {}
        rmSync(repo, { recursive: true, force: true });
      }
    },
  );
});

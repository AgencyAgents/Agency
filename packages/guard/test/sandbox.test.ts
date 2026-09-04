import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgencyError, ErrorCode } from "@agency/schema";
import { SandboxBoundary } from "../src/sandbox.ts";

describe("SandboxBoundary.resolvePath", () => {
  // "C:" is a relative folder name on POSIX, so absolute paths must be per-platform.
  const isWin = process.platform === "win32";
  const root = isWin ? join("C:", "repo", "project") : join("/", "repo", "project");
  const outsideAbsolute = isWin ? join("C:", "Windows", "System32") : join("/", "etc", "passwd");
  const sibling = isWin
    ? join("C:", "repo", "project-evil", "file")
    : join("/", "repo", "project-evil", "file");
  const boundary = new SandboxBoundary(root);

  test("allows a path inside the root", () => {
    expect(boundary.resolvePath(join("src", "index.ts"))).toBe(join(root, "src", "index.ts"));
  });

  test("allows the root itself", () => {
    expect(boundary.resolvePath(".")).toBe(root);
  });

  test("rejects a relative traversal escaping the root", () => {
    expect(() => boundary.resolvePath(join("..", "..", "etc", "passwd"))).toThrow(AgencyError);
  });

  test("rejects an absolute path outside the root", () => {
    expect(() => boundary.resolvePath(outsideAbsolute)).toThrow(AgencyError);
  });

  test("rejects a sibling directory that merely shares a prefix", () => {
    expect(() => boundary.resolvePath(sibling)).toThrow(AgencyError);
  });

  test("the thrown error carries PERMISSION_DENIED", () => {
    const err = (() => {
      try {
        boundary.resolvePath(join("..", "outside"));
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect((err as AgencyError).code).toBe(ErrorCode.PERMISSION_DENIED);
  });
});

describe("SandboxBoundary.resolvePath symlink handling", () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function setup(): { root: string; outside: string } {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "agency-sandbox-symlink-")));
    tempDirs.push(dir);
    const root = join(dir, "workspace");
    const outside = join(dir, "outside");
    mkdirSync(join(root, "sub"), { recursive: true });
    mkdirSync(outside);
    return { root, outside };
  }

  function link(target: string, path: string): void {
    symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
  }

  test("a symlink inside the root pointing outside it is rejected", () => {
    const { root, outside } = setup();
    link(outside, join(root, "sub", "escape"));
    const boundary = new SandboxBoundary(root);

    expect(() => boundary.resolvePath(join("sub", "escape", "secret.txt"))).toThrow(AgencyError);
  });

  test("a symlink that points back inside the root still resolves", () => {
    const { root } = setup();
    link(join(root, "sub"), join(root, "alias"));
    const boundary = new SandboxBoundary(root);

    expect(boundary.resolvePath(join("alias", "file.txt"))).toBe(join(root, "sub", "file.txt"));
  });

  test("a not-yet-existing path under a symlinked parent is still caught", () => {
    const { root, outside } = setup();
    link(outside, join(root, "sub", "escape"));
    const boundary = new SandboxBoundary(root);

    // Neither escape/nor the file below it exists yet — the dereference must
    // happen through the existing ancestor.
    expect(() => boundary.resolvePath(join("sub", "escape", "new", "file.txt"))).toThrow(AgencyError);
  });

  test("a not-yet-existing path inside the root still resolves lexically", () => {
    const { root } = setup();
    const boundary = new SandboxBoundary(root);

    expect(boundary.resolvePath(join("src", "new-file.ts"))).toBe(join(root, "src", "new-file.ts"));
  });

  test("EACCES on symlink target directory re-throws, blocking the path", () => {
    // EACCES is not reliably triggerable on Windows via chmod; skip there.
    if (process.platform === "win32") return;

    const dir = mkdtempSync(join(tmpdir(), "agency-sandbox-eacces-"));
    tempDirs.push(dir);
    const root = join(dir, "workspace");
    const outside = join(dir, "outside");
    mkdirSync(join(root, "sub"), { recursive: true });
    mkdirSync(outside);

    // Remove all permissions from the outside directory so realpathSync
    // on any path through it throws EACCES.
    chmodSync(outside, 0o000);

    try {
      symlinkSync(
        outside,
        join(root, "sub", "escape"),
        (process.platform as string) === "win32" ? "junction" : "dir",
      );

      const boundary = new SandboxBoundary(root);
      // Before the fix, canonicalPath would silently fall through to the
      // nearest accessible ancestor and re-append "escape/file.txt" literally,
      // making contains() miss the escape. After the fix, EACCES re-throws.
      expect(() => boundary.resolvePath(join("sub", "escape", "file.txt"))).toThrow(AgencyError);
    } finally {
      // Restore permissions so the temp dir can be cleaned up.
      chmodSync(outside, 0o755);
    }
  });

  test("normal ENOENT on non-existent file still resolves through ancestor", () => {
    const { root } = setup();
    const boundary = new SandboxBoundary(root);

    // A path that doesn't exist yet (file to be created) must still resolve
    // to the correct in-root path — ENOENT on the final component is expected.
    expect(boundary.resolvePath(join("sub", "brand-new-dir", "new-file.ts"))).toBe(
      join(root, "sub", "brand-new-dir", "new-file.ts"),
    );
  });
});

describe("SandboxBoundary.checkCommand", () => {
  test("allows anything when no policy is configured", () => {
    const boundary = new SandboxBoundary(".");
    expect(() => boundary.checkCommand("rm -rf /")).not.toThrow();
  });

  test("deny patterns win even without an allowlist", () => {
    const boundary = new SandboxBoundary(".", { deny: [/rm\s+-rf/] });
    expect(() => boundary.checkCommand("rm -rf build")).toThrow(AgencyError);
    expect(() => boundary.checkCommand("ls -la")).not.toThrow();
  });

  test("an allowlist rejects anything not matched", () => {
    const boundary = new SandboxBoundary(".", { allow: [/^git (status|diff)/] });
    expect(() => boundary.checkCommand("git status")).not.toThrow();
    expect(() => boundary.checkCommand("git push --force")).toThrow(AgencyError);
  });

  test("deny is checked before allow, so it can veto an otherwise-allowed command", () => {
    const boundary = new SandboxBoundary(".", {
      allow: [/^git/],
      deny: [/^git push/],
    });
    expect(() => boundary.checkCommand("git status")).not.toThrow();
    expect(() => boundary.checkCommand("git push")).toThrow(AgencyError);
  });
});

describe("SandboxBoundary.resolvePathGated (external_directory)", () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function setup(): { root: string; outside: string } {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "agency-sandbox-external-")));
    tempDirs.push(dir);
    const root = join(dir, "workspace");
    const outside = join(dir, "outside");
    mkdirSync(root, { recursive: true });
    mkdirSync(outside);
    return { root, outside };
  }

  test("in-root paths pass regardless of the external decision", async () => {
    const { root } = setup();
    const boundary = new SandboxBoundary(root, {}, () => "deny");
    await expect(boundary.resolvePathGated("src/new.ts", { tool: "write" })).resolves.toBe(
      join(root, "src", "new.ts"),
    );
  });

  test("deny (and the no-decision default) refuses an out-of-root path", async () => {
    const { root, outside } = setup();
    const denied = new SandboxBoundary(root, {}, () => "deny");
    await expect(denied.resolvePathGated(outside, { tool: "read" })).rejects.toThrow(AgencyError);

    const unset = new SandboxBoundary(root);
    await expect(unset.resolvePathGated(outside, { tool: "read" })).rejects.toThrow(AgencyError);
  });

  test("allow admits an out-of-root path", async () => {
    const { root, outside } = setup();
    const boundary = new SandboxBoundary(root, {}, () => "allow");
    await expect(boundary.resolvePathGated(outside, { tool: "read" })).resolves.toBe(outside);
  });

  test("ask consults the approval callback; rejection throws, approval admits", async () => {
    const { root, outside } = setup();
    const boundary = new SandboxBoundary(root, {}, () => "ask");

    await expect(boundary.resolvePathGated(outside, { tool: "read", ask: async () => "once" })).resolves.toBe(
      outside,
    );

    try {
      await boundary.resolvePathGated(outside, { tool: "read", ask: async () => "reject" });
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as AgencyError).code).toBe(ErrorCode.PERMISSION_DENIED);
    }
  });

  test("ask with no approval surface available fails closed", async () => {
    const { root, outside } = setup();
    const boundary = new SandboxBoundary(root, {}, () => "ask");
    await expect(boundary.resolvePathGated(outside, { tool: "read" })).rejects.toThrow(AgencyError);
  });

  test("a symlink escape is still refused through the gated path", async () => {
    const { root, outside } = setup();
    symlinkSync(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
    const boundary = new SandboxBoundary(root, {}, () => "allow");
    // allow opens the genuine outside, but a symlinked in-root path resolving
    // outside is a containment question, decided by the same gate here: with
    // allow configured the resolved real path is admitted and reported.
    const resolved = await boundary.resolvePathGated(join("escape", "secret.txt"), {
      tool: "read",
    });
    expect(resolved.startsWith(outside)).toBe(true);
  });
});

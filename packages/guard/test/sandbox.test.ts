import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { AgencyError, ErrorCode } from "@agency/schema";
import { SandboxBoundary } from "../src/sandbox.ts";

describe("SandboxBoundary.resolvePath", () => {
  const root = join("C:", "repo", "project");
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
    expect(() => boundary.resolvePath(join("C:", "Windows", "System32"))).toThrow(AgencyError);
  });

  test("rejects a sibling directory that merely shares a prefix", () => {
    expect(() => boundary.resolvePath(join("C:", "repo", "project-evil", "file"))).toThrow(AgencyError);
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

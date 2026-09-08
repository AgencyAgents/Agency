import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgencyError, ErrorCode } from "@agency/schema";
import type { ToolDeps } from "@agency/tools";
import { FULL_CAPABILITIES } from "../src/capabilities.ts";
import type { SandboxBackend } from "../src/sandbox.ts";
import { SandboxBoundary } from "../src/sandbox.ts";

// Baseline characterization for the SandboxBackend seam (wave1-todo1).
// Pins observable behavior of the local software backend before the
// interface extraction: containment, symlink escape, command policy,
// and the external_directory gate. Behavior must not change.
describe("sandbox seam baseline (local backend)", () => {
  test("resolvePath admits in-root paths and rejects escapes", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "agency-seam-base-")));
    try {
      const root = join(dir, "ws");
      mkdirSync(root, { recursive: true });
      const sb = new SandboxBoundary(root);
      expect(sb.resolvePath(join("a", "b.txt"))).toBe(join(root, "a", "b.txt"));
      expect(() => sb.resolvePath(join("..", "evil.txt"))).toThrow(AgencyError);
      try {
        sb.resolvePath(join("..", "evil.txt"));
      } catch (e) {
        expect((e as AgencyError).code).toBe(ErrorCode.PERMISSION_DENIED);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("resolvePath rejects a symlink escape through ToolDeps", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "agency-seam-link-")));
    try {
      const root = join(dir, "ws");
      const outside = join(dir, "outside");
      mkdirSync(join(root, "sub"), { recursive: true });
      mkdirSync(outside);
      symlinkSync(outside, join(root, "sub", "escape"), process.platform === "win32" ? "junction" : "dir");
      const deps: ToolDeps = {
        identity: { type: "user" },
        capabilities: FULL_CAPABILITIES,
        sandbox: new SandboxBoundary(root),
      };
      expect(() => deps.sandbox.resolvePath(join("sub", "escape", "s.txt"))).toThrow(AgencyError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("checkCommand through ToolDeps allows and denies per policy", () => {
    const deps: ToolDeps = {
      identity: { type: "user" },
      capabilities: FULL_CAPABILITIES,
      sandbox: new SandboxBoundary(".", { allow: [/^git/], deny: [/^git push/] }),
    };
    expect(() => deps.sandbox.checkCommand("git status")).not.toThrow();
    expect(() => deps.sandbox.checkCommand("git push")).toThrow(AgencyError);
    expect(() => deps.sandbox.checkCommand("rm -rf x")).toThrow(AgencyError);
  });

  test("resolvePathGated honors deny/allow/ask/fail-closed", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "agency-seam-gated-")));
    try {
      const root = join(dir, "ws");
      const outside = join(dir, "outside");
      mkdirSync(root, { recursive: true });
      mkdirSync(outside);
      const deps: ToolDeps = {
        identity: { type: "user" },
        capabilities: FULL_CAPABILITIES,
        sandbox: new SandboxBoundary(root),
      };
      // In-root passes through the ToolDeps reference.
      await expect(deps.sandbox.resolvePathGated("new.ts", { tool: "write" })).resolves.toBe(
        join(root, "new.ts"),
      );
      const denied = new SandboxBoundary(root, {}, () => "deny");
      await expect(denied.resolvePathGated(outside, { tool: "read" })).rejects.toThrow(AgencyError);
      const allowed = new SandboxBoundary(root, {}, () => "allow");
      await expect(allowed.resolvePathGated(outside, { tool: "read" })).resolves.toBe(outside);
      const gated = new SandboxBoundary(root, {}, () => "ask");
      await expect(gated.resolvePathGated(outside, { tool: "read", ask: async () => "once" })).resolves.toBe(
        outside,
      );
      await expect(gated.resolvePathGated(outside, { tool: "read" })).rejects.toThrow(AgencyError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("local backend satisfies the SandboxBackend seam type", () => {
    const backend: SandboxBackend = new SandboxBoundary(".");
    expect(() => backend.checkCommand("anything")).not.toThrow();
  });
});

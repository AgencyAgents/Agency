import { describe, expect, it } from "bun:test";
import {
  coverScope,
  intersectPathScopes,
  normalizeScopePath,
  scopeMatchesPattern,
} from "../src/capabilities.ts";
import { PermissionsGate } from "../src/policy.ts";

const ROOT = process.platform === "win32" ? "C:\\repo" : "/repo";

function gate(permissions: Record<string, unknown> = { write: "allow", edit: "allow", read: "allow" }) {
  return new PermissionsGate({
    permissions: permissions as Record<string, "allow">,
    workspaceRoot: ROOT,
  });
}

describe("scope matching", () => {
  it("normalizes separators so Windows paths match POSIX scopes", () => {
    expect(normalizeScopePath("src\\auth\\")).toBe("src/auth");
    expect(scopeMatchesPattern("src/auth/**", "src\\auth\\login.ts")).toBe(true);
    expect(scopeMatchesPattern("src/auth/**", "src/db/query.ts")).toBe(false);
    expect(scopeMatchesPattern("**/*.test.ts", "src/auth/x.test.ts")).toBe(true);
    expect(scopeMatchesPattern("/**", "anything/at/all.ts")).toBe(true);
  });

  it("coverScope keeps, narrows, or drops", () => {
    expect(coverScope("src/api/v1/**", "src/api/**")).toBe("keep");
    expect(coverScope("/**", "src/api/**")).toBe("narrow-to-grant");
    expect(coverScope("src/db/**", "src/api/**")).toBe("drop");
    expect(coverScope("src/api/**", "*")).toBe("keep");
  });

  it("intersects requested scopes with grants, never unions", () => {
    const out = intersectPathScopes(["src/api/v1/**", "src/db/**"], ["src/api/**"]);
    expect(out.scopes).toEqual(["src/api/v1/**"]);
    expect(out.narrowed).toBe(true);
    expect(intersectPathScopes(["/**"], ["src/api/**"]).scopes).toEqual(["src/api/**"]);
    expect(intersectPathScopes(["src/db/**"], ["src/api/**"]).scopes).toEqual([]);
  });
});

describe("item scope layered on the claiming agent gate", () => {
  it("denies a write outside the item pathScope and allows one inside", async () => {
    const scoped = gate().withItemScope(["src/auth/**"]);
    expect(
      await scoped.check({ tool: "write", path: "src/auth/login.ts", riskTier: "moderate" }, undefined),
    ).toBe("allow");
    expect(
      await scoped.check({ tool: "write", path: "src/db/query.ts", riskTier: "moderate" }, undefined),
    ).toBe("deny");
    const open = gate();
    expect(
      await open.check({ tool: "write", path: "src/db/query.ts", riskTier: "moderate" }, undefined),
    ).toBe("allow");
  });

  it("static denies still win and pathless tools are unaffected", async () => {
    const scoped = gate({ write: "deny" }).withItemScope(["src/auth/**"]);
    expect(
      await scoped.check({ tool: "write", path: "src/auth/login.ts", riskTier: "moderate" }, undefined),
    ).toBe("deny");
  });

  it("withMode preserves the layered scope", async () => {
    const scoped = gate().withItemScope(["src/auth/**"]).withMode("allow-edits");
    expect(
      await scoped.check({ tool: "write", path: "src/db/query.ts", riskTier: "moderate" }, undefined),
    ).toBe("deny");
  });
});

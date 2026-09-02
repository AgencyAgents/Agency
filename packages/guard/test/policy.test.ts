import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  normalizeCommand,
  PermissionsGate,
  PolicyEngine,
  type PolicyRule,
  relativeWorkspacePath,
  rulesFromPermissions,
} from "../src/policy.ts";
import { createFileTrustStore } from "../src/trust.ts";

describe("PolicyEngine", () => {
  test("falls back to the default decision when no rule matches", () => {
    const engine = new PolicyEngine([], "ask");
    expect(engine.evaluate({ tool: "read" })).toBe("ask");
  });

  test("matches an exact tool rule", () => {
    const engine = new PolicyEngine([{ tool: "bash", decision: "ask" }]);
    expect(engine.evaluate({ tool: "bash" })).toBe("ask");
    expect(engine.evaluate({ tool: "read" })).toBe("ask"); // default, not the bash rule
  });

  test("a wildcard tool rule matches any tool", () => {
    const engine = new PolicyEngine([{ tool: "*", decision: "deny" }]);
    expect(engine.evaluate({ tool: "bash" })).toBe("deny");
    expect(engine.evaluate({ tool: "read" })).toBe("deny");
  });

  test("first matching rule wins over later, less specific ones", () => {
    const rules: PolicyRule[] = [
      { tool: "bash", commandPattern: "^rm ", decision: "deny" },
      { tool: "bash", decision: "ask" },
    ];
    const engine = new PolicyEngine(rules, "allow");
    expect(engine.evaluate({ tool: "bash", command: "rm -rf build" })).toBe("deny");
    expect(engine.evaluate({ tool: "bash", command: "ls" })).toBe("ask");
  });

  test("pathGlob matches a directory prefix with /**", () => {
    const engine = new PolicyEngine([{ tool: "write", pathGlob: "/repo/src/**", decision: "allow" }], "ask");
    expect(engine.evaluate({ tool: "write", path: "/repo/src/index.ts" })).toBe("allow");
    expect(engine.evaluate({ tool: "write", path: "/repo/secrets.env" })).toBe("ask");
  });

  test("a rule with a pathGlob does not match a request with no path", () => {
    const engine = new PolicyEngine([{ tool: "write", pathGlob: "/repo/**", decision: "allow" }], "deny");
    expect(engine.evaluate({ tool: "write" })).toBe("deny");
  });

  test("commandPattern is a real regex, not a plain substring", () => {
    const engine = new PolicyEngine(
      [{ tool: "bash", commandPattern: "^git (status|diff)", decision: "allow" }],
      "ask",
    );
    expect(engine.evaluate({ tool: "bash", command: "git status" })).toBe("allow");
    expect(engine.evaluate({ tool: "bash", command: "echo 'git status'" })).toBe("ask");
  });

  test("a rule matches the arity-normalized command even when the raw one misses", () => {
    const engine = new PolicyEngine(
      [{ tool: "bash", commandPattern: "^git checkout$", decision: "allow" }],
      "ask",
    );
    expect(engine.evaluate({ tool: "bash", command: "git checkout main" })).toBe("allow");
    expect(engine.evaluate({ tool: "bash", command: "git push" })).toBe("ask");
  });
});

describe("normalizeCommand (arity table)", () => {
  test("git keeps two words, dropping the rest", () => {
    expect(normalizeCommand("git checkout main")).toBe("git checkout");
    expect(normalizeCommand("git push origin main --force")).toBe("git push");
  });

  test("untabled commands are returned trimmed", () => {
    expect(normalizeCommand("  echo   hello world ")).toBe("echo hello world");
  });

  test("empty commands normalize to empty", () => {
    expect(normalizeCommand("   ")).toBe("");
  });
});

describe("permissions config -> rules -> PolicyEngine (last match wins)", () => {
  test("the opencode example map: git allow, rm deny, everything else ask", () => {
    const engine = new PolicyEngine(
      rulesFromPermissions({ bash: { "*": "ask", "git *": "allow", "rm *": "deny" } }),
    );
    expect(engine.evaluate({ tool: "bash", command: "git status" })).toBe("allow");
    expect(engine.evaluate({ tool: "bash", command: "rm -rf build" })).toBe("deny");
    expect(engine.evaluate({ tool: "bash", command: "bun test" })).toBe("ask");
  });

  test("LAST matching rule wins, overriding earlier ones", () => {
    const engine = new PolicyEngine(
      rulesFromPermissions({ bash: { "git *": "allow", "git push*": "deny" } }),
    );
    expect(engine.evaluate({ tool: "bash", command: "git push origin main" })).toBe("deny");
    expect(engine.evaluate({ tool: "bash", command: "git status" })).toBe("allow");
  });

  test("path maps match workspace-relative paths and last match wins", () => {
    const engine = new PolicyEngine(
      rulesFromPermissions({ write: { "*": "deny", ".agency/plans/**": "allow" } }),
    );
    expect(engine.evaluate({ tool: "write", path: ".agency/plans/auth.md" })).toBe("allow");
    expect(engine.evaluate({ tool: "write", path: "src/index.ts" })).toBe("deny");
  });

  test("a mapped tool with no matching pattern falls through to its ask catch-all", () => {
    const engine = new PolicyEngine(rulesFromPermissions({ bash: { "git *": "allow", "rm *": "deny" } }));
    expect(engine.evaluate({ tool: "bash", command: "curl example.com" })).toBe("ask");
  });

  test("bare decisions become tool-level rules", () => {
    const engine = new PolicyEngine(rulesFromPermissions({ fetch: "deny", read: "allow" }), "ask");
    expect(engine.evaluate({ tool: "fetch" })).toBe("deny");
    expect(engine.evaluate({ tool: "read" })).toBe("allow");
    expect(engine.evaluate({ tool: "grep" })).toBe("ask");
  });
});

describe("relativeWorkspacePath", () => {
  const isWin = process.platform === "win32";
  const root = isWin ? join("C:", "repo") : join("/", "repo");

  test("converts absolute paths to forward-slash workspace-relative form", () => {
    expect(relativeWorkspacePath(root, join(root, "src", "index.ts"))).toBe("src/index.ts");
  });

  test("resolves relative input against the root", () => {
    expect(relativeWorkspacePath(root, join(".agency", "plans", "x.md"))).toBe(".agency/plans/x.md");
  });
});

describe("PermissionsGate", () => {
  const root = process.platform === "win32" ? join("C:", "repo") : join("/", "repo");

  test("a bare deny filters the tool from the offered list", () => {
    const gate = new PermissionsGate({
      permissions: { fetch: "deny" },
      workspaceRoot: root,
    });
    expect(gate.toolOffered("fetch")).toBe(false);
    expect(gate.toolOffered("read")).toBe(true);
  });

  test("unlisted tools default by risk tier: safe allow, dangerous ask", () => {
    const gate = new PermissionsGate({ workspaceRoot: root });
    expect(gate.toolOffered("read", "safe")).toBe(true);
    expect(gate.decisionFor({ tool: "read", riskTier: "safe" })).toBe("allow");
    expect(gate.decisionFor({ tool: "bash", riskTier: "dangerous" })).toBe("ask");
  });

  test("per-agent mode (absentToolsDenied) filters unlisted tools entirely", () => {
    const gate = new PermissionsGate({
      permissions: { read: "allow", write: { "*": "deny", ".agency/plans/**": "allow" } },
      workspaceRoot: root,
      absentToolsDenied: true,
    });
    expect(gate.toolOffered("read", "safe")).toBe(true);
    expect(gate.toolOffered("bash", "dangerous")).toBe(false);
    expect(gate.decisionFor({ tool: "bash" })).toBe("deny");
  });

  test("check resolves ask through the approval callback and denies on reject", async () => {
    const gate = new PermissionsGate({ permissions: { bash: "ask" }, workspaceRoot: root });
    const asks: string[] = [];
    const allowed = await gate.check({ tool: "bash", command: "bun test" }, async (request) => {
      asks.push(request.title);
      return "once";
    });
    expect(allowed).toBe("allow");
    expect(asks).toEqual(["bun test"]);

    const denied = await gate.check({ tool: "bash", command: "bun test" }, async () => "reject");
    expect(denied).toBe("deny");
  });

  test("an ask decision with no approval surface fails closed", async () => {
    const gate = new PermissionsGate({ permissions: { bash: "ask" }, workspaceRoot: root });
    expect(await gate.check({ tool: "bash", command: "anything" }, undefined)).toBe("deny");
  });

  test("the trust gate denies mutating tools in an untrusted workspace but not safe ones", async () => {
    const trustPath = join(root, "trust.json");
    const gate = new PermissionsGate({
      workspaceRoot: root,
      trust: { store: createFileTrustStore(trustPath), root, required: true },
    });
    expect(await gate.check({ tool: "bash", riskTier: "dangerous" }, undefined)).toBe("deny");
    expect(await gate.check({ tool: "edit", riskTier: "moderate" }, undefined)).toBe("deny");
    expect(await gate.check({ tool: "read", riskTier: "safe" }, undefined)).toBe("allow");
  });

  test("external_directory: bare decision and directory-glob map", () => {
    const bare = new PermissionsGate({
      permissions: { external_directory: "allow" },
      workspaceRoot: root,
    });
    expect(bare.externalDirectoryDecision(join("/tmp", "x"))).toBe("allow");

    const mapped = new PermissionsGate({
      permissions: { external_directory: { "/tmp/**": "allow" } },
      workspaceRoot: root,
    });
    expect(mapped.externalDirectoryDecision("/tmp/build/out.log")).toBe("allow");
    expect(mapped.externalDirectoryDecision("/etc/passwd")).toBe("ask");
  });

  test("unconfigured external_directory defaults to deny (historical sandbox behavior)", () => {
    const gate = new PermissionsGate({ workspaceRoot: root });
    expect(gate.externalDirectoryDecision("/tmp/x")).toBe("deny");
  });
});

import { describe, expect, test } from "bun:test";
import { PolicyEngine, type PolicyRule } from "../src/policy.ts";

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
    const engine = new PolicyEngine([{ tool: "bash", commandPattern: "^git (status|diff)", decision: "allow" }], "ask");
    expect(engine.evaluate({ tool: "bash", command: "git status" })).toBe("allow");
    expect(engine.evaluate({ tool: "bash", command: "echo 'git status'" })).toBe("ask");
  });
});

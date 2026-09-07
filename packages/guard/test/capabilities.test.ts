import { describe, expect, test } from "bun:test";
import { AgencyError, ErrorCode } from "@agency/schema";
import {
  type Capabilities,
  callerLabel,
  FULL_CAPABILITIES,
  NO_CAPABILITIES,
  requireNetwork,
  requirePathScope,
  requireTool,
} from "../src/capabilities.ts";

const user = { type: "user" as const };
const agent = { type: "agent" as const, name: "reviewer" };

describe("callerLabel", () => {
  test("formats each identity kind distinctly", () => {
    expect(callerLabel(user)).toBe("user");
    expect(callerLabel(agent)).toBe("agent:reviewer");
    expect(callerLabel({ type: "plugin", id: "ast-grep" })).toBe("plugin:ast-grep");
  });
});

describe("requireTool", () => {
  test("allows a tool explicitly listed", () => {
    const caps: Capabilities = { tools: ["read", "grep"], pathScopes: [], network: "none" };
    expect(() => requireTool(user, caps, "read")).not.toThrow();
  });

  test("denies a tool not listed, with PERMISSION_DENIED", () => {
    const caps: Capabilities = { tools: ["read"], pathScopes: [], network: "none" };
    const err = (() => {
      try {
        requireTool(agent, caps, "bash");
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(AgencyError);
    expect((err as AgencyError).code).toBe(ErrorCode.PERMISSION_DENIED);
    expect((err as AgencyError).source).toBe("agent:reviewer");
  });

  test("'*' allows any tool", () => {
    expect(() => requireTool(user, FULL_CAPABILITIES, "anything")).not.toThrow();
  });

  test("NO_CAPABILITIES denies everything", () => {
    expect(() => requireTool(user, NO_CAPABILITIES, "read")).toThrow(AgencyError);
  });
});

describe("requirePathScope", () => {
  const caps: Capabilities = { tools: "*", pathScopes: ["/home/user/project"], network: "none" };

  test("allows a path inside an allowed scope", () => {
    expect(() => requirePathScope(user, caps, "/home/user/project/src/index.ts")).not.toThrow();
  });

  test("allows the scope root itself", () => {
    expect(() => requirePathScope(user, caps, "/home/user/project")).not.toThrow();
  });

  test("denies a path outside every scope", () => {
    expect(() => requirePathScope(user, caps, "/home/user/other-project/secrets.env")).toThrow(AgencyError);
  });

  test("denies a sibling directory that merely shares a prefix", () => {
    // /home/user/project-evil must NOT match scope /home/user/project
    expect(() => requirePathScope(user, caps, "/home/user/project-evil/file")).toThrow(AgencyError);
  });

  test("normalizes Windows backslashes before comparing", () => {
    const winCaps: Capabilities = { tools: "*", pathScopes: ["C:\\Users\\pixel\\agency"], network: "none" };
    expect(() => requirePathScope(user, winCaps, "C:\\Users\\pixel\\agency\\src\\index.ts")).not.toThrow();
  });

  test("'*' allows any path, including a Windows drive-letter path a POSIX-style prefix would miss", () => {
    const wildcard: Capabilities = { tools: "*", pathScopes: "*", network: "none" };
    expect(() => requirePathScope(user, wildcard, "C:\\Users\\pixel\\agency\\src\\index.ts")).not.toThrow();
    expect(() => requirePathScope(user, wildcard, "/home/user/anything")).not.toThrow();
  });
});

describe("requireNetwork", () => {
  test("'none' denies every host", () => {
    expect(() =>
      requireNetwork(user, { tools: [], pathScopes: [], network: "none" }, "api.anthropic.com"),
    ).toThrow(AgencyError);
  });

  test("'*' allows any host", () => {
    expect(() => requireNetwork(user, FULL_CAPABILITIES, "anything.example.com")).not.toThrow();
  });

  test("an explicit list allows only listed hosts", () => {
    const caps: Capabilities = { tools: [], pathScopes: [], network: ["api.anthropic.com"] };
    expect(() => requireNetwork(user, caps, "api.anthropic.com")).not.toThrow();
    expect(() => requireNetwork(user, caps, "evil.example.com")).toThrow(AgencyError);
  });
});

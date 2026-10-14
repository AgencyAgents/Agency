import { expect, test } from "bun:test";
import type { ToolSpec } from "@agency/core";
import type { PermissionsGate } from "@agency/guard";
import { sessionToolsFor } from "../src/daemon/handlers/session.ts";

const tool = (name: string): ToolSpec => ({
  name,
  description: name,
  inputSchema: { type: "object", properties: {} },
  handler: async () => ({ content: "" }),
});

test("a caller with a denied tool can still call the tools that the harness adds to a turn", () => {
  const gate = { toolOffered: (name: string) => name !== "write" } as unknown as PermissionsGate;
  const names = sessionToolsFor([tool("read"), tool("write")], gate);
  expect(names).toContain("read");
  expect(names).not.toContain("write");
  // Live: with `write` denied in the config, structured_output was refused as "outside this caller's allowed tools".
  for (const added of ["structured_output", "tool_search", "call_tool", "code"])
    expect(names).toContain(added);
  expect(sessionToolsFor([tool("read")], gate)).toBe("*");
});

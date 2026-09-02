import { describe, expect, test } from "bun:test";
import { FULL_CAPABILITIES } from "@agency/guard";
import {
  type AdaptOptions,
  adaptMcpTool,
  type McpToolDefinition,
  renderMcpContent,
} from "../../src/mcp/adapt.ts";
import type { McpClient } from "../../src/mcp/client.ts";

const OPTIONS: AdaptOptions = {
  serverName: "srv",
  riskTier: "moderate",
  identity: { type: "agent", name: "main" },
  capabilities: FULL_CAPABILITIES,
};

function clientReturning(content: unknown, isError = false): McpClient {
  return { callTool: async () => ({ content, isError }) } as unknown as McpClient;
}

describe("renderMcpContent", () => {
  test("joins text blocks with newlines", () => {
    expect(
      renderMcpContent([
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ]),
    ).toBe("first\nsecond");
  });

  test("extracts the text of an embedded resource block", () => {
    expect(
      renderMcpContent([
        {
          type: "resource",
          resource: { uri: "file:///x.txt", mimeType: "text/plain", text: "file body" },
        },
      ]),
    ).toBe("file body");
  });

  test("JSON-stringifies blocks without extractable text (image, blob resource)", () => {
    const image = { type: "image", data: "aGk=", mimeType: "image/png" };
    const blob = { type: "resource", resource: { uri: "file:///a.bin", blob: "aGk=" } };
    expect(renderMcpContent([image, blob])).toBe(`${JSON.stringify(image)}\n${JSON.stringify(blob)}`);
  });

  test("handles empty, missing, non-array, and scalar content", () => {
    expect(renderMcpContent(undefined)).toBe("");
    expect(renderMcpContent(null)).toBe("");
    expect(renderMcpContent([])).toBe("");
    expect(renderMcpContent("plain")).toBe("plain");
    expect(renderMcpContent(7)).toBe("7");
  });

  test("a text block with a non-string text falls back to JSON", () => {
    const block = { type: "text", text: 42 };
    expect(renderMcpContent([block])).toBe(JSON.stringify(block));
  });
});

describe("adaptMcpTool handler", () => {
  const def: McpToolDefinition = { name: "greet", description: "say hi" };

  test("renders MCP content blocks as text, not [object Object]", async () => {
    const spec = adaptMcpTool(clientReturning([{ type: "text", text: "hello world" }]), def, OPTIONS);
    const result = await spec.handler({ who: "world" }, { signal: new AbortController().signal });
    expect(result.content).toBe("hello world");
    expect(result.isError).toBe(false);
  });

  test("structured resource results keep their content", async () => {
    const spec = adaptMcpTool(
      clientReturning([{ type: "resource", resource: { uri: "config://x", text: "cfg" } }]),
      def,
      OPTIONS,
    );
    const result = await spec.handler({}, { signal: new AbortController().signal });
    expect(result.content).not.toContain("[object Object]");
    expect(result.content).toBe("cfg");
  });

  test("isError passes through and undefined content renders as empty", async () => {
    const spec = adaptMcpTool(clientReturning(undefined, true), def, OPTIONS);
    const result = await spec.handler({}, { signal: new AbortController().signal });
    expect(result.content).toBe("");
    expect(result.isError).toBe(true);
  });
});

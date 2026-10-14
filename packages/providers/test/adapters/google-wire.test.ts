import { describe, expect, test } from "bun:test";
import type { HttpClient } from "@agency/net";
import type { Message } from "@agency/schema";
import { googleAdapter } from "../../src/adapters/google.ts";
import type { ProviderRequest } from "../../src/types.ts";

/** The request part of Google's own description of the API (its discovery document), without the description text. */
interface Node {
  $ref?: string;
  type?: string;
  properties?: Record<string, Node>;
  items?: Node;
  additionalProperties?: Node;
  enum?: string[];
  format?: string;
}
const description = (await Bun.file(
  `${import.meta.dir}/../cassettes/gemini-v1beta-request-schema.json`,
).json()) as { revision: string; schemas: Record<string, Node> };

/** What the API rejects before the model sees the request: a field it does not know, a wrong type, a value outside an enum. */
function problems(value: unknown, schema: Node, path: string): string[] {
  const node = schema.$ref ? (description.schemas[schema.$ref] as Node) : schema;
  const is = (kind: string) => [`${path}: not ${kind}`];
  switch (node.type) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return is("an object");
      return Object.entries(value).flatMap(([key, item]) => {
        const known = node.properties ? node.properties[key] : node.additionalProperties;
        if (known) return problems(item, known, `${path}.${key}`);
        // No field list means a free-form object, as the arguments of a call are.
        return node.properties ? [`${path}.${key}: unknown field`] : [];
      });
    }
    case "array":
      if (!Array.isArray(value)) return is("an array");
      return value.flatMap((item, i) => problems(item, node.items as Node, `${path}[${i}]`));
    case "string": {
      if (typeof value !== "string") return is("a string");
      // Google's own REST examples write the schema types in lower case.
      const inEnum = !node.enum || node.enum.includes(value) || node.enum.includes(value.toUpperCase());
      return inEnum ? [] : [`${path}: ${value} is not one of ${node.enum?.join(", ")}`];
    }
    case "integer":
    case "number":
      return typeof value === "number" ? [] : is("a number");
    case "boolean":
      return typeof value === "boolean" ? [] : is("a boolean");
    default:
      return [];
  }
}

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const tools = [
  {
    name: "read",
    description: "Reads a file.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, limit: { type: "integer", minimum: 1 } },
      required: ["path"],
    },
  },
  {
    name: "mcp_note",
    description: "A tool with the schema of an MCP server.",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { note: { type: ["string", "null"] } },
      additionalProperties: false,
    },
  },
];
const turnWithTools: Message[] = [
  {
    role: "user",
    content: [
      { type: "text", text: "Read both files." },
      { type: "image", mimeType: "image/png", data: PNG },
    ],
  },
  {
    role: "assistant",
    content: [
      { type: "text", text: "I read them." },
      { type: "tool_call", id: "call_a", name: "read", input: { path: "a.txt" } },
      { type: "thinking", text: "", signature: "c2ln", family: "google" },
      { type: "tool_call", id: "call_b", name: "read", input: { path: "b.png" } },
    ],
  },
  {
    role: "user",
    content: [
      { type: "tool_result", toolCallId: "call_a", content: "alpha", isError: false },
      {
        type: "tool_result",
        toolCallId: "call_b",
        content: "an image",
        isError: true,
        images: [{ type: "image", mimeType: "image/png", data: PNG }],
      },
    ],
  },
  { role: "assistant", content: [{ type: "text", text: "Done." }] },
  { role: "user", content: [{ type: "text", text: "Why?" }] },
];
const stable = `Team rules. ${"Stable instruction text for the cache. ".repeat(260)}`;

const base: ProviderRequest = {
  model: "gemini-2.5-pro",
  apiKey: "key-test",
  system: "You are a coding agent.",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  maxTokens: 8192,
};
const requests: Record<string, Partial<ProviderRequest>> = {
  plain: {},
  tools: { tools },
  "a turn with tool calls, results, an image and a signature": {
    tools,
    messages: turnWithTools,
    vision: true,
  },
  temperature: { temperature: 0.2 },
  "thinking off": { thinkingLevel: "off" },
  "thinking high": { thinkingLevel: "high", model: "gemini-3.1-pro" },
  "thinking max": { thinkingLevel: "max", model: "gemini-2.5-flash" },
  "a cached prefix": {
    tools,
    messages: turnWithTools,
    system: `${stable}\n\nToday is Sunday.`,
    systemSegments: [
      { stability: "shared", text: stable },
      { stability: "dynamic", text: "Today is Sunday." },
    ],
  },
};

async function sent(request: Partial<ProviderRequest>): Promise<{ root: string; body: unknown }[]> {
  const bodies: { root: string; body: unknown }[] = [];
  const http: HttpClient = {
    fetch: async (url, init) => {
      const create = url.includes("/cachedContents");
      bodies.push({
        root: create ? "CachedContent" : "GenerateContentRequest",
        body: JSON.parse(init?.body as string),
      });
      return create ? Response.json({ name: "cachedContents/abc" }) : new Response("");
    },
  };
  for await (const _ of googleAdapter.stream({ ...base, ...request }, http)) void _;
  return bodies;
}

describe(`Gemini request bodies against Google's API description (revision ${description.revision})`, () => {
  test.each(Object.keys(requests))("%s", async (name) => {
    const bodies = await sent(requests[name] as Partial<ProviderRequest>);
    expect(bodies.length).toBeGreaterThan(0);
    for (const { root, body } of bodies) expect(problems(body, { $ref: root }, root)).toEqual([]);
  });

  test("the cached prefix case sends both a cache and a request that uses it", async () => {
    // Another model, because the adapter keeps the cache name of the case above.
    const bodies = await sent({ ...requests["a cached prefix"], model: "gemini-2.5-flash" });
    expect(bodies.map((b) => b.root)).toEqual(["CachedContent", "GenerateContentRequest"]);
  });

  test("the check finds a field that the API does not know, at the top and inside a tool schema", () => {
    const wrong = {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      systemInstructions: { parts: [{ text: "s" }] },
      generationConfig: { maxOutputTokens: "many" },
      tools: [{ functionDeclarations: [{ name: "x", parameters: { $schema: "s", type: "tuple" } }] }],
    };
    expect(problems(wrong, { $ref: "GenerateContentRequest" }, "request")).toEqual([
      "request.systemInstructions: unknown field",
      "request.generationConfig.maxOutputTokens: not a number",
      "request.tools[0].functionDeclarations[0].parameters.$schema: unknown field",
      "request.tools[0].functionDeclarations[0].parameters.type: tuple is not one of TYPE_UNSPECIFIED, STRING, NUMBER, INTEGER, BOOLEAN, ARRAY, OBJECT, NULL",
    ]);
  });
});

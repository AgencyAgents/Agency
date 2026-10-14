import { expect, test } from "bun:test";
import { FULL_CAPABILITIES, SandboxBoundary } from "@agency/guard";
import type { HttpClient } from "@agency/net";
import { createWebSearchTool } from "../src/builtins/websearch.ts";

const deps = {
  identity: { type: "user" as const },
  capabilities: FULL_CAPABILITIES,
  sandbox: new SandboxBoundary(process.cwd()),
};
const ctx = { signal: new AbortController().signal };

/** OpenRouter's web plugin answers with the results as `url_citation` annotations, as measured on its API. */
function openRouter(reply: { status?: number; body: unknown }) {
  const requests: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const http: HttpClient = {
    async fetch(url, init) {
      requests.push({
        url,
        headers: init?.headers as Record<string, string>,
        body: JSON.parse(String(init?.body)),
      });
      return Response.json(reply.body, { status: reply.status ?? 200 });
    },
  };
  return { http, requests };
}

const citation = (title: string, url: string, content: string) => ({
  type: "url_citation",
  url_citation: { url, title, content, start_index: 0, end_index: 0 },
});

test("with no endpoint, websearch asks OpenRouter's web plugin and gives title, URL and an excerpt of each result", async () => {
  const { http, requests } = openRouter({
    body: {
      choices: [
        {
          message: {
            content: null,
            annotations: [
              citation("Bun 1.4 | Bun Blog", "https://bun.com/blog/bun-v1.4", "Bun 1.4 adds\n\n  bytecode"),
              citation("Releases", "https://github.com/oven-sh/bun/releases", "x".repeat(5000)),
            ],
          },
        },
      ],
    },
  });
  const tool = createWebSearchTool(deps, http, {
    openrouter: {
      baseUrl: "https://openrouter.ai/api/v1/",
      model: "cheap/model",
      apiKey: async () => "sk-test",
    },
  });
  const result = await tool.handler({ query: "bun 1.4" }, ctx);
  expect(result.isError).toBeUndefined();
  expect(result.content).toContain(
    "1. Bun 1.4 | Bun Blog\n   https://bun.com/blog/bun-v1.4\n   Bun 1.4 adds bytecode",
  );
  expect(result.content).toContain("2. Releases");
  expect(result.content.length).toBeLessThan(3000);

  const [request] = requests;
  expect(request?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
  expect(request?.headers.authorization).toBe("Bearer sk-test");
  expect(request?.body).toMatchObject({
    model: "cheap/model",
    messages: [{ role: "user", content: "bun 1.4" }],
    plugins: [{ id: "web", max_results: 5 }],
  });
});

test("no key, an error of the API, and an answer with no result each give a plain message", async () => {
  const none = createWebSearchTool(deps, openRouter({ body: {} }).http, {
    openrouter: { baseUrl: "https://openrouter.ai/api/v1", model: "m", apiKey: async () => undefined },
  });
  expect((await none.handler({ query: "q" }, ctx)).content).toContain(
    "needs the key of the openrouter provider",
  );

  const failed = createWebSearchTool(
    deps,
    openRouter({ status: 402, body: { error: { message: "Insufficient credits" } } }).http,
    {
      openrouter: {
        baseUrl: "https://openrouter.ai/api/v1",
        model: "m",
        apiKey: async () => "sk-secret-key",
      },
    },
  );
  const error = await failed.handler({ query: "q" }, ctx);
  expect(error.isError).toBe(true);
  expect(error.content).toContain("402");
  expect(error.content).toContain("Insufficient credits");
  expect(error.content).not.toContain("sk-secret-key");

  const empty = createWebSearchTool(
    deps,
    openRouter({ body: { choices: [{ message: { content: "x" } }] } }).http,
    {
      openrouter: { baseUrl: "https://openrouter.ai/api/v1", model: "m", apiKey: async () => "k" },
    },
  );
  expect((await empty.handler({ query: "q" }, ctx)).content).toBe("(no results)");
});

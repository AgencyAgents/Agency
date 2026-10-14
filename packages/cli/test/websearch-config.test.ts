import { afterEach, expect, test } from "bun:test";
import { loadConfig } from "@agency/core";
import { webSearchFor } from "../src/daemon/session-scopes.ts";
import type { DaemonContext } from "../src/daemon/types.ts";

const names = ["AGENCY_OPENROUTER_API_KEY", "OPENROUTER_API_KEY"];
const saved = names.map((name) => process.env[name]);
afterEach(() => {
  names.forEach((name, i) => {
    if (saved[i] === undefined) delete process.env[name];
    else process.env[name] = saved[i];
  });
});

const ctx = (providers: DaemonContext["providers"] = {}) =>
  ({ providers, getKeychain: async () => undefined }) as unknown as DaemonContext;
const config = (flags: Record<string, unknown> = {}) => loadConfig({ env: {}, flags });

test("search goes to the configured endpoint, else to OpenRouter when it has a key, else there is no search", async () => {
  for (const name of names) delete process.env[name];
  expect(await webSearchFor(config(), ctx())).toBeUndefined();

  process.env.OPENROUTER_API_KEY = "sk-or-test";
  const viaOpenRouter = await webSearchFor(
    config(),
    ctx({ openrouter: { baseUrl: "https://gw.example/v1" } }),
  );
  expect(viaOpenRouter && "openrouter" in viaOpenRouter ? viaOpenRouter.openrouter.baseUrl : "").toBe(
    "https://gw.example/v1",
  );
  if (viaOpenRouter && "openrouter" in viaOpenRouter) {
    expect(viaOpenRouter.openrouter.model).toBe("deepseek/deepseek-v4-flash");
    expect(await viaOpenRouter.openrouter.apiKey()).toBe("sk-or-test");
  }

  const custom = await webSearchFor(config({ websearch: { model: "other/model" } }), ctx());
  expect(custom && "openrouter" in custom ? custom.openrouter.model : "").toBe("other/model");

  const endpoint = await webSearchFor(config({ websearch: { endpoint: "https://search.example/q" } }), ctx());
  expect(endpoint).toEqual({ endpoint: "https://search.example/q" });
});

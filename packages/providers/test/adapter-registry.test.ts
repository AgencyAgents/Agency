import { describe, expect, test } from "bun:test";
import {
  anthropicAdapter,
  createOpenAiCompatibleAdapter,
  DuplicateAdapterError,
  googleAdapter,
  InvalidAdapterError,
  listAdapterFamilies,
  openaiAdapter,
  registerAdapter,
  registerAdapterFactory,
  resolveAdapterByApiNpm,
  resolveAdapterByFamily,
  UnknownProviderError,
} from "../src/index.ts";
import type { ProviderAdapter } from "../src/types.ts";

function fakeAdapter(family: string): ProviderAdapter {
  return { family, stream: async function* () {} };
}

describe("adapter registry", () => {
  test("builtin families resolve to the identical adapter instances", () => {
    expect(resolveAdapterByFamily("anthropic")).toBe(anthropicAdapter);
    expect(resolveAdapterByFamily("openai")).toBe(openaiAdapter);
    expect(resolveAdapterByFamily("google")).toBe(googleAdapter);
  });

  test("builtin adapters conform structurally: non-empty family, callable stream", () => {
    for (const adapter of [
      resolveAdapterByFamily("anthropic"),
      resolveAdapterByFamily("openai"),
      resolveAdapterByFamily("google"),
      resolveAdapterByFamily("openai-compatible", { baseUrl: "https://example.com/v1" }),
    ]) {
      expect(typeof adapter.family).toBe("string");
      expect(adapter.family.length).toBeGreaterThan(0);
      expect(typeof adapter.stream).toBe("function");
      expect(typeof adapter.stream.call).toBe("function");
    }
  });

  test("openai-compatible factory registers through the same path", () => {
    expect(listAdapterFamilies()).toContain("openai-compatible");
    const built = resolveAdapterByFamily("openai-compatible", { baseUrl: "https://example.com/v1" });
    expect(built.family).toBe("openai-compatible");
    expect(typeof built.stream).toBe("function");
    const direct = createOpenAiCompatibleAdapter("openai-compatible", "https://example.com/v1");
    expect(built.family).toBe(direct.family);
  });

  test("unknown gateway family with a baseUrl builds via the template, uncached", () => {
    const first = resolveAdapterByFamily("test-gateway-registry", { baseUrl: "https://gw.example.com/v1" });
    expect(first.family).toBe("test-gateway-registry");
    expect(typeof first.stream).toBe("function");
    expect(
      resolveAdapterByFamily("test-gateway-registry", { baseUrl: "https://gw.example.com/v1" }),
    ).not.toBe(first);
  });

  test("duplicate registration throws typed errors", () => {
    expect(() => registerAdapter(fakeAdapter("anthropic"))).toThrow(DuplicateAdapterError);
    expect(() => registerAdapterFactory("openai", () => fakeAdapter("openai"))).toThrow(
      DuplicateAdapterError,
    );
    expect(() => registerAdapterFactory("openai-compatible", () => fakeAdapter("openai-compatible"))).toThrow(
      DuplicateAdapterError,
    );
    const fresh = fakeAdapter("test-dup-family");
    registerAdapter(fresh);
    expect(() => registerAdapter(fakeAdapter("test-dup-family"))).toThrow(DuplicateAdapterError);
  });

  test("malformed adapters rejected at registration with typed errors", () => {
    expect(() => registerAdapter(null as unknown as ProviderAdapter)).toThrow(InvalidAdapterError);
    expect(() =>
      registerAdapter({ family: "", stream: async function* () {} } as unknown as ProviderAdapter),
    ).toThrow(InvalidAdapterError);
    expect(() => registerAdapter({ family: "test-no-stream" } as unknown as ProviderAdapter)).toThrow(
      InvalidAdapterError,
    );
    expect(() =>
      registerAdapter({ family: "test-bad-stream", stream: "nope" } as unknown as ProviderAdapter),
    ).toThrow(InvalidAdapterError);
    expect(() => registerAdapterFactory("", () => fakeAdapter(""))).toThrow(InvalidAdapterError);
  });

  test("unknown family lookup throws UnknownProviderError naming the id", () => {
    expect(() => resolveAdapterByFamily("test-no-such-family")).toThrow(UnknownProviderError);
    expect(() => resolveAdapterByFamily("test-no-such-family")).toThrow("test-no-such-family");
    expect(() => resolveAdapterByApiNpm("test-no-such-npm")).toThrow(UnknownProviderError);
  });

  test("apiNpm aliases resolve through both lookups", () => {
    registerAdapter(fakeAdapter("test-npm-family"), { apiNpm: ["test-npm-alias"] });
    expect(resolveAdapterByApiNpm("test-npm-alias").family).toBe("test-npm-family");
    expect(resolveAdapterByFamily("test-npm-alias").family).toBe("test-npm-family");
    expect(() => registerAdapter(fakeAdapter("test-npm-other"), { apiNpm: ["test-npm-alias"] })).toThrow(
      DuplicateAdapterError,
    );
  });

  test("adversarial inputs: case is exact, slash families work, empty lookup is unknown", () => {
    expect(() => resolveAdapterByFamily("Anthropic")).toThrow(UnknownProviderError);
    expect(() => resolveAdapterByFamily("OPENAI")).toThrow(UnknownProviderError);
    registerAdapter(fakeAdapter("test/slash-family"));
    expect(resolveAdapterByFamily("test/slash-family").family).toBe("test/slash-family");
    expect(() => resolveAdapterByFamily("")).toThrow(UnknownProviderError);
    expect(() => resolveAdapterByFamily("openai-compatible")).toThrow("baseUrl");
  });
});

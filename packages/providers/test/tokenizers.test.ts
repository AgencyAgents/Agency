import { describe, expect, test } from "bun:test";
import {
  createApproximateTokenizer,
  createOpenAiCompatibleTokenizer,
  createOpenAiTokenizer,
  isAsyncTokenizer,
  tokenizerFor,
} from "../src/tokenizers/index.ts";

describe("createOpenAiTokenizer", () => {
  test("produces an exact BPE count for known text", () => {
    const tokenizer = createOpenAiTokenizer();
    expect(tokenizer.precise).toBe(true);
    // "Hello, world!" is a stable, well-known token count under o200k_base.
    expect(tokenizer.count("Hello, world!")).toBe(4);
  });

  test("counts an empty string as zero tokens", () => {
    expect(createOpenAiTokenizer().count("")).toBe(0);
  });
});

describe("createOpenAiCompatibleTokenizer", () => {
  test("is explicitly marked imprecise", () => {
    expect(createOpenAiCompatibleTokenizer().precise).toBe(false);
  });

  test("uses char/4 approximation", () => {
    const tokenizer = createOpenAiCompatibleTokenizer();
    expect(tokenizer.count("a".repeat(40))).toBe(10); // 40/4 = 10
    expect(tokenizer.count("a".repeat(41))).toBe(11); // ceil(41/4) = 11
  });

  test("counts an empty string as zero tokens", () => {
    expect(createOpenAiCompatibleTokenizer().count("")).toBe(0);
  });
});

describe("createApproximateTokenizer", () => {
  test("is explicitly marked imprecise", () => {
    expect(createApproximateTokenizer().precise).toBe(false);
  });

  test("scales roughly with text length using the configured ratio", () => {
    const tokenizer = createApproximateTokenizer(4);
    expect(tokenizer.count("a".repeat(40))).toBe(10);
  });

  test("counts an empty string as zero tokens", () => {
    expect(createApproximateTokenizer().count("")).toBe(0);
  });
});

describe("isAsyncTokenizer", () => {
  test("returns false for sync tokenizers", () => {
    expect(isAsyncTokenizer(createOpenAiTokenizer())).toBe(false);
    expect(isAsyncTokenizer(createOpenAiCompatibleTokenizer())).toBe(false);
    expect(isAsyncTokenizer(createApproximateTokenizer())).toBe(false);
  });

  test("returns true for objects with async: true marker", () => {
    const asyncTokenizer = {
      precise: true,
      async: true as const,
      async count(_text: string): Promise<number> {
        return 0;
      },
    };
    expect(isAsyncTokenizer(asyncTokenizer)).toBe(true);
  });
});

describe("tokenizerFor", () => {
  test("routes openai to the BPE tokenizer", () => {
    const t = tokenizerFor("openai");
    expect(t.precise).toBe(true);
    expect(t.count("Hello, world!")).toBe(4);
  });

  test("routes openai-compatible to the char/4 approximate tokenizer", () => {
    const t = tokenizerFor("openai-compatible");
    expect(t.precise).toBe(false);
    expect(t.count("a".repeat(40))).toBe(10);
  });

  test("routes anthropic to the char/4 approximate tokenizer", () => {
    const t = tokenizerFor("anthropic");
    expect(t.precise).toBe(false);
    expect(t.count("a".repeat(40))).toBe(10);
  });

  test("routes google to the char/4 approximate tokenizer", () => {
    const t = tokenizerFor("google");
    expect(t.precise).toBe(false);
    expect(t.count("a".repeat(40))).toBe(10);
  });

  test("routes unknown families to the default approximate tokenizer (char/3.5)", () => {
    const t = tokenizerFor("unknown-provider");
    expect(t.precise).toBe(false);
    // 40/3.5 ≈ 11.43 → ceil = 12
    expect(t.count("a".repeat(40))).toBe(12);
  });
});

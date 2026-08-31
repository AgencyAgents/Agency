import { describe, expect, test } from "bun:test";
import { createOpenAiTokenizer, createApproximateTokenizer, tokenizerFor } from "../src/tokenizers/index.ts";

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

describe("tokenizerFor", () => {
  test("routes openai and openai-compatible families to the precise tokenizer", () => {
    expect(tokenizerFor("openai").precise).toBe(true);
    expect(tokenizerFor("openai-compatible").precise).toBe(true);
  });

  test("routes anthropic and google to the approximate tokenizer", () => {
    expect(tokenizerFor("anthropic").precise).toBe(false);
    expect(tokenizerFor("google").precise).toBe(false);
  });
});

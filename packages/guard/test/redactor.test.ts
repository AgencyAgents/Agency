import { describe, expect, test } from "bun:test";
import { Redactor } from "../src/redactor.ts";

describe("Redactor", () => {
  test("redacts a registered secret wherever it appears", () => {
    const redactor = new Redactor();
    redactor.registerSecret("sk-super-secret-value");

    const result = redactor.redact('{"level":"debug","apiKey":"sk-super-secret-value"}');

    expect(result).not.toContain("sk-super-secret-value");
    expect(result).toContain("[REDACTED]");
  });

  test("redacts every occurrence, not just the first", () => {
    const redactor = new Redactor();
    redactor.registerSecret("topsecret");

    const result = redactor.redact("topsecret appears twice: topsecret");

    expect(result.split("[REDACTED]")).toHaveLength(3);
    expect(result).not.toContain("topsecret");
  });

  test("redacts a known Anthropic key shape even when never registered", () => {
    const redactor = new Redactor();
    const result = redactor.redact("Authorization: sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890");
    expect(result).not.toContain("sk-ant-");
    expect(result).toContain("[REDACTED]");
  });

  test("redacts a known OpenAI key shape even when never registered", () => {
    const redactor = new Redactor();
    const result = redactor.redact("using key sk-abcdefghijklmnopqrstuvwxyz123456");
    expect(result).toContain("[REDACTED]");
  });

  test("leaves unrelated text untouched", () => {
    const redactor = new Redactor();
    redactor.registerSecret("sk-something");
    expect(redactor.redact("hello world")).toBe("hello world");
  });

  test("ignores tiny values to avoid mass-redacting common substrings", () => {
    const redactor = new Redactor();
    redactor.registerSecret("ok"); // too short to be a real secret
    expect(redactor.redact("this is ok, totally ok")).toBe("this is ok, totally ok");
  });

  test("integrates with a logger sink to keep secrets out of log output", () => {
    const redactor = new Redactor();
    redactor.registerSecret("sk-ant-real-key-value");
    const lines: string[] = [];
    const redactingSink = (line: string) => lines.push(redactor.redact(line));

    redactingSink(JSON.stringify({ message: "connected", key: "sk-ant-real-key-value" }));

    expect(lines[0]).not.toContain("sk-ant-real-key-value");
  });
});

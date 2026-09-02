import { describe, expect, test } from "bun:test";
import { AgencyError, ErrorCode } from "../src/errors.ts";

describe("AgencyError", () => {
  test("carries retry classification per code", () => {
    const rateLimited = new AgencyError(ErrorCode.RATE_LIMIT, "429", { source: "anthropic" });
    expect(rateLimited.isRetryable).toBe(true);
    expect(rateLimited.retryClass).toBe("retryable");

    const auth = new AgencyError(ErrorCode.AUTH, "401", { source: "anthropic" });
    expect(auth.isRetryable).toBe(false);
    expect(auth.retryClass).toBe("fatal");

    const toolError = new AgencyError(ErrorCode.TOOL_ERROR, "edit rejected: text not found", {
      source: "edit",
    });
    expect(toolError.isRetryable).toBe(true);
    expect(toolError.retryClass).toBe("retryable");
  });

  test("resolves a stable i18n message key, not a hardcoded string", () => {
    const overflow = new AgencyError(ErrorCode.CONTEXT_OVERFLOW, "too many tokens", {
      source: "core",
    });
    expect(overflow.messageKey).toBe("error.context_overflow");
  });

  test("chains the underlying cause for debug bundles", () => {
    const cause = new Error("ECONNRESET");
    const wrapped = new AgencyError(ErrorCode.NETWORK, "connection reset", {
      source: "net",
      cause,
    });
    expect(wrapped.cause).toBe(cause);
    expect(wrapped.source).toBe("net");
  });

  test("carries structured context without leaking it into the message", () => {
    const err = new AgencyError(ErrorCode.RATE_LIMIT, "rate limited", {
      source: "openai",
      context: { statusCode: 429, retryAfterMs: 2000 },
    });
    expect(err.context).toEqual({ statusCode: 429, retryAfterMs: 2000 });
    expect(err.message).toBe("rate limited");
  });
});

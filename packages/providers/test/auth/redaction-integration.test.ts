import { describe, expect, test } from "bun:test";
import { Logger } from "@agency/core";
import { Redactor } from "@agency/guard";
import { resolveApiKey } from "../../src/auth/resolve.ts";

/**
 * End-to-end proof of P2's stated requirement: a key resolved through the
 * normal auth path never reaches a log line unredacted, once the caller
 * wires the Redactor into the Logger's sink as documented.
 */
describe("resolved API keys stay out of logs", () => {
  test("a key from resolveApiKey is redacted when logged through a wired sink", async () => {
    const apiKey = await resolveApiKey({
      provider: "anthropic",
      env: { AGENCY_ANTHROPIC_API_KEY: "sk-ant-do-not-leak-this-value" },
    });
    expect(apiKey).toBe("sk-ant-do-not-leak-this-value");

    const redactor = new Redactor();
    redactor.registerSecret(apiKey!);

    const lines: string[] = [];
    const logger = new Logger({ sink: (line) => lines.push(redactor.redact(line)) });

    logger.info("connected to provider", { provider: "anthropic", apiKey });

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("sk-ant-do-not-leak-this-value");
    expect(lines[0]).toContain("[REDACTED]");
  });

  test("a key never registered still gets caught by the known-shape pattern", async () => {
    const apiKey = await resolveApiKey({
      provider: "anthropic",
      env: { AGENCY_ANTHROPIC_API_KEY: "sk-ant-api03-never-registered-1234567890" },
    });

    // Simulates a bug where the caller forgot to register the secret:
    // pattern-based redaction is the safety net, not the primary mechanism.
    const redactor = new Redactor();
    const lines: string[] = [];
    const logger = new Logger({ level: "debug", sink: (line) => lines.push(redactor.redact(line)) });

    logger.debug("request failed", { apiKey });

    expect(lines[0]).not.toContain("never-registered");
  });
});

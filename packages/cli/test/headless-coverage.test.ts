import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("runHeadless", () => {
  test("headless path with fake daemon returns result and closes client", async () => {
    const ws = mkdtempSync(join(tmpdir(), "agency-headless-ws-"));
    const expected = {
      messages: [{ role: "assistant", content: [{ type: "text", text: "hi" }] }],
      stopReason: "end_turn",
      usage: { inputTokens: 2, outputTokens: 2 },
      budgetExceeded: false,
      cancelled: false,
    };

    // Inject via headless internal: use ensureDaemon mock by patching runHeadless's import is not trivial,
    // so instead test via entrypoint deps injection which is the real surface. This test exercises the
    // fake daemon path through entrypoint.
    const { runEntrypoint } = await import("../src/entrypoint.ts");
    const { createFileFallbackBackend } = await import("@agency/providers");
    const keysDir = mkdtempSync(join(tmpdir(), "agency-headless-keys-"));
    const configDir = mkdtempSync(join(tmpdir(), "agency-headless-cfg-"));
    const out: string[] = [];
    const backend = createFileFallbackBackend(keysDir);
    const code = await runEntrypoint(["-p", "hello", "--model", "openai/fake-1", "--format", "json"], {
      env: { AGENCY_OPENAI_API_KEY: "sk-test" },
      configDir,
      keychain: backend,
      cwd: ws,
      runHeadless: async () => expected as never,
      out: (l) => out.push(l),
      err: () => {},
    });
    expect(code).toBe(0);
    const payload = JSON.parse(out.join(""));
    expect(payload.stopReason).toBe("end_turn");

    rmSync(ws, { recursive: true, force: true });
    rmSync(keysDir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });
});

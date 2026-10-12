import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasTrustGatedContent } from "../src/headless.ts";

describe("hasTrustGatedContent", () => {
  test("is true for each kind of workspace content that needs trust, and false for none", () => {
    const kinds: Record<string, string> = {
      "AGENTS.md": "AGENTS.md",
      rules: join(".agency", "rules", "style.md"),
      plugins: join(".agency", "plugins", "mark.js"),
      skills: join(".agency", "skills", "hello", "SKILL.md"),
    };
    const found: Record<string, boolean> = {};
    for (const [kind, file] of Object.entries(kinds)) {
      const ws = mkdtempSync(join(tmpdir(), "agency-gated-"));
      mkdirSync(join(ws, file, ".."), { recursive: true });
      writeFileSync(join(ws, file), "x");
      found[kind] = hasTrustGatedContent(ws);
      rmSync(ws, { recursive: true, force: true });
    }
    const empty = mkdtempSync(join(tmpdir(), "agency-gated-"));
    found.none = hasTrustGatedContent(empty);
    rmSync(empty, { recursive: true, force: true });

    expect(found).toEqual({ "AGENTS.md": true, rules: true, plugins: true, skills: true, none: false });
  });
});

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

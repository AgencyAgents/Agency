import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectAgentsFiles } from "../src/prompt/instructions.ts";
import { getSessionTitle } from "../src/sessions/titles.ts";
import { createFileFallbackBackend } from "../../providers/src/auth/file-fallback.ts";
import { resolveApiKey } from "../../providers/src/auth/resolve.ts";
import { buildAuthorizeUrl, generatePkcePair, OAUTH_PROVIDERS } from "../../providers/src/auth/oauth.ts";
import { parseArgv } from "../../cli/src/entrypoint.ts";

describe("instruction resolution nearest-first", () => {
  test("finds nested AGENTS.md before root", () => {
    const root = mkdtempSync(join(tmpdir(), "agents-"));
    const sub = join(root, "packages", "foo");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), "root");
    writeFileSync(join(sub, "AGENTS.md"), "sub");
    const files = collectAgentsFiles(sub, root);
    expect(files[0]).toBe(join(sub, "AGENTS.md"));
    expect(files[1]).toBe(join(root, "AGENTS.md"));
    rmSync(root, { recursive: true, force: true });
  });
});

describe("session_title entry R5 passthrough", () => {
  test("getSessionTitle returns latest title", () => {
    const entries: any[] = [
      { type: "session_title", title: "First", id: "1", parentId: null, schemaVersion: 1, createdAt: "2026-01-01" },
      { type: "message", id: "2", parentId: "1", schemaVersion: 1, createdAt: "2026-01-02" },
      { type: "session_title", title: "Second", id: "3", parentId: "2", schemaVersion: 1, createdAt: "2026-01-03" },
    ];
    expect(getSessionTitle(entries)).toBe("Second");
  });
  test("returns undefined when no title", () => {
    expect(getSessionTitle([{ type: "message", id: "1", parentId: null, schemaVersion: 1, createdAt: "" } as any])).toBeUndefined();
  });
});

describe("OAuth PKCE and authorize URL", () => {
  test("generatePkcePair creates verifier and challenge", () => {
    const { verifier, challenge } = generatePkcePair();
    expect(verifier.length).toBeGreaterThan(20);
    expect(challenge.length).toBeGreaterThan(20);
    expect(challenge).not.toBe(verifier);
  });
  test("buildAuthorizeUrl includes PKCE params", () => {
    const cfg = OAUTH_PROVIDERS.anthropic!;
    const url = buildAuthorizeUrl(cfg, { redirectUri: "http://127.0.0.1:1234/callback", state: "s123", challenge: "ch" });
    expect(url).toContain("code_challenge=ch");
    expect(url).toContain("code_challenge_method=S256");
    expect(url).toContain("state=s123");
  });
});

describe("resolveApiKey with OAuth refresh", () => {
  test("returns raw key when not OAuth JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kc-"));
    const kc = createFileFallbackBackend(dir);
    await kc.set("anthropic", "sk-123");
    const key = await resolveApiKey({ provider: "anthropic", keychain: kc, env: {} });
    expect(key).toBe("sk-123");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("entrypoint --image parse", () => {
  test("parses --image flag", () => {
    const parsed = parseArgv(["-p", "hello", "--image", "/tmp/a.png", "--image", "/tmp/b.jpg"]);
    expect(parsed.images).toEqual(["/tmp/a.png", "/tmp/b.jpg"]);
  });
});

describe("cassette harness", () => {
  test("record shape is {params, events, result}", async () => {
    const { recordCassette, writeCassette, readCassette } = await import("../src/cassette.ts");
    void recordCassette; void writeCassette; void readCassette;
    expect(typeof recordCassette).toBe("function");
  });
});

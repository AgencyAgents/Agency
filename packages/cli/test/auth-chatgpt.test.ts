import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileFallbackBackend } from "@agency/providers";
import { type EntrypointDeps, runEntrypoint } from "../src/entrypoint.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ISSUER = "https://auth.openai.com";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

/** The auth server and model list of OpenAI, and a browser that agrees at once. */
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "agency-chatgpt-cli-"));
  dirs.push(dir);
  let nonce = "";
  const revoked: string[] = [];
  const chatgptFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/.well-known/openid-configuration")) {
      return Response.json({ jwks_uri: `${ISSUER}/jwks`, revocation_endpoint: `${ISSUER}/revoke` });
    }
    if (url === `${ISSUER}/jwks`)
      return Response.json({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k" }] });
    if (url === `${ISSUER}/revoke`) {
      revoked.push(String(init?.body));
      return new Response("");
    }
    if (url === "https://api.openai.com/v1/models") {
      return Response.json({ data: [{ slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list" }] });
    }
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const head = `${part({ alg: "RS256", kid: "k" })}.${part({ iss: ISSUER, aud: "oaiapp_7", sub: "u7", email: "me@example.com", nonce, exp: Date.now() / 1000 + 600 })}`;
    return Response.json({
      access_token: "a",
      refresh_token: "r",
      expires_in: 3600,
      scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
      id_token: `${head}.${sign("RSA-SHA256", Buffer.from(head), privateKey).toString("base64url")}`,
    });
  }) as typeof fetch;
  const out: string[] = [];
  const err: string[] = [];
  const deps: EntrypointDeps = {
    env: { ...process.env, AGENCY_HOME: dir },
    configDir: dir,
    keychain: createFileFallbackBackend(join(dir, "keys")),
    chatgptFetch,
    openUrl: async (address) => {
      const params = new URL(address).searchParams;
      nonce = params.get("nonce") ?? "";
      const back = new URL(params.get("redirect_uri") ?? "");
      back.searchParams.set("code", "c");
      back.searchParams.set("state", params.get("state") ?? "");
      back.searchParams.set("client_id", "oaiapp_7");
      await fetch(back);
    },
    out: (line) => void out.push(line),
    err: (line) => void err.push(line),
  };
  return { deps, out, err, revoked };
}

test("auth login chatgpt says Continue with ChatGPT, tells the plan notice once, and lists the models", async () => {
  const { deps, out } = setup();
  expect(await runEntrypoint(["auth", "login", "chatgpt"], deps)).toBe(0);
  expect(out).toEqual([
    "Continue with ChatGPT in the browser.",
    "You're using your ChatGPT plan. Eligible usage in this app uses your ChatGPT plan. Manage usage in your ChatGPT settings: https://chatgpt.com/settings/usage",
    "Signed in with ChatGPT as me@example.com.",
    "Models of your plan: chatgpt/gpt-5.5",
  ]);
  out.length = 0;
  expect(await runEntrypoint(["auth", "login", "chatgpt"], deps)).toBe(0);
  expect(out.join("\n")).not.toContain("You're using your ChatGPT plan");

  expect(await runEntrypoint(["auth", "list"], deps)).toBe(0);
  expect(out).toContain("chatgpt: connected");
});

test("auth logout chatgpt revokes the sign-in; anthropic --oauth is refused with the reason", async () => {
  const { deps, out, err, revoked } = setup();
  await runEntrypoint(["auth", "login", "chatgpt"], deps);
  expect(await runEntrypoint(["auth", "logout", "chatgpt"], deps)).toBe(0);
  expect(out.at(-1)).toBe("Signed out of ChatGPT, and the sign-in is revoked.");
  expect(revoked[0]).toContain("client_id=oaiapp_7");
  out.length = 0;
  await runEntrypoint(["auth", "list"], deps);
  expect(out).toContain("chatgpt: not connected");

  expect(await runEntrypoint(["auth", "login", "anthropic", "--oauth"], deps)).toBe(1);
  expect(err.at(-1)).toContain("Anthropic does not permit a Claude Pro or Max sign-in in other apps");
});

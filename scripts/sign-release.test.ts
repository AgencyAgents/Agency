import { describe, expect, test } from "bun:test";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checksumLine,
  ED25519_PKCS8_DER_LEN,
  ED25519_SIG_LEN,
  ED25519_SPKI_DER_LEN,
  privateKeyFromB64,
  publicKeyB64FromPrivate,
  signAsset,
} from "./sign-release.ts";

function freshKeypair(): { publicDer: Buffer; privateB64: string } {
  const kp = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });
  return { publicDer: kp.publicKey, privateB64: kp.privateKey.toString("base64") };
}

describe("sign-release key handling", () => {
  test("privateKeyFromB64 accepts a fresh ed25519 PKCS8 key", () => {
    const { privateB64 } = freshKeypair();
    const raw = Buffer.from(privateB64, "base64");
    expect(raw.length).toBe(ED25519_PKCS8_DER_LEN);
    expect(() => privateKeyFromB64(privateB64)).not.toThrow();
  });

  test("privateKeyFromB64 fails closed on bad input", () => {
    expect(() => privateKeyFromB64("!!!not-base64!!!")).toThrow();
    expect(() => privateKeyFromB64(Buffer.from("short").toString("base64"))).toThrow(/length/);
  });

  test("derived public key is SPKI DER b64 for embedding", () => {
    const { privateB64 } = freshKeypair();
    const pubB64 = publicKeyB64FromPrivate(privateKeyFromB64(privateB64));
    const der = Buffer.from(pubB64, "base64");
    expect(der.length).toBe(ED25519_SPKI_DER_LEN);
    expect(der.toString("hex").startsWith("302a300506032b6570032100")).toBe(true);
  });
});

describe("sign-release sign + verify before checksum", () => {
  test("signAsset self-verifies and emits a 64-byte signature", () => {
    const { privateB64 } = freshKeypair();
    const asset = Buffer.from("fake release binary");
    const { signature, publicKeyB64 } = signAsset(asset, privateKeyFromB64(privateB64));
    expect(signature.length).toBe(ED25519_SIG_LEN);
    const keyObject = createPublicKey({
      key: Buffer.from(publicKeyB64, "base64"),
      format: "der",
      type: "spki",
    });
    expect(verify(undefined, asset, keyObject, signature)).toBe(true);
    expect(verify(undefined, Buffer.from("tampered"), keyObject, signature)).toBe(false);
  });

  test("checksumLine carries sha256, name, and inline ed25519 signature", () => {
    const { privateB64 } = freshKeypair();
    const asset = Buffer.from("checksum format probe");
    const { signature } = signAsset(asset, privateKeyFromB64(privateB64));
    const line = checksumLine("agency-linux-x64", asset, signature);
    expect(line).toMatch(/^[0-9a-f]{64} {2}agency-linux-x64 {2}ed25519:[A-Za-z0-9+/=]+$/);
  });
});

describe("sign-release CLI end to end", () => {
  test("writes .sig + checksums-signed.txt readable by the update client", async () => {
    const { privateB64, publicDer } = freshKeypair();
    const dir = mkdtempSync(join(tmpdir(), "agency-sign-test-"));
    const artifact = join(dir, "agency-test-bin");
    const payload = Buffer.from("end-to-end signed payload");
    writeFileSync(artifact, payload);
    try {
      const proc = Bun.spawn(["bun", "scripts/sign-release.ts", "--file", artifact], {
        cwd: process.cwd(),
        env: { ...process.env, AGENCY_UPDATE_PRIVATE_KEY: privateB64 },
        stdout: "pipe",
        stderr: "pipe",
      });
      const code = await proc.exited;
      expect(code).toBe(0);

      const sigPath = `${artifact}.sig`;
      expect(existsSync(sigPath)).toBe(true);
      const sig = readFileSync(sigPath);
      expect(sig.length).toBe(ED25519_SIG_LEN);

      const manifest = readFileSync(join(dir, "checksums-signed.txt"), "utf8");
      const entry = manifest.split("\n").find((l) => l.includes("agency-test-bin"));
      expect(entry).toBeDefined();
      const sigB64 = entry!.match(/ed25519:([A-Za-z0-9+/=]+)/)?.[1];
      expect(sigB64).toBeDefined();
      const keyObject = createPublicKey({ key: publicDer, format: "der", type: "spki" });
      expect(verify(undefined, payload, keyObject, Buffer.from(sigB64!, "base64"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fails closed with no private key and writes nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agency-sign-nokey-"));
    const artifact = join(dir, "agency-test-bin");
    writeFileSync(artifact, "unsigned payload");
    try {
      const env = { ...process.env };
      delete env.AGENCY_UPDATE_PRIVATE_KEY;
      const proc = Bun.spawn(["bun", "scripts/sign-release.ts", "--file", artifact], {
        cwd: process.cwd(),
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const code = await proc.exited;
      expect(code).not.toBe(0);
      expect(existsSync(`${artifact}.sig`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--derive-public-key prints the SPKI b64 with no side effects", async () => {
    const { privateB64 } = freshKeypair();
    const expected = publicKeyB64FromPrivate(privateKeyFromB64(privateB64));
    const proc = Bun.spawn(["bun", "scripts/sign-release.ts", "--derive-public-key"], {
      cwd: process.cwd(),
      env: { ...process.env, AGENCY_UPDATE_PRIVATE_KEY: privateB64 },
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    expect(code).toBe(0);
    const out = (await new Response(proc.stdout).text()).trim();
    expect(out).toBe(expected);
  });
});

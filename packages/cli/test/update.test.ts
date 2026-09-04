/**
 * Tests for the update flow: ed25519 signature verification, SHA-256 checksum,
 * and rollback.
 *
 * Since runUpdate makes real HTTP calls to GitHub, we inject httpFetch to mock
 * them. Signature verification and checksum checking are tested in isolation
 * and through the full flow.
 */
import { describe, expect, test } from "bun:test";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// We test the exported functions by importing them. verifySignature is private,
// so we test it indirectly through the full flow with mocked HTTP responses.
import { runUpdate, verifySignature } from "../src/update.ts";
import { getUpdatePublicKey, UPDATE_SPKI_DER_LEN } from "../src/update-public-key.ts";

/**
 * Generates a fresh ed25519 keypair for testing. Returns SPKI DER (public)
 * and PKCS8 DER (private) buffers.
 */
function testKeypair(): { publicKey: Buffer; privateKey: Buffer } {
  const kp = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });
  return { publicKey: kp.publicKey, privateKey: kp.privateKey };
}

/**
 * Sign a buffer with the given private key (DER PKCS8).
 */
function signBuffer(buf: Buffer, privateKeyDer: Buffer): Buffer {
  const keyObject = createPrivateKey({ key: privateKeyDer, format: "der", type: "pkcs8" });
  return sign(undefined, buf, keyObject);
}

/**
 * Build a mock httpFetch that serves a release with the given assets.
 * Returns the mock function plus a helper to verify what was fetched.
 */
function mockRelease(opts: {
  assetName: string;
  assetContent: Buffer;
  /** SHA-256 hex of assetContent (if omitted, computed). */
  assetSha256?: string;
  /** Raw ed25519 signature buffer (64 bytes). If null, .sig returns 404. */
  signature: Buffer | null;
  /** Whether to serve checksums-signed.txt. */
  serveChecksumsSigned?: boolean;
  latestTag?: string;
  currentVersion?: string;
}): {
  httpFetch: typeof fetch;
  fetchedUrls: string[];
} {
  const {
    assetName,
    assetContent,
    assetSha256,
    signature,
    serveChecksumsSigned = true,
    latestTag = "v2.0.0",
  } = opts;

  const sha256 = assetSha256 ?? createHash("sha256").update(assetContent).digest("hex");
  const fetchedUrls: string[] = [];

  // Build checksums-signed.txt content
  let checksumsText = "";
  if (signature && serveChecksumsSigned) {
    checksumsText = `${sha256}  ${assetName}  ed25519:${signature.toString("base64")}\n`;
  } else if (serveChecksumsSigned) {
    checksumsText = `${sha256}  ${assetName}\n`;
  }

  const httpFetch = (async (url: string): Promise<Response> => {
    fetchedUrls.push(url);
    const u = new URL(url);

    // GitHub API for latest release
    if (u.pathname.includes("/releases/latest")) {
      return new Response(
        JSON.stringify({ tag_name: latestTag, assets: [{ name: assetName, browser_download_url: "" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    // Asset download
    if (u.pathname.endsWith(`/${assetName}`)) {
      return new Response(assetContent, { status: 200 });
    }

    // Signature file
    if (u.pathname.endsWith(`/${assetName}.sig`)) {
      if (signature) {
        return new Response(signature, { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    }

    // Checksums file
    if (u.pathname.endsWith("/checksums-signed.txt")) {
      if (serveChecksumsSigned) {
        return new Response(checksumsText, { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    }

    return new Response("Not found", { status: 404 });
  }) as unknown as typeof fetch;

  return { httpFetch, fetchedUrls };
}

describe("update-public-key", () => {
  test("getUpdatePublicKey returns a Buffer", () => {
    const key = getUpdatePublicKey();
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBeGreaterThan(0);
  });

  test("getUpdatePublicKey respects AGENCY_UPDATE_PUBLIC_KEY env var", () => {
    const kp = testKeypair();
    const b64 = kp.publicKey.toString("base64");
    // Temporarily set env
    const prev = process.env.AGENCY_UPDATE_PUBLIC_KEY;
    try {
      process.env.AGENCY_UPDATE_PUBLIC_KEY = b64;
      // Clear module cache / re-import won't work in bun the same way,
      // but the function reads process.env each call.
      const key = getUpdatePublicKey();
      expect(key.equals(kp.publicKey)).toBe(true);
    } finally {
      if (prev === undefined) {
        delete process.env.AGENCY_UPDATE_PUBLIC_KEY;
      } else {
        process.env.AGENCY_UPDATE_PUBLIC_KEY = prev;
      }
    }
  });
});

describe("runUpdate - signature verification", () => {
  /** Create a test "binary" that pretends to be the current binary. */
  function setupTempBin(): string {
    const dir = mkdtempSync(join(tmpdir(), "agency-update-test-"));
    const bin = join(dir, `agency-test-bin${process.platform === "win32" ? ".exe" : ""}`);
    writeFileSync(bin, "current version binary content");
    return bin;
  }

  function cleanupTempBin(binPath: string): void {
    const dir = dirname(binPath);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }

  /** Build the asset name that runUpdate expects for the current platform. */
  function platformAssetName(): string {
    const os = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    return `agency-${os}-${arch}${os === "windows" ? ".exe" : ""}`;
  }

  test("valid ed25519 signature is accepted and update succeeds", async () => {
    const kp = testKeypair();
    const assetContent = Buffer.from("fake binary content for signing test");
    const sig = signBuffer(assetContent, kp.privateKey);
    const assetName = platformAssetName();

    // Override public key to use our test key
    const prevKey = process.env.AGENCY_UPDATE_PUBLIC_KEY;
    process.env.AGENCY_UPDATE_PUBLIC_KEY = kp.publicKey.toString("base64");

    const binPath = setupTempBin();
    try {
      const { httpFetch } = mockRelease({
        assetName,
        assetContent,
        signature: sig,
      });

      const result = await runUpdate({
        currentVersion: "1.0.0",
        httpFetch,
        binPath,
      });

      expect(result).toBe("Updated to 2.0.0");
      // Verify the binary was replaced
      const installed = readFileSync(binPath);
      expect(installed.equals(assetContent)).toBe(true);
      // Verify backup was created
      const backup = `${binPath}.previous`;
      expect(existsSync(backup)).toBe(true);
    } finally {
      cleanupTempBin(binPath);
      if (prevKey === undefined) {
        delete process.env.AGENCY_UPDATE_PUBLIC_KEY;
      } else {
        process.env.AGENCY_UPDATE_PUBLIC_KEY = prevKey;
      }
    }
  });

  test("tampered signature is rejected even with valid checksum", async () => {
    const kp = testKeypair();
    const assetContent = Buffer.from("fake binary content for tamper test");
    // Sign with a different key to simulate tampering
    const wrongKp = testKeypair();
    const wrongSig = signBuffer(assetContent, wrongKp.privateKey);
    const assetName = platformAssetName();

    const prevKey = process.env.AGENCY_UPDATE_PUBLIC_KEY;
    process.env.AGENCY_UPDATE_PUBLIC_KEY = kp.publicKey.toString("base64");

    const binPath = setupTempBin();
    try {
      const { httpFetch } = mockRelease({
        assetName,
        assetContent,
        signature: wrongSig,
      });

      await expect(
        runUpdate({
          currentVersion: "1.0.0",
          httpFetch,
          binPath,
        }),
      ).rejects.toThrow(/Ed25519 signature verification failed/);

      // Original binary should be untouched
      expect(existsSync(binPath)).toBe(true);
      const original = readFileSync(binPath);
      expect(original.equals(Buffer.from("current version binary content"))).toBe(true);
    } finally {
      cleanupTempBin(binPath);
      if (prevKey === undefined) {
        delete process.env.AGENCY_UPDATE_PUBLIC_KEY;
      } else {
        process.env.AGENCY_UPDATE_PUBLIC_KEY = prevKey;
      }
    }
  });

  test("missing .sig file and no checksums-signed.txt is rejected", async () => {
    const kp = testKeypair();
    const assetContent = Buffer.from("fake binary content");
    const assetName = platformAssetName();

    const prevKey = process.env.AGENCY_UPDATE_PUBLIC_KEY;
    process.env.AGENCY_UPDATE_PUBLIC_KEY = kp.publicKey.toString("base64");

    const binPath = setupTempBin();
    try {
      const { httpFetch } = mockRelease({
        assetName,
        assetContent,
        signature: null,
        serveChecksumsSigned: false,
      });

      await expect(
        runUpdate({
          currentVersion: "1.0.0",
          httpFetch,
          binPath,
        }),
      ).rejects.toThrow(/Ed25519 signature verification failed/);

      // Original binary should be untouched
      const original = readFileSync(binPath);
      expect(original.equals(Buffer.from("current version binary content"))).toBe(true);
    } finally {
      cleanupTempBin(binPath);
      if (prevKey === undefined) {
        delete process.env.AGENCY_UPDATE_PUBLIC_KEY;
      } else {
        process.env.AGENCY_UPDATE_PUBLIC_KEY = prevKey;
      }
    }
  });

  test("rollback restores previous binary", async () => {
    const kp = testKeypair();
    const originalContent = Buffer.from("original version content");
    const newContent = Buffer.from("new version content");
    const sig = signBuffer(newContent, kp.privateKey);
    const assetName = platformAssetName();

    const prevKey = process.env.AGENCY_UPDATE_PUBLIC_KEY;
    process.env.AGENCY_UPDATE_PUBLIC_KEY = kp.publicKey.toString("base64");

    const binPath = setupTempBin();
    writeFileSync(binPath, originalContent);

    try {
      // First, run an update to create a .previous backup
      const { httpFetch } = mockRelease({
        assetName,
        assetContent: newContent,
        signature: sig,
      });

      await runUpdate({
        currentVersion: "1.0.0",
        httpFetch,
        binPath,
      });

      // Verify new binary is installed
      let installed = readFileSync(binPath);
      expect(installed.equals(newContent)).toBe(true);
      expect(installed.equals(originalContent)).toBe(false);

      // Verify .previous exists and has the old content
      const backup = `${binPath}.previous`;
      expect(existsSync(backup)).toBe(true);
      const backupContent = readFileSync(backup);
      expect(backupContent.equals(originalContent)).toBe(true);

      // Now rollback
      const rollbackResult = await runUpdate({
        currentVersion: "2.0.0",
        rollback: true,
        binPath,
      });
      expect(rollbackResult).toBe("Rolled back to previous version");

      // Verify original is restored
      installed = readFileSync(binPath);
      expect(installed.equals(originalContent)).toBe(true);
    } finally {
      cleanupTempBin(binPath);
      if (prevKey === undefined) {
        delete process.env.AGENCY_UPDATE_PUBLIC_KEY;
      } else {
        process.env.AGENCY_UPDATE_PUBLIC_KEY = prevKey;
      }
    }
  });

  test("already at latest version returns early without verification", async () => {
    const binPath = setupTempBin();
    try {
      // The mock would fail if it tried to download assets, but if latest === current
      // it returns early before any downloads.
      const { httpFetch } = mockRelease({
        assetName: "agency-test-x64",
        assetContent: Buffer.from("unused"),
        signature: Buffer.from("unused"),
      });

      const result = await runUpdate({
        currentVersion: "2.0.0", // matches the mock's latestTag
        httpFetch,
        binPath,
      });
      expect(result).toBe("Already at latest version 2.0.0");
    } finally {
      cleanupTempBin(binPath);
    }
  });
});

describe("sign-release script validation", () => {
  test("signing then verifying the same asset succeeds", async () => {
    const kp = testKeypair();
    const assetContent = Buffer.from("some release binary content");
    const sig = signBuffer(assetContent, kp.privateKey);
    const keyObject = createPublicKey({ key: kp.publicKey, format: "der", type: "spki" });

    const valid = verify(undefined, assetContent, keyObject, sig);
    expect(valid).toBe(true);
  });

  test("tampered asset fails verification", async () => {
    const kp = testKeypair();
    const assetContent = Buffer.from("original content");
    const tamperedContent = Buffer.from("tampered content");
    const sig = signBuffer(assetContent, kp.privateKey);
    const keyObject = createPublicKey({ key: kp.publicKey, format: "der", type: "spki" });

    const valid = verify(undefined, tamperedContent, keyObject, sig);
    expect(valid).toBe(false);
  });

  test("signature from wrong key fails verification", async () => {
    const signKp = testKeypair();
    const verifyKp = testKeypair();
    const assetContent = Buffer.from("some content");
    const sig = signBuffer(assetContent, signKp.privateKey);
    const keyObject = createPublicKey({ key: verifyKp.publicKey, format: "der", type: "spki" });

    const valid = verify(undefined, assetContent, keyObject, sig);
    expect(valid).toBe(false);
  });
});

describe("update signing hardening (item 59)", () => {
  test("embedded public key is SPKI DER b64 (44 bytes, ed25519 prefix)", () => {
    const prev = process.env.AGENCY_UPDATE_PUBLIC_KEY;
    try {
      delete process.env.AGENCY_UPDATE_PUBLIC_KEY;
      const key = getUpdatePublicKey();
      expect(key.length).toBe(UPDATE_SPKI_DER_LEN);
      expect(key.toString("hex").startsWith("302a300506032b6570032100")).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.AGENCY_UPDATE_PUBLIC_KEY;
      else process.env.AGENCY_UPDATE_PUBLIC_KEY = prev;
    }
  });

  test("malformed AGENCY_UPDATE_PUBLIC_KEY fails closed", () => {
    const prev = process.env.AGENCY_UPDATE_PUBLIC_KEY;
    try {
      process.env.AGENCY_UPDATE_PUBLIC_KEY = Buffer.from("too-short").toString("base64");
      expect(() => getUpdatePublicKey()).toThrow(/Invalid ed25519 update public key/);
    } finally {
      if (prev === undefined) delete process.env.AGENCY_UPDATE_PUBLIC_KEY;
      else process.env.AGENCY_UPDATE_PUBLIC_KEY = prev;
    }
  });

  test("verifySignature rejects wrong-length signatures without throwing", () => {
    const kp = testKeypair();
    const prev = process.env.AGENCY_UPDATE_PUBLIC_KEY;
    try {
      process.env.AGENCY_UPDATE_PUBLIC_KEY = kp.publicKey.toString("base64");
      expect(verifySignature(Buffer.from("asset"), Buffer.from("short"))).toBe(false);
      expect(verifySignature(Buffer.from("asset"), Buffer.alloc(0))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.AGENCY_UPDATE_PUBLIC_KEY;
      else process.env.AGENCY_UPDATE_PUBLIC_KEY = prev;
    }
  });

  test("signature gate runs before checksum: bad sig + valid checksum still refuses", async () => {
    const kp = testKeypair();
    const assetContent = Buffer.from("ordering probe content");
    const wrongKp = testKeypair();
    const wrongSig = signBuffer(assetContent, wrongKp.privateKey);
    const os = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const assetName = `agency-${os}-${arch}${os === "windows" ? ".exe" : ""}`;

    const prevKey = process.env.AGENCY_UPDATE_PUBLIC_KEY;
    process.env.AGENCY_UPDATE_PUBLIC_KEY = kp.publicKey.toString("base64");

    const dir = mkdtempSync(join(tmpdir(), "agency-update-order-"));
    const binPath = join(dir, "agency-bin");
    writeFileSync(binPath, "current binary");
    try {
      // Correct SHA-256 in the manifest, but the .sig is from the wrong key:
      // the failure must name the signature gate, never the checksum.
      const { httpFetch } = mockRelease({ assetName, assetContent, signature: wrongSig });
      await expect(runUpdate({ currentVersion: "1.0.0", httpFetch, binPath })).rejects.toThrow(
        /Ed25519 signature verification failed/,
      );
      expect(readFileSync(binPath).equals(Buffer.from("current binary"))).toBe(true);
      expect(existsSync(`${binPath}.previous`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      if (prevKey === undefined) delete process.env.AGENCY_UPDATE_PUBLIC_KEY;
      else process.env.AGENCY_UPDATE_PUBLIC_KEY = prevKey;
    }
  });
});

// Helper for dirname in tests
function dirname(p: string): string {
  const sep = p.includes("\\") ? "\\" : "/";
  const idx = p.lastIndexOf(sep);
  return idx === -1 ? "." : p.slice(0, idx);
}

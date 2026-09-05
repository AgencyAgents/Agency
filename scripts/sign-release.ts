/**
 * Signs a release artifact with the ed25519 private key.
 *
 * Usage: bun scripts/sign-release.ts --file <artifact> [--key <base64-private-key>]
 *        bun scripts/sign-release.ts --file <artifact> --print-public-key
 *        bun scripts/sign-release.ts --derive-public-key [--key <base64-private-key>]
 *
 * The private key is read from (in order):
 *   1. --key argument (PKCS8 DER, base64-encoded)
 *   2. AGENCY_UPDATE_PRIVATE_KEY env var (PKCS8 DER, base64-encoded)
 *
 * There is NO dev fallback: without a key the script fails closed, so a
 * release can never ship unsigned. The private key is never printed or
 * logged; only the public SPKI DER b64 (safe to embed) is ever output.
 *
 * For each artifact the script:
 *   1. signs the raw bytes with ed25519 (64-byte raw signature),
 *   2. self-verifies the signature against the derived public key
 *      BEFORE writing any checksum output (fail closed on mismatch),
 *   3. writes <artifact>.sig (raw 64 bytes) alongside the artifact,
 *   4. writes/appends "<sha256>  <name>  ed25519:<sig-b64>" to
 *      checksums-signed.txt next to the artifact.
 *
 * The client (packages/cli/src/update.ts) mirrors this order:
 * verifySignature (.sig or inline ed25519: field) BEFORE the SHA-256
 * checksum, then backs up the current binary to .previous for rollback.
 */

import { Buffer } from "node:buffer";
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** ed25519 PKCS8 DER is 48 bytes; SPKI DER public is 44 bytes. */
export const ED25519_PKCS8_DER_LEN = 48;
export const ED25519_SPKI_DER_LEN = 44;
export const ED25519_SIG_LEN = 64;
/** SPKI DER prefix for ed25519 (RFC 8410): SEQUENCE OID 1.3.101.112 + BIT STRING. */
const SPKI_ED25519_PREFIX_HEX = "302a300506032b6570032100";

export function privateKeyFromB64(encodedKey: string): ReturnType<typeof createPrivateKey> {
  let raw: Buffer;
  try {
    raw = Buffer.from(encodedKey.trim(), "base64");
  } catch {
    throw new Error("AGENCY_UPDATE_PRIVATE_KEY is not valid base64");
  }
  if (raw.length !== ED25519_PKCS8_DER_LEN) {
    throw new Error(
      `Invalid ed25519 private key length: expected ${ED25519_PKCS8_DER_LEN} bytes PKCS8 DER, got ${raw.length}`,
    );
  }
  try {
    return createPrivateKey({ key: raw, format: "der", type: "pkcs8" });
  } catch {
    throw new Error("AGENCY_UPDATE_PRIVATE_KEY is not a valid ed25519 PKCS8 DER key");
  }
}

export function publicKeyB64FromPrivate(privateKey: ReturnType<typeof createPrivateKey>): string {
  const pub = createPublicKey(privateKey);
  const der = pub.export({ format: "der", type: "spki" }) as Buffer;
  if (der.length !== ED25519_SPKI_DER_LEN || !der.toString("hex").startsWith(SPKI_ED25519_PREFIX_HEX)) {
    throw new Error("Derived public key is not a valid ed25519 SPKI DER key");
  }
  return der.toString("base64");
}

export function signAsset(
  assetBuf: Buffer,
  privateKey: ReturnType<typeof createPrivateKey>,
): {
  signature: Buffer;
  publicKeyB64: string;
} {
  const signature = sign(undefined, assetBuf, privateKey);
  if (signature.length !== ED25519_SIG_LEN) {
    throw new Error(`Unexpected ed25519 signature length: got ${signature.length}, want ${ED25519_SIG_LEN}`);
  }
  // Self-verify BEFORE any checksum output: fail closed on a bad key/signature.
  const publicKeyB64 = publicKeyB64FromPrivate(privateKey);
  const keyObject = createPublicKey({
    key: Buffer.from(publicKeyB64, "base64"),
    format: "der",
    type: "spki",
  });
  if (!verify(undefined, assetBuf, keyObject, signature)) {
    throw new Error("Self-verification failed immediately after signing; refusing to write checksums");
  }
  return { signature, publicKeyB64 };
}

export function checksumLine(assetName: string, assetBuf: Buffer, signature: Buffer): string {
  const sha256 = createHash("sha256").update(assetBuf).digest("hex");
  return `${sha256}  ${assetName}  ed25519:${signature.toString("base64")}`;
}

function parseArgs(argv: string[]): {
  file: string;
  keyB64?: string;
  printPublicKey: boolean;
  derivePublicKey: boolean;
} {
  let file = "";
  let keyB64: string | undefined;
  let printPublicKey = false;
  let derivePublicKey = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--file") {
      file = argv[i + 1] ?? "";
      i++;
    } else if (arg === "--key") {
      keyB64 = argv[i + 1] ?? "";
      i++;
    } else if (arg === "--print-public-key") {
      printPublicKey = true;
    } else if (arg === "--derive-public-key") {
      derivePublicKey = true;
    }
  }
  if (!file && !derivePublicKey)
    throw new Error(
      "Usage: bun scripts/sign-release.ts --file <artifact> [--key <base64-key>] [--print-public-key] | --derive-public-key [--key <base64-key>]",
    );
  return { file: file ? resolve(file) : "", keyB64, printPublicKey, derivePublicKey };
}

function main(): void {
  const { file, keyB64, printPublicKey, derivePublicKey } = parseArgs(process.argv.slice(2));

  const encodedKey = keyB64 ?? process.env.AGENCY_UPDATE_PRIVATE_KEY;
  if (!encodedKey) {
    throw new Error(
      "No private key provided. Pass --key or set AGENCY_UPDATE_PRIVATE_KEY env var (PKCS8 DER base64). Refusing to ship unsigned.",
    );
  }
  const privateKey = privateKeyFromB64(encodedKey);

  // Derive-only mode for CI: print the SPKI DER b64 public key with no
  // side effects (no .sig, no checksum output). The release workflow uses
  // this to embed the production public key at compile time.
  if (derivePublicKey) {
    console.log(publicKeyB64FromPrivate(privateKey));
    return;
  }

  const assetBuf = readFileSync(file);

  const { signature, publicKeyB64 } = signAsset(assetBuf, privateKey);
  if (printPublicKey) {
    console.log(`AGENCY_UPDATE_PUBLIC_KEY=${publicKeyB64}`);
  }
  const sigPath = `${file}.sig`;
  writeFileSync(sigPath, signature);
  console.log(`Wrote signature (${signature.length} bytes) to ${sigPath}`);

  const assetName = file.split(/[/\\]/).pop() ?? "unknown";
  const line = checksumLine(assetName, assetBuf, signature);

  const checksumFile = resolve(dirname(file), "checksums-signed.txt");
  let existing = "";
  try {
    existing = readFileSync(checksumFile, "utf8");
  } catch {}
  const lines = existing
    .split("\n")
    .filter((l) => !l.includes(`  ${assetName}  `))
    .filter(Boolean);
  lines.push(line);
  writeFileSync(checksumFile, `${lines.join("\n")}\n`);
  console.log(`Appended entry to ${checksumFile}`);
}

const isMain = (() => {
  try {
    return import.meta.main === true;
  } catch {
    return process.argv[1]?.endsWith("sign-release.ts") ?? false;
  }
})();
if (isMain) {
  main();
}

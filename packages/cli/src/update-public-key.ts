/**
 * Embedded ed25519 public key for release artifact signature verification.
 *
 * The public key is compiled into the binary at build time. For local dev builds
 * this file contains a test keypair; CI replaces `AGENCY_UPDATE_PUBLIC_KEY` env
 * var (or this constant) with the real production public key via --define in
 * scripts/build.ts.
 *
 * The corresponding private key lives ONLY in GitHub CI secrets
 * (AGENCY_UPDATE_PRIVATE_KEY) and is used by scripts/sign-release.ts to sign
 * each release artifact at publish time.
 */

const DEV_PUBLIC_KEY_B64 = "MCowBQYDK2VwAyEANzPU2/NKu9PA31bXmePx4qWG4SUBg3l0AwJaRa2jOTE=";

export const UPDATE_SPKI_DER_LEN = 44;
const SPKI_ED25519_PREFIX_HEX = "302a300506032b6570032100";

/** Raw DER bytes of the SPKI-encoded ed25519 public key (44-byte SPKI DER, base64). */
export function getUpdatePublicKey(): Buffer {
  const raw = process.env.AGENCY_UPDATE_PUBLIC_KEY ?? DEV_PUBLIC_KEY_B64;
  const encoded = raw.trim();
  let der: Buffer;
  try {
    der = Buffer.from(encoded, "base64");
  } catch {
    throw new Error("AGENCY_UPDATE_PUBLIC_KEY is not valid base64 SPKI DER");
  }
  if (der.length !== UPDATE_SPKI_DER_LEN || !der.toString("hex").startsWith(SPKI_ED25519_PREFIX_HEX)) {
    throw new Error(
      `Invalid ed25519 update public key: expected ${UPDATE_SPKI_DER_LEN}-byte SPKI DER base64, got ${der.length} bytes`,
    );
  }
  return der;
}

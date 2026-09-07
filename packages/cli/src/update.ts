import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { getUpdatePublicKey } from "./update-public-key.ts";

const REPO = "AgencyAgents/Agency";

export async function checkStale(
  currentVersion: string,
  httpFetch: typeof fetch = fetch,
): Promise<string | undefined> {
  try {
    const res = await httpFetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { accept: "application/vnd.github.v3+json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { tag_name?: string };
    const latest = body.tag_name?.replace(/^v/, "") ?? "";
    if (latest && latest !== currentVersion) return latest;
  } catch {}
  return undefined;
}

/** Verify ed25519 signature for the asset buffer using the embedded public key. */
export function verifySignature(assetBuf: Buffer, signatureBuf: Buffer): boolean {
  if (signatureBuf.length !== 64) return false;
  try {
    const publicKey = getUpdatePublicKey();
    const keyObject = createPublicKey({ key: publicKey, format: "der", type: "spki" });
    return verify(undefined, assetBuf, keyObject, signatureBuf);
  } catch {
    return false;
  }
}

export async function runUpdate(options: {
  currentVersion: string;
  rollback?: boolean;
  binPath?: string;
  httpFetch?: typeof fetch;
}): Promise<string> {
  const binPath = options.binPath ?? process.execPath;
  const httpFetch = options.httpFetch ?? fetch;

  if (options.rollback) {
    const backup = `${binPath}.previous`;
    if (!existsSync(backup)) throw new Error("No previous version to rollback to");
    renameSync(backup, binPath);
    return "Rolled back to previous version";
  }

  const latestRes = await httpFetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { accept: "application/vnd.github.v3+json" },
  });
  if (!latestRes.ok) throw new Error(`Failed to fetch latest release: ${latestRes.status}`);
  const latest = (await latestRes.json()) as {
    tag_name: string;
    assets?: Array<{ name: string; browser_download_url: string }>;
  };
  const latestVersion = latest.tag_name.replace(/^v/, "");
  if (latestVersion === options.currentVersion) return `Already at latest version ${latestVersion}`;

  const os = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const assetName = `agency-${os}-${arch}${os === "windows" ? ".exe" : ""}`;
  const checksumName = "checksums-signed.txt";

  const baseUrl = `https://github.com/${REPO}/releases/download/v${latestVersion}`;
  const assetRes = await httpFetch(`${baseUrl}/${assetName}`);
  if (!assetRes.ok) throw new Error(`Failed to download ${assetName}: ${assetRes.status}`);
  const assetBuf = Buffer.from(await assetRes.arrayBuffer());

  // --- Step 1: ed25519 signature verification (PRIMARY) ---
  //
  // The release provides both checksums-signed.txt and per-asset .sig files.
  // We prefer the .sig file (raw 64-byte ed25519 signature) for simplicity.
  // If the .sig file is missing, we fall back to the inline signature in
  // checksums-signed.txt (for backward compatibility during transition).
  const sigRes = await httpFetch(`${baseUrl}/${assetName}.sig`);
  let sigVerified = false;
  if (sigRes.ok) {
    const sigBuf = Buffer.from(await sigRes.arrayBuffer());
    sigVerified = verifySignature(assetBuf, sigBuf);
  } else {
    // Fallback: try parsing inline signature from checksums-signed.txt
    const checksumRes = await httpFetch(`${baseUrl}/${checksumName}`);
    if (checksumRes.ok) {
      const checksumText = await checksumRes.text();
      const checksumLine = checksumText.split("\n").find((l) => l.includes(assetName));
      if (checksumLine) {
        const sigMatch = checksumLine.match(/ed25519:([A-Za-z0-9+/=]+)/);
        if (sigMatch?.[1]) {
          const sigBuf = Buffer.from(sigMatch[1], "base64");
          sigVerified = verifySignature(assetBuf, sigBuf);
        }
      }
    }
  }

  if (!sigVerified) {
    throw new Error(
      `Ed25519 signature verification failed for ${assetName}. ` +
        "The downloaded artifact may be tampered with or corrupted. " +
        "Refusing to install. " +
        "If you are on a development build, ensure AGENCY_UPDATE_PUBLIC_KEY is set correctly.",
    );
  }

  // --- Step 2: SHA-256 checksum (SECONDARY) ---
  const checksumRes = await httpFetch(`${baseUrl}/${checksumName}`);
  if (!checksumRes.ok) throw new Error(`Failed to download checksums: ${checksumRes.status}`);
  const checksumText = await checksumRes.text();
  const expected = checksumText
    .split("\n")
    .find((l) => l.includes(assetName))
    ?.split(/\s+/)[0];
  if (!expected) throw new Error(`No checksum for ${assetName} in manifest`);
  const actual = createHash("sha256").update(assetBuf).digest("hex");
  if (actual !== expected) throw new Error(`Checksum mismatch: expected ${expected}, got ${actual}`);

  const tmpPath = `${binPath}.new`;
  writeFileSync(tmpPath, assetBuf, { mode: 0o755 });
  const backup = `${binPath}.previous`;
  if (existsSync(binPath)) {
    const current = readFileSync(binPath);
    writeFileSync(backup, current, { mode: 0o755 });
  }
  renameSync(tmpPath, binPath);
  return `Updated to ${latestVersion}`;
}

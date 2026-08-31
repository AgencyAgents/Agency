import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SnapshotEntry {
  /** Content hash of the file at the moment it was captured. */
  hash: string;
  path: string;
  capturedAt: string;
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function blobPath(storeDir: string, hash: string): string {
  return join(storeDir, "blobs", hash.slice(0, 2), hash.slice(2));
}

/**
 * Content-addressed file snapshots, independent of conversation undo (R5's
 * "file undo != conversation undo" distinction). Identical file states across
 * different sessions or edits share one blob, so snapshotting the same
 * unchanged file repeatedly costs nothing extra on disk.
 */
export class SnapshotStore {
  constructor(private readonly storeDir: string) {}

  /** Captures the current on-disk content of `path`, returning its entry. */
  capture(path: string, content: string): SnapshotEntry {
    const hash = contentHash(content);
    const blob = blobPath(this.storeDir, hash);
    if (!existsSync(blob)) {
      mkdirSync(join(blob, ".."), { recursive: true });
      writeFileSync(blob, content, "utf8");
    }
    return { hash, path, capturedAt: new Date().toISOString() };
  }

  /** Returns the exact content captured under `entry`, for restoring a file. */
  read(entry: SnapshotEntry): string {
    const blob = blobPath(this.storeDir, entry.hash);
    if (!existsSync(blob)) {
      throw new Error(`snapshot blob missing for ${entry.path} (hash ${entry.hash})`);
    }
    return readFileSync(blob, "utf8");
  }
}

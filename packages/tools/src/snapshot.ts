import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SnapshotEntry {
  /** Content hash of the file at the moment it was captured. */
  hash: string;
  path: string;
  capturedAt: string;
}

/**
 * One file-write in the undo journal: the content BEFORE the write (always
 * captured) plus the content AFTER it (recorded once the write + formatter
 * settle), so undo restores the prior state and redo re-applies the new one.
 */
interface JournalRecord {
  before: SnapshotEntry;
  afterHash?: string;
  /** Association with the conversation: the turn that caused the write. */
  ref?: string;
  undone: boolean;
}

export interface UndoOutcome {
  path: string;
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function blobPath(storeDir: string, hash: string): string {
  return join(storeDir, "blobs", hash.slice(0, 2), hash.slice(2));
}

const MAX_JOURNAL_RECORDS = 1000;

/**
 * Content-addressed file snapshots, independent of conversation undo (R5's
 * "file undo != conversation undo" distinction). Identical file states across
 * different sessions or edits share one blob, so snapshotting the same
 * unchanged file repeatedly costs nothing extra on disk.
 *
 * Every capture is also journalled in order, which is what file undo/redo is
 * built on: `undo()` restores the most recent unrestored capture, `redo()`
 * re-applies it, and `prune()` reclaims blobs no journal record references
 * anymore (refcount over before+after hashes).
 */
export class SnapshotStore {
  private readonly journal: JournalRecord[] = [];

  constructor(private readonly storeDir: string) {}

  /** Captures the current on-disk content of `path`, returning its entry. */
  capture(path: string, content: string, ref?: string): SnapshotEntry {
    const entry: SnapshotEntry = {
      hash: this.storeBlob(content),
      path,
      capturedAt: new Date().toISOString(),
    };
    this.journal.push({ before: entry, ...(ref === undefined ? {} : { ref }), undone: false });
    if (this.journal.length > MAX_JOURNAL_RECORDS) this.journal.shift();
    return entry;
  }

  /** Returns the exact content captured under `entry`, for restoring a file. */
  read(entry: SnapshotEntry): string {
    const blob = blobPath(this.storeDir, entry.hash);
    if (!existsSync(blob)) {
      throw new Error(`snapshot blob missing for ${entry.path} (hash ${entry.hash})`);
    }
    return readFileSync(blob, "utf8");
  }

  /**
   * Records the current on-disk content of `path` as the AFTER state of that
   * path's most recent not-yet-settled journal record. File-mutating tools
   * call this once their write (and any formatter) has finished, so redo has
   * something to restore.
   */
  recordAfter(path: string): void {
    for (let i = this.journal.length - 1; i >= 0; i--) {
      const record = this.journal[i];
      if (record && record.before.path === path) {
        if (record.afterHash === undefined && existsSync(path)) {
          record.afterHash = this.storeBlob(readFileSync(path, "utf8"));
        }
        return;
      }
    }
  }

  /** Restores the most recent applied capture to its pre-write content. */
  undo(): UndoOutcome | undefined {
    for (let i = this.journal.length - 1; i >= 0; i--) {
      const record = this.journal[i];
      if (record && !record.undone) {
        this.restore(record.before);
        record.undone = true;
        return { path: record.before.path };
      }
    }
    return undefined;
  }

  /** Re-applies the most recently undone write (whose post-state is known). */
  redo(): UndoOutcome | undefined {
    for (let i = this.journal.length - 1; i >= 0; i--) {
      const record = this.journal[i];
      if (record && record.undone && record.afterHash !== undefined) {
        const after: SnapshotEntry = { ...record.before, hash: record.afterHash };
        this.restore(after);
        record.undone = false;
        return { path: record.before.path };
      }
    }
    return undefined;
  }

  /**
   * Deletes blobs that no journal record references (refcount over every
   * before+after hash) and returns how many were reclaimed. Blobs written
   * before journaling existed — or after a restart with an in-memory journal —
   * are the usual orphans.
   */
  prune(): number {
    const refCounts = new Map<string, number>();
    for (const record of this.journal) {
      refCounts.set(record.before.hash, (refCounts.get(record.before.hash) ?? 0) + 1);
      if (record.afterHash !== undefined) {
        refCounts.set(record.afterHash, (refCounts.get(record.afterHash) ?? 0) + 1);
      }
    }

    const blobsDir = join(this.storeDir, "blobs");
    if (!existsSync(blobsDir)) return 0;
    let pruned = 0;
    for (const shard of readdirSync(blobsDir)) {
      const shardDir = join(blobsDir, shard);
      for (const file of readdirSync(shardDir)) {
        // Blob files are sharded: <blobs>/<hash[0:2]>/<hash[2:]>.
        const hash = shard + file;
        if ((refCounts.get(hash) ?? 0) > 0) continue;
        rmSync(join(shardDir, file), { force: true });
        pruned += 1;
      }
    }
    return pruned;
  }

  /** Journal length, for tests and callers that want to know undo depth. */
  get depth(): number {
    return this.journal.length;
  }

  private storeBlob(content: string): string {
    const hash = contentHash(content);
    const blob = blobPath(this.storeDir, hash);
    if (!existsSync(blob)) {
      mkdirSync(join(blob, ".."), { recursive: true });
      writeFileSync(blob, content, "utf8");
    }
    return hash;
  }

  private restore(entry: SnapshotEntry): void {
    const content = this.read(entry);
    mkdirSync(join(entry.path, ".."), { recursive: true });
    writeFileSync(entry.path, content, "utf8");
  }
}

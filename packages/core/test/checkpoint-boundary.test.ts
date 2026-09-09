import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgencyError, ErrorCode } from "@agency/schema";
import { SnapshotStore } from "@agency/tools";
import {
  recordIntegrationCheckpoint,
  restoreIntegrationCheckpoint,
  withShadowCorrelation,
} from "../src/team/checkpoint.ts";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function makeTree(): { work: string; store: string; a: string; b: string } {
  const base = mkdtempSync(join(tmpdir(), "agency-checkpoint-boundary-"));
  dirs.push(base);
  const work = join(base, "work");
  const store = join(base, "store");
  mkdirSync(join(work, "sub"), { recursive: true });
  mkdirSync(store, { recursive: true });
  const a = join(work, "a.txt");
  const b = join(work, "sub", "b.txt");
  return { work, store, a, b };
}

function writeState(a: string, b: string, aText: string, bText: string | null): void {
  writeFileSync(a, aText, "utf8");
  if (bText === null) rmSync(b, { force: true });
  else writeFileSync(b, bText, "utf8");
}

function sha(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function blobCount(storeDir: string): number {
  const blobs = join(storeDir, "blobs");
  if (!existsSync(blobs)) return 0;
  let n = 0;
  for (const shard of readdirSync(blobs)) n += readdirSync(join(blobs, shard)).length;
  return n;
}

function journalLines(storeDir: string): string[] {
  const file = join(storeDir, "shadow-journal.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.length > 0);
}

describe("checkpoint boundary: pre-merge capture plus turn-level shadows", () => {
  it("capture then shadow-restore returns to the captured state, integration restore converges", () => {
    const { work, store, a, b } = makeTree();
    writeState(a, b, "alpha-v1", "beta-v1");
    const captured = recordIntegrationCheckpoint([a, b]);

    const snapshots = new SnapshotStore(store);
    for (const [path, text] of [
      [a, "alpha-v1"],
      [b, "beta-v1"],
    ] as const) {
      snapshots.capture(path, text);
      snapshots.recordAfter(path);
    }
    const { commitHash } = snapshots.shadowCommit("sess-1", "pre-merge");
    const correlated = withShadowCorrelation(captured, commitHash);
    expect("commitHash" in captured).toBe(false);
    expect(correlated.commitHash).toBe(commitHash);

    writeState(a, b, "alpha-v2", null);
    const fresh = join(work, "c.txt");
    writeFileSync(fresh, "gamma-new", "utf8");

    const shadowOut = snapshots.restoreShadowCommit(commitHash, { targetDir: work, sessionRoot: work });
    expect(shadowOut.files.length).toBe(2);
    expect(readFileSync(a, "utf8")).toBe(captured.files[a]);
    expect(readFileSync(b, "utf8")).toBe(captured.files[b]);

    const integOut = restoreIntegrationCheckpoint(correlated);
    expect(new Set(integOut.restored)).toEqual(new Set([a, b]));
    expect(readFileSync(a, "utf8")).toBe("alpha-v1");
    expect(readFileSync(b, "utf8")).toBe("beta-v1");
    expect(readFileSync(fresh, "utf8")).toBe("gamma-new");
  });

  it("double restore is idempotent with a single journal truth", () => {
    const { work, store, a, b } = makeTree();
    writeState(a, b, "alpha-v1", "beta-v1");
    const correlated = withShadowCorrelation(
      recordIntegrationCheckpoint([a, b]),
      (() => {
        const s = new SnapshotStore(store);
        s.capture(a, "alpha-v1");
        s.recordAfter(a);
        s.capture(b, "beta-v1");
        s.recordAfter(b);
        return s.shadowCommit("sess-1", "pre-merge").commitHash;
      })(),
    );
    const snapshots = new SnapshotStore(store);
    const hash = correlated.commitHash as string;

    writeState(a, b, "alpha-v2", "beta-v2");
    snapshots.restoreShadowCommit(hash, { targetDir: work, sessionRoot: work });
    restoreIntegrationCheckpoint(correlated);
    const stateOnce = sha(`${readFileSync(a, "utf8")}\n${readFileSync(b, "utf8")}`);
    const journalOnce = journalLines(store);
    const blobsOnce = blobCount(store);

    const shadowAgain = snapshots.restoreShadowCommit(hash, { targetDir: work, sessionRoot: work });
    const integAgain = restoreIntegrationCheckpoint(correlated);
    expect(shadowAgain.files.length).toBe(2);
    expect(new Set(integAgain.restored)).toEqual(new Set([a, b]));
    expect(sha(`${readFileSync(a, "utf8")}\n${readFileSync(b, "utf8")}`)).toBe(stateOnce);
    expect(journalLines(store)).toEqual(journalOnce);
    expect(journalOnce.length).toBe(1);
    expect(blobCount(store)).toBe(blobsOnce);
  });

  it("malformed inputs have typed behavior", () => {
    const { work, store, a, b } = makeTree();
    expect(recordIntegrationCheckpoint([])).toEqual({ files: {}, at: expect.any(String) });
    expect(restoreIntegrationCheckpoint({ files: {}, at: new Date().toISOString() })).toEqual({
      restored: [],
    });
    const captured = recordIntegrationCheckpoint([a, b]);
    expect(() => withShadowCorrelation(captured, "")).toThrow(/non-empty/);
    expect(() => withShadowCorrelation(captured, "   ")).toThrow(/non-empty/);

    const snapshots = new SnapshotStore(store);
    let unknown: unknown;
    try {
      snapshots.restoreShadowCommit("0".repeat(64), { targetDir: work, sessionRoot: work });
    } catch (error) {
      unknown = error;
    }
    expect(unknown).toBeInstanceOf(AgencyError);
    expect((unknown as AgencyError).code).toBe(ErrorCode.TOOL_ERROR);

    writeState(a, b, "alpha-v1", "beta-v1");
    snapshots.capture(a, "alpha-v1");
    snapshots.recordAfter(a);
    const { commitHash } = snapshots.shadowCommit("sess-1", "scoped");
    const elsewhere = mkdtempSync(join(tmpdir(), "agency-checkpoint-scope-"));
    dirs.push(elsewhere);
    const scoped = snapshots.restoreShadowCommit(commitHash, { targetDir: work, sessionRoot: elsewhere });
    expect(scoped).toEqual({ commitHash, files: [], restored: 0 });
    expect(readFileSync(a, "utf8")).toBe("alpha-v1");
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SnapshotStore } from "../src/snapshot.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempStore(): SnapshotStore {
  const dir = mkdtempSync(join(tmpdir(), "agency-snapshot-test-"));
  dirs.push(dir);
  return new SnapshotStore(dir);
}

describe("SnapshotStore", () => {
  test("captures content and reads back the exact same bytes", () => {
    const store = tempStore();
    const entry = store.capture("/repo/a.ts", "export const x = 1;\n");
    expect(store.read(entry)).toBe("export const x = 1;\n");
  });

  test("identical content across different paths shares one blob on disk", () => {
    const store = tempStore();
    const a = store.capture("/repo/a.ts", "same content");
    const b = store.capture("/repo/b.ts", "same content");
    expect(a.hash).toBe(b.hash);
  });

  test("different content produces different hashes", () => {
    const store = tempStore();
    const a = store.capture("/repo/a.ts", "version one");
    const b = store.capture("/repo/a.ts", "version two");
    expect(a.hash).not.toBe(b.hash);
  });

  test("capturing the same content twice doesn't error or duplicate work", () => {
    const store = tempStore();
    const first = store.capture("/repo/a.ts", "content");
    const second = store.capture("/repo/a.ts", "content");
    expect(first.hash).toBe(second.hash);
    expect(store.read(second)).toBe("content");
  });

  test("throws a clear error reading an entry whose blob is missing", () => {
    const store = tempStore();
    expect(() =>
      store.read({ hash: "deadbeef", path: "/repo/x.ts", capturedAt: new Date().toISOString() }),
    ).toThrow(/missing/);
  });

  test("preserves content with special characters and newlines exactly", () => {
    const store = tempStore();
    const content = 'line1\r\nline2\ttab\n"quoted"\n';
    const entry = store.capture("/repo/weird.ts", content);
    expect(store.read(entry)).toBe(content);
  });
});

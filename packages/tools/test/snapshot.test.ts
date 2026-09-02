import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SnapshotStore } from "../src/snapshot.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempStore(): {
  store: SnapshotStore;
  dir: string;
  ws: string;
  file: (name: string) => string;
} {
  const dir = mkdtempSync(join(tmpdir(), "agency-snapshot-test-"));
  const ws = mkdtempSync(join(tmpdir(), "agency-snapshot-ws-"));
  dirs.push(dir, ws);
  return { store: new SnapshotStore(dir), dir, ws, file: (name: string) => join(ws, name) };
}

describe("SnapshotStore", () => {
  test("captures content and reads back the exact same bytes", () => {
    const { store } = tempStore();
    const entry = store.capture("/repo/a.ts", "export const x = 1;\n");
    expect(store.read(entry)).toBe("export const x = 1;\n");
  });

  test("identical content across different paths shares one blob on disk", () => {
    const { store } = tempStore();
    const a = store.capture("/repo/a.ts", "same content");
    const b = store.capture("/repo/b.ts", "same content");
    expect(a.hash).toBe(b.hash);
  });

  test("different content produces different hashes", () => {
    const { store } = tempStore();
    const a = store.capture("/repo/a.ts", "version one");
    const b = store.capture("/repo/a.ts", "version two");
    expect(a.hash).not.toBe(b.hash);
  });

  test("capturing the same content twice doesn't error or duplicate work", () => {
    const { store } = tempStore();
    const first = store.capture("/repo/a.ts", "content");
    const second = store.capture("/repo/a.ts", "content");
    expect(first.hash).toBe(second.hash);
    expect(store.read(second)).toBe("content");
  });

  test("throws a clear error reading an entry whose blob is missing", () => {
    const { store } = tempStore();
    expect(() =>
      store.read({ hash: "deadbeef", path: "/repo/x.ts", capturedAt: new Date().toISOString() }),
    ).toThrow(/missing/);
  });

  test("preserves content with special characters and newlines exactly", () => {
    const { store } = tempStore();
    const content = 'line1\r\nline2\ttab\n"quoted"\n';
    const entry = store.capture("/repo/weird.ts", content);
    expect(store.read(entry)).toBe(content);
  });

  test("undo restores the pre-write content and redo re-applies the post-write content", () => {
    const { store, file } = tempStore();
    writeFileSync(file("a.ts"), "before", "utf8");

    store.capture(file("a.ts"), "before", "turn-1");
    writeFileSync(file("a.ts"), "after", "utf8");
    store.recordAfter(file("a.ts"));

    expect(store.undo()).toEqual({ path: file("a.ts") });
    expect(readFileSync(file("a.ts"), "utf8")).toBe("before");

    expect(store.redo()).toEqual({ path: file("a.ts") });
    expect(readFileSync(file("a.ts"), "utf8")).toBe("after");
  });

  test("undo across multiple writes walks back one write at a time, redo forward", () => {
    const { store, file } = tempStore();
    writeFileSync(file("a.ts"), "v0", "utf8");

    for (const version of ["v1", "v2", "v3"]) {
      store.capture(file("a.ts"), readFileSync(file("a.ts"), "utf8"));
      writeFileSync(file("a.ts"), version, "utf8");
      store.recordAfter(file("a.ts"));
    }

    store.undo();
    expect(readFileSync(file("a.ts"), "utf8")).toBe("v2");
    store.undo();
    expect(readFileSync(file("a.ts"), "utf8")).toBe("v1");
    store.redo();
    expect(readFileSync(file("a.ts"), "utf8")).toBe("v3");
  });

  test("redo skips records captured without a recorded after-state", () => {
    const { store, file } = tempStore();
    store.capture(file("a.ts"), "before");
    writeFileSync(file("a.ts"), "after", "utf8");
    // no recordAfter for the first capture
    store.capture(file("b.ts"), "b-before", "turn-2");
    writeFileSync(file("b.ts"), "b-after", "utf8");
    store.recordAfter(file("b.ts"));

    store.undo(); // reverts b.ts (most recent)
    store.undo(); // reverts a.ts too
    expect(readFileSync(file("a.ts"), "utf8")).toBe("before");

    const redo = store.redo();
    expect(redo).toEqual({ path: file("b.ts") });
    // a.ts has no after-state to redo into, so it stays at its restored content
    expect(readFileSync(file("a.ts"), "utf8")).toBe("before");
  });

  test("undo/redo on an empty journal report nothing to do", () => {
    const { store } = tempStore();
    expect(store.undo()).toBeUndefined();
    expect(store.redo()).toBeUndefined();
  });

  test("prune deletes blobs no journal record references and keeps the rest", () => {
    const { store, dir } = tempStore();
    store.capture("/repo/a.ts", "referenced content");
    store.capture("/repo/b.ts", "also referenced");
    // An orphan blob, as if left by a pre-journaling run or an aborted capture.
    const orphanHash = createHash("sha256").update("orphan").digest("hex");
    const orphanDir = join(dir, "blobs", orphanHash.slice(0, 2));
    mkdirSync(orphanDir, { recursive: true });
    writeFileSync(join(orphanDir, orphanHash.slice(2)), "orphan", "utf8");

    expect(store.prune()).toBe(1);
    expect(store.prune()).toBe(0);
    expect(() => store.read({ hash: orphanHash, path: "/x", capturedAt: "" })).toThrow();
    expect(
      store.read({
        hash: createHash("sha256").update("referenced content").digest("hex"),
        path: "/x",
        capturedAt: "",
      }),
    ).toBe("referenced content");
  });
});

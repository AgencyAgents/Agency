import { describe, expect, test } from "bun:test";
import { applyEdit as applyEditEngine } from "../src/edit-engine.ts";
import {
  canonicalizeLine,
  canonicalizeText,
  formatChunkedFile,
  formatHashlineChunk,
  hashCanonicalLine,
  hashCanonicalLines,
  hashCanonicalText,
  parseHashlineChunks,
  parseUnifiedHunkHeader,
  unifiedDiff,
} from "../src/hashline.ts";

describe("canonicalization", () => {
  test("line endings normalize before sha256", () => {
    expect(hashCanonicalText("a\r\nb\r\n")).toBe(hashCanonicalText("a\nb\n"));
    expect(hashCanonicalText("a\rb\r")).toBe(hashCanonicalText("a\nb\n"));
    expect(hashCanonicalLines("a\r\nb")[0]).toBe(hashCanonicalLine("a"));
  });

  test("whitespace drift normalizes: indent, tabs, runs, trailing space", () => {
    const base = hashCanonicalLine("return 1;");
    expect(hashCanonicalLine("    return 1;")).toBe(base);
    expect(hashCanonicalLine("\treturn 1;  ")).toBe(base);
    expect(hashCanonicalLine("return   1;")).toBe(base);
    expect(hashCanonicalLine("return\t1;")).toBe(base);
  });

  test("content changes still change the hash", () => {
    expect(hashCanonicalLine("return 1;")).not.toBe(hashCanonicalLine("return 2;"));
    expect(hashCanonicalLine("return 1;")).not.toBe(hashCanonicalLine("return1;"));
  });

  test("canonicalizeLine/canonicalizeText primitives", () => {
    expect(canonicalizeLine("  a   b\t ")).toBe("a b");
    expect(canonicalizeLine("x\r")).toBe("x");
    expect(canonicalizeText("a\r\nb\rc\n")).toBe("a\nb\nc\n");
  });
});

describe("edit-engine still canonicalizes (no regression)", () => {
  test("lone CR line endings match like CRLF", () => {
    const content = "a\rb\rc\r";
    expect(applyEditEngine(content, { oldText: "a\nb", newText: "X" })).toBe("X\rc\r");
  });

  test("engine and hashline module agree on line hashes", () => {
    expect(applyEditEngine("foo(1);", { oldText: "  foo( 1 );", newText: "ok" })).toBe("ok");
  });
});

describe("hashline chunk formatter", () => {
  test("single chunk carries start/end/lines/hash tags", () => {
    const out = formatHashlineChunk(11, ["a", "b"]);
    expect(out).toMatch(/^<hashline start="11" end="12" lines="2" hash="[0-9a-f]{64}">\n/);
    expect(out.endsWith("</hashline>")).toBe(true);
    const parsed = parseHashlineChunks(out);
    expect(parsed.length).toBe(1);
    expect(parsed[0]).toMatchObject({ startLine: 11, endLine: 12, lineCount: 2, valid: true });
    expect(parsed[0]!.text).toBe("a\nb");
  });

  test("chunked file round-trips losslessly with valid hashes", () => {
    const content = Array.from({ length: 120 }, (_, i) => `line ${i + 1}  `).join("\n");
    const formatted = formatChunkedFile(`${content}\n`, 50);
    const chunks = parseHashlineChunks(formatted);
    expect(chunks.length).toBe(3);
    expect(chunks.every((c) => c.valid)).toBe(true);
    expect(chunks.map((c) => c.text).join("\n")).toBe(content);
    expect(chunks[0]).toMatchObject({ startLine: 1, endLine: 50, lineCount: 50 });
    expect(chunks[2]).toMatchObject({ startLine: 101, endLine: 120, lineCount: 20 });
  });

  test("CRLF source verifies against canonical hash", () => {
    const formatted = formatChunkedFile("a\r\nb\r\n", 50);
    const chunks = parseHashlineChunks(formatted);
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.valid).toBe(true);
  });

  test("empty file yields no chunks; tampered hash is invalid", () => {
    expect(formatChunkedFile("")).toBe("");
    expect(parseHashlineChunks("")).toEqual([]);
    const tampered = formatHashlineChunk(1, ["a"]).replace(/hash="[0-9a-f]{64}"/, `hash="${"0".repeat(64)}"`);
    expect(parseHashlineChunks(tampered)[0]!.valid).toBe(false);
  });
});

describe("unified diff @@ counts", () => {
  function assertCounts(diff: string): void {
    const lines = diff.split("\n");
    let i = 0;
    while (i < lines.length) {
      const header = parseUnifiedHunkHeader(lines[i]!);
      if (!header) {
        i += 1;
        continue;
      }
      let oldCount = 0;
      let newCount = 0;
      i += 1;
      while (i < lines.length && lines[i] !== "" && !lines[i]!.startsWith("@@")) {
        const kind = lines[i]![0];
        if (kind === " " || kind === "-") oldCount += 1;
        if (kind === " " || kind === "+") newCount += 1;
        i += 1;
      }
      expect(oldCount).toBe(header.oldCount);
      expect(newCount).toBe(header.newCount);
    }
  }

  test("identical texts produce no diff", () => {
    expect(unifiedDiff("a\nb\n", "a\nb\n")).toBe("");
  });

  test("single-line change has correct counts", () => {
    const diff = unifiedDiff("a\nb\nc\n", "a\nB\nc\n", { context: 3 });
    expect(diff).toContain("@@ -1,3 +1,3 @@");
    assertCounts(diff);
  });

  test("pure addition uses 0,0 old side", () => {
    const diff = unifiedDiff("", "x\ny\n", { context: 3 });
    expect(diff).toContain("@@ -0,0 +1,2 @@");
    assertCounts(diff);
  });

  test("pure deletion uses 0,0 new side", () => {
    const diff = unifiedDiff("x\ny\n", "", { context: 3 });
    expect(diff).toContain("@@ -1,2 +0,0 @@");
    assertCounts(diff);
  });

  test("multi-hunk diff splits with correct counts per hunk", () => {
    const oldText = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"].join("\n");
    const newText = ["1", "TWO", "3", "4", "5", "6", "7", "8", "9", "10", "11", "TWELVE"].join("\n");
    const diff = unifiedDiff(oldText, newText, { context: 1 });
    const headers = diff.split("\n").filter((l) => l.startsWith("@@"));
    expect(headers.length).toBe(2);
    assertCounts(diff);
  });

  test("context 0 keeps counts exact", () => {
    const diff = unifiedDiff("a\nb\nc\n", "a\nB\nc\n", { context: 0 });
    expect(diff).toContain("@@ -2,1 +2,1 @@");
    assertCounts(diff);
  });

  test("CRLF inputs diff on canonical lines", () => {
    const diff = unifiedDiff("a\r\nb\r\n", "a\r\nB\r\n", { context: 3 });
    expect(diff).toContain("@@ -1,2 +1,2 @@");
    assertCounts(diff);
  });
});

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { compactOutput, sliceAtCharBoundary, truncateWithSpill } from "../src/truncate.ts";

test("shell output loses its colour codes, its progress redraws and its runs of one line, and keeps what it says", () => {
  const raw = [
    "\x1b[32m✓ pass\x1b[0m a.test.ts",
    "\x1b]8;;https://x.dev\x07link\x1b]8;;\x07",
    "progress 10%\rprogress 50%\rprogress 100%",
    "warn: deprecated",
    "warn: deprecated",
    "warn: deprecated",
    "warn: deprecated",
    "",
    "",
    "",
    "same",
    "same",
    "done\r\n",
  ].join("\n");
  expect(compactOutput(raw)).toBe(
    [
      "✓ pass a.test.ts",
      "link",
      "progress 100%",
      "warn: deprecated",
      "[the line above 3 more times]",
      "",
      "",
      "",
      "same",
      "same",
      "done",
      "",
    ].join("\n"),
  );
  expect(compactOutput("plain\ntext")).toBe("plain\ntext");
});

describe("sliceAtCharBoundary", () => {
  test("returns full string when within byte limit", () => {
    const buf = Buffer.from("hello", "utf8");
    expect(sliceAtCharBoundary(buf, 10)).toBe("hello");
  });

  test("returns full string at exact byte limit", () => {
    const buf = Buffer.from("hello", "utf8");
    expect(sliceAtCharBoundary(buf, 5)).toBe("hello");
  });

  test("cuts ASCII at exact byte boundary", () => {
    const buf = Buffer.from("hello world", "utf8");
    expect(sliceAtCharBoundary(buf, 5)).toBe("hello");
  });

  test("does not split a 2-byte UTF-8 character", () => {
    // é (U+00E9) is 2 bytes: C3 A9
    // "aéb" = 1 + 2 + 1 = 4 bytes. Cap at 2: lands on 0xA9 (continuation),
    // walks back to 0xC3 (lead byte), end=1 → "a"
    const buf = Buffer.from("aéb", "utf8");
    expect(sliceAtCharBoundary(buf, 2)).toBe("a");
  });

  test("does not split a 3-byte UTF-8 character", () => {
    // あ (U+3042) is 3 bytes: E3 81 82
    // "aあb" = 1 + 3 + 1 = 5 bytes. Cap at 2: lands on 81 (continuation), walks back to byte 1 = "a"
    const buf = Buffer.from("aあb", "utf8");
    expect(sliceAtCharBoundary(buf, 2)).toBe("a");
  });

  test("does not split a 4-byte surrogate pair (emoji)", () => {
    // 😀 (U+1F600) is 4 bytes: F0 9F 98 80
    // "a😀b" = 1 + 4 + 1 = 6 bytes. Cap at 3: lands on 9F (continuation), walks back to byte 1 = "a"
    const buf = Buffer.from("a😀b", "utf8");
    expect(sliceAtCharBoundary(buf, 3)).toBe("a");
  });

  test("keeps surrogate pair intact when it fits", () => {
    // "a😀" = 5 bytes. Cap at 5: fits exactly.
    const buf = Buffer.from("a😀", "utf8");
    expect(sliceAtCharBoundary(buf, 5)).toBe("a😀");
  });

  test("walks back multiple continuation bytes for 4-byte char", () => {
    // 😀 = F0 9F 98 80. Cap at 2: lands on 9F (continuation), walks back to byte 0
    const buf = Buffer.from("😀", "utf8");
    expect(sliceAtCharBoundary(buf, 2)).toBe("");
  });

  test("handles mixed ASCII and multiple surrogate pairs", () => {
    // "x😀y🎉z" = 1 + 4 + 1 + 4 + 1 = 11 bytes
    const buf = Buffer.from("x😀y🎉z", "utf8");
    // Cap at 7: "x😀y" = 6 bytes, byte 7 is start of 🎉 (F0), so we get "x😀y"
    expect(sliceAtCharBoundary(buf, 7)).toBe("x😀y");
    // Cap at 10: "x😀y🎉" = 10 bytes exactly
    expect(sliceAtCharBoundary(buf, 10)).toBe("x😀y🎉");
  });

  test("handles empty buffer", () => {
    const buf = Buffer.from("", "utf8");
    expect(sliceAtCharBoundary(buf, 100)).toBe("");
  });

  test("handles maxBytes larger than buffer", () => {
    const buf = Buffer.from("hi", "utf8");
    expect(sliceAtCharBoundary(buf, 1000)).toBe("hi");
  });
});

describe("truncateWithSpill", () => {
  const notices = {
    truncated: (path: string) => `[Truncated at 10 bytes. Full output at ${path}]`,
    truncatedNoSpill: "[Truncated at 10 bytes. Spill failed]",
  };

  test("returns content unchanged when within byte limit", () => {
    expect(truncateWithSpill("hello", 10, notices)).toBe("hello");
  });

  test("returns content unchanged at exact byte limit", () => {
    expect(truncateWithSpill("1234567890", 10, notices)).toBe("1234567890");
  });

  test("truncates and spills oversized content with surrogate pair boundary", () => {
    // 😀 = 4 bytes. "a😀bc" = 1 + 4 + 1 + 1 = 7 bytes.
    // Cap at 5: 2 bytes of the start ("a", the emoji does not fit) and 2 bytes of the end ("bc").
    const result = truncateWithSpill("a😀bc", 5, notices);
    expect(result.startsWith("a\n")).toBe(true);
    expect(result).toContain("\nbc\n");
    expect(result.includes("\uFFFD")).toBe(false);
    expect(result).toContain("[Truncated at 10 bytes");
    // The spill file should exist
    const spillMatch = result.match(/Full output at (.+\.txt)/);
    expect(spillMatch).not.toBeNull();
    if (spillMatch) {
      const spillPath = spillMatch[1]!;
      expect(existsSync(spillPath)).toBe(true);
      expect(readFileSync(spillPath, "utf8")).toBe("a😀bc");
      unlinkSync(spillPath);
    }
  });

  test("truncates at surrogate pair boundary walking back", () => {
    // 😀 = 4 bytes. "a😀b" = 6 bytes. Cap at 3: walks back to byte 1 = "a"
    const result = truncateWithSpill("a😀b", 3, notices);
    expect(result.startsWith("a")).toBe(true);
    expect(result.includes("😀")).toBe(false);
    expect(result.includes("\uFFFD")).toBe(false);
    expect(result).toContain("[Truncated at 10 bytes");
  });

  test("keeps the start and the end of a long output: the error of a test run is at the end", () => {
    const content = `first line\n${"x".repeat(5000)}\nFAIL the last line`;
    const out = truncateWithSpill(content, 1000, notices);
    expect(out.startsWith("first line\n")).toBe(true);
    expect(out).toContain("FAIL the last line");
    expect(out).toMatch(/\[\.\.\. \d+ bytes omitted \.\.\.\]/);
    const kept = out.slice(0, out.lastIndexOf("\n"));
    expect(Buffer.byteLength(kept)).toBeLessThanOrEqual(1000 + 40);
    const spill = out.match(/Full output at (.+\.txt)/)?.[1];
    if (spill) unlinkSync(spill);
  });

  test("does not cut a character in two at the start of the kept end", () => {
    const out = truncateWithSpill(`${"a".repeat(999)}${"é".repeat(600)}`, 1000, notices);
    expect(out.includes("\uFFFD")).toBe(false);
    const spill = out.match(/Full output at (.+\.txt)/)?.[1];
    if (spill) unlinkSync(spill);
  });

  test("passes through content within limit with surrogate pairs", () => {
    expect(truncateWithSpill("😀🎉", 8, notices)).toBe("😀🎉");
  });
});

test("a run of passing test lines becomes one line, and failures and summaries stay word for word", () => {
  const cargo = [
    "running 4 tests",
    "test parse::empty ... ok",
    "test parse::nested ... ok",
    "test parse::unicode ... ok",
    "test parse::broken ... FAILED",
    "",
    "test result: FAILED. 3 passed; 1 failed",
  ];
  expect(compactOutput(cargo.join("\n"))).toBe(
    [
      "running 4 tests",
      "[3 lines of passing tests or checks]",
      "test parse::broken ... FAILED",
      "",
      "test result: FAILED. 3 passed; 1 failed",
    ].join("\n"),
  );
  const pytest = [
    "tests/test_a.py::test_one PASSED                [ 25%]",
    "tests/test_a.py::test_two PASSED                [ 50%]",
    "tests/test_a.py::test_three PASSED              [ 75%]",
    "tests/test_a.py::test_four FAILED               [100%]",
  ];
  expect(compactOutput(pytest.join("\n")).split("\n")).toEqual([
    "[3 lines of passing tests or checks]",
    "tests/test_a.py::test_four FAILED               [100%]",
  ]);
  const go = [
    "=== RUN   TestA",
    "--- PASS: TestA (0.00s)",
    "=== RUN   TestB",
    "    b_test.go:9: want 2, got 3",
    "--- FAIL: TestB (0.00s)",
  ];
  expect(compactOutput(go.join("\n")).split("\n")).toEqual([
    "[3 lines of passing tests or checks]",
    "    b_test.go:9: want 2, got 3",
    "--- FAIL: TestB (0.00s)",
  ]);
  const jest = ["PASS src/a.test.ts", "  ✓ adds (2 ms)", "  ✓ subtracts", "  ✕ divides (4 ms)"];
  expect(compactOutput(jest.join("\n")).split("\n")).toEqual([
    "[3 lines of passing tests or checks]",
    "  ✕ divides (4 ms)",
  ]);
  // Two lines cost less than the note.
  expect(compactOutput("test a ... ok\ntest b ... ok")).toBe("test a ... ok\ntest b ... ok");
});

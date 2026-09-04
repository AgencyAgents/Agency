import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { sliceAtCharBoundary, truncateWithSpill } from "../src/truncate.ts";

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
    // Cap at 5: "a😀" = 5 bytes exactly, fits.
    const result = truncateWithSpill("a😀bc", 5, notices);
    expect(result).toContain("a😀");
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

  test("passes through content within limit with surrogate pairs", () => {
    expect(truncateWithSpill("😀🎉", 8, notices)).toBe("😀🎉");
  });
});

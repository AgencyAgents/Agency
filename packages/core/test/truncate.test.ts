import { describe, expect, test } from "bun:test";
import {
  TRUNCATE_MAX_BYTES,
  TRUNCATE_MAX_LINES,
  truncateOutput,
  truncateToolResults,
} from "../src/truncate.ts";

describe("truncateOutput", () => {
  test("returns content unchanged when within both limits", () => {
    expect(truncateOutput("short output")).toEqual({ content: "short output", truncated: false });
  });

  test("returns content unchanged at exactly the limits", () => {
    const lines = Array.from({ length: TRUNCATE_MAX_LINES }, (_, i) => `line ${i}`).join("\n");
    expect(truncateOutput(lines).truncated).toBe(false);
    expect(truncateOutput("x".repeat(TRUNCATE_MAX_BYTES)).truncated).toBe(false);
  });

  test("keeps the first maxLines lines and appends the lines notice", () => {
    const content = Array.from({ length: 3_000 }, (_, i) => `line ${i + 1}`).join("\n");
    const { content: out, truncated } = truncateOutput(content);

    expect(truncated).toBe(true);
    const lines = out.split("\n");
    expect(lines).toHaveLength(TRUNCATE_MAX_LINES + 1);
    expect(lines[0]).toBe("line 1");
    expect(lines[TRUNCATE_MAX_LINES - 1]).toBe(`line ${TRUNCATE_MAX_LINES}`);
    expect(lines[TRUNCATE_MAX_LINES]).toBe("[Output truncated at 2000 lines. 1000 more lines omitted]");
  });

  test("caps bytes and appends the bytes notice without splitting a character", () => {
    const content = "あ".repeat(16_667); // 3-byte chars: 50,001 bytes, one over the cap
    const { content: out, truncated } = truncateOutput(content);

    expect(truncated).toBe(true);
    expect(out).toContain("[Output truncated at 50000 bytes]");
    const body = out.split("\n")[0]!;
    expect(body).toBe("あ".repeat(16_666)); // 49,998 bytes: walked back off the split char
    expect(out.includes("\uFFFD")).toBe(false);
  });

  test("honors custom limits", () => {
    expect(truncateOutput("a\nb\nc\nd\ne", 1_000, 3).content).toBe(
      "a\nb\nc\n[Output truncated at 3 lines. 2 more lines omitted]",
    );
    expect(truncateOutput("abcdef", 3, 100).content).toBe("abc\n[Output truncated at 3 bytes]");
  });

  test("does not split a surrogate pair (4-byte UTF-8 char) at the byte cap", () => {
    // 😀 (U+1F600) is 4 bytes in UTF-8: F0 9F 98 80
    // "a😀b" is 1 + 4 + 1 = 6 bytes. Cap at 3: lands on 0x98 (continuation),
    // walks back past 0x9F (continuation) to 0xF0 (lead byte), end=1 → "a"
    const content = "a😀b";
    const { content: out, truncated } = truncateOutput(content, 3, 100);
    expect(truncated).toBe(true);
    expect(out).toContain("[Output truncated at 3 bytes]");
    expect(out.includes("\uFFFD")).toBe(false);
    expect(out).toBe("a\n[Output truncated at 3 bytes]");
  });

  test("keeps a surrogate pair intact when it fits within the byte cap", () => {
    // "a😀b" = 6 bytes. Cap at 6 should keep everything.
    const content = "a😀b";
    const { content: out, truncated } = truncateOutput(content, 6, 100);
    expect(truncated).toBe(false);
    expect(out).toBe("a😀b");
  });

  test("handles multiple surrogate pairs with mixed ASCII at the boundary", () => {
    // 😀 = 4 bytes, 🎉 (U+1F389) = 4 bytes
    // "x😀y🎉z" = 1 + 4 + 1 + 4 + 1 = 11 bytes
    // Cap at 10 bytes: should keep "x😀y" (1+4+1=6 bytes) and walk back from split
    // Actually at 10 bytes: bytes 0-9 = "x😀y🎉" is 1+4+1+4=10 bytes exactly
    const content = "x😀y🎉z";
    const { content: out, truncated } = truncateOutput(content, 10, 100);
    expect(truncated).toBe(true);
    expect(out.includes("\uFFFD")).toBe(false);
    // At exactly 10 bytes: "x😀y🎉" = 10 bytes, fits perfectly
    expect(out.startsWith("x😀y🎉")).toBe(true);
  });

  test("walks back from a split surrogate pair leaving only complete characters", () => {
    // 😀 = 4 bytes (F0 9F 98 80). "a😀" = 5 bytes.
    // Cap at 3 bytes: would land in the middle of 😀, walk back to byte 1 = "a"
    const content = "a😀bc";
    const { content: out, truncated } = truncateOutput(content, 3, 100);
    expect(truncated).toBe(true);
    expect(out).toContain("[Output truncated at 3 bytes]");
    expect(out.startsWith("a")).toBe(true);
    expect(out.includes("😀")).toBe(false);
    expect(out.includes("\uFFFD")).toBe(false);
  });
});

describe("truncateToolResults", () => {
  test("passes small results through untouched, images included", () => {
    const image = { type: "image", mimeType: "image/png", data: "aGk=" };
    const results = [{ content: "tiny", isError: false, images: [image] }];
    expect(truncateToolResults(results)).toEqual(results);
  });

  test("truncates oversized successful results with the standard notice", () => {
    const [result] = truncateToolResults([{ content: "y".repeat(TRUNCATE_MAX_BYTES + 1), isError: false }]);
    expect(result!.content).toContain("[Output truncated at 50000 bytes]");
    expect(result!.isError).toBe(false);
  });

  test("truncates oversized error results with the error notice instead", () => {
    const [result] = truncateToolResults([{ content: "e".repeat(TRUNCATE_MAX_BYTES + 1), isError: true }]);
    expect(result!.content).toContain("[Error output truncated at 50000 bytes]");
    expect(result!.content).not.toContain("[Output truncated at");
  });

  test("truncates oversized error results by line count too", () => {
    const content = Array.from({ length: 3_000 }, (_, i) => `err ${i}`).join("\n");
    const [result] = truncateToolResults([{ content, isError: true }]);
    expect(result!.content).toContain("[Error output truncated at 2000 lines. 1000 more lines omitted]");
  });
});

import { describe, expect, test } from "bun:test";
import { DifferentialRenderer, detectCapabilities, reflow, visibleWidth } from "../src/renderer.ts";

function capture(): { chunks: string[]; write: (chunk: string) => void; text: () => string } {
  const chunks: string[] = [];
  return {
    chunks,
    write: (chunk) => chunks.push(chunk),
    text: () => chunks.join(""),
  };
}

describe("detectCapabilities", () => {
  test("NO_COLOR disables color even on a TTY", () => {
    const caps = detectCapabilities({ env: { NO_COLOR: "1" }, isTTY: true, columns: 120 });
    expect(caps.mode).toBe("tty");
    expect(caps.colorEnabled).toBe(false);
    expect(caps.width).toBe(120);
  });

  test("non-TTY output degrades to linear mode without color", () => {
    const caps = detectCapabilities({ env: {}, isTTY: false });
    expect(caps.mode).toBe("linear");
    expect(caps.colorEnabled).toBe(false);
    expect(caps.width).toBe(80);
  });

  test("AGENCY_SCREEN_READER wins over everything and never emits color", () => {
    const caps = detectCapabilities({
      env: { AGENCY_SCREEN_READER: "true", FORCE_COLOR: "1" },
      isTTY: true,
      columns: 100,
    });
    expect(caps.mode).toBe("screen-reader");
    expect(caps.colorEnabled).toBe(false);
  });

  test("FORCE_COLOR forces color on for pipes, FORCE_COLOR=0 keeps it off", () => {
    const forced = detectCapabilities({ env: { FORCE_COLOR: "1" }, isTTY: false });
    expect(forced.colorEnabled).toBe(true);
    const zeroed = detectCapabilities({ env: { FORCE_COLOR: "0" }, isTTY: true });
    expect(zeroed.colorEnabled).toBe(false);
  });
});

describe("visibleWidth", () => {
  test("ANSI escapes contribute zero width", () => {
    expect(visibleWidth("\x1b[36mhello\x1b[0m")).toBe(5);
    expect(visibleWidth("a\x1b[2Kb")).toBe(2);
    expect(visibleWidth("")).toBe(0);
  });

  test("CJK, kana, Hangul, and fullwidth forms count two columns", () => {
    expect(visibleWidth("你好")).toBe(4);
    expect(visibleWidth("カタカナ")).toBe(8);
    expect(visibleWidth("한글")).toBe(4);
    expect(visibleWidth("ＡＢ")).toBe(4);
    expect(visibleWidth("x你好x")).toBe(6);
  });

  test("emoji count two columns and ZWJ sequences stay compose-safe", () => {
    expect(visibleWidth("👍")).toBe(2);
    expect(visibleWidth("🚀x")).toBe(3);
    expect(visibleWidth("✅\ufe0f")).toBe(2);
    expect(visibleWidth("👨\u200d👩\u200d👧")).toBe(6);
  });

  test("combining marks, zero-width, and control characters count zero", () => {
    expect(visibleWidth("e\u0301")).toBe(1);
    expect(visibleWidth("가\u0301")).toBe(2);
    expect(visibleWidth("a\u200bb")).toBe(2);
    expect(visibleWidth("\t\n")).toBe(0);
  });

  test("styled wide text measures the visible glyphs only", () => {
    expect(visibleWidth("\x1b[36m你好\x1b[0m")).toBe(4);
  });
});

describe("reflow", () => {
  test("wraps on word boundaries so no line exceeds the width", () => {
    const wrapped = reflow("the quick brown fox jumps over the lazy dog again and again", 20);
    const lines = wrapped.split("\n");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(20);
    }
    expect(lines[0]).toBe("the quick brown fox");
  });

  test("hard-breaks words longer than the width and preserves blank lines", () => {
    const wrapped = reflow("supercalifragilisticexpialidocious\n\nshort tail", 10);
    const lines = wrapped.split("\n");
    expect(lines).toEqual(["supercalif", "ragilistic", "expialidoc", "ious", "", "short tail"]);
  });

  test("wraps CJK text by display width, not code unit count", () => {
    expect(reflow("一二三四五六", 4)).toBe("一二\n三四\n五六");
    expect(reflow("hello 你好世界 world", 12)).toBe("hello\n你好世界\nworld");
  });

  test("hard-breaks wide text without splitting a wide character across lines", () => {
    expect(reflow("xx你好世界yy", 4)).toBe("xx你\n好世\n界yy");
  });

  test("styled text wraps by visible width: every line fits the column budget", () => {
    const styled = "\x1b[36m你好世界 你好世界\x1b[0m";
    const lines = reflow(styled, 7).split("\n");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(7);
    }
  });
});

describe("DifferentialRenderer", () => {
  function syncRenderer(out: ReturnType<typeof capture>, mode: "tty" | "linear" = "tty") {
    return new DifferentialRenderer({
      write: out.write,
      mode,
      colorEnabled: false,
      width: 80,
      intervalMs: 0,
    });
  }

  test("first tty paint writes every line with CRLF endings (Windows Terminal VT safe)", () => {
    const out = capture();
    const renderer = syncRenderer(out);
    renderer.paint(["one", "two"]);
    expect(out.text()).toBe("\x1b[2Kone\r\n\x1b[2Ktwo\r\n");
  });

  test("second tty paint emits cursor-up once and erases only the changed line", () => {
    const out = capture();
    const renderer = syncRenderer(out);
    renderer.paint(["one", "two", "three"]);
    out.chunks.length = 0;
    renderer.paint(["one", "TWO", "three"]);
    const text = out.text();
    expect(text.startsWith("\x1b[3A")).toBe(true);
    expect(text.split("\x1b[2K").length - 1).toBe(1);
    expect(text).toContain("TWO");
    expect(text).not.toContain("one\r\n\x1b[2K");
  });

  test("repainting an identical tty frame emits no erase sequences", () => {
    const out = capture();
    const renderer = syncRenderer(out);
    renderer.paint(["same", "lines"]);
    out.chunks.length = 0;
    renderer.paint(["same", "lines"]);
    expect(out.text()).toBe("\x1b[2A\r\n\r\n");
    expect(out.text()).not.toContain("\x1b[2K");
  });

  test("shrinking a tty frame clears the orphaned trailing lines", () => {
    const out = capture();
    const renderer = syncRenderer(out);
    renderer.paint(["a", "b", "c"]);
    out.chunks.length = 0;
    renderer.paint(["a"]);
    const text = out.text();
    expect(text.startsWith("\x1b[3A")).toBe(true);
    expect(text.split("\x1b[2K").length - 1).toBe(2);
    expect(text.endsWith("\x1b[2A")).toBe(true);
  });

  test("linear mode appends only new lines and never emits cursor control", () => {
    const out = capture();
    const renderer = syncRenderer(out, "linear");
    renderer.paint(["one", "two"]);
    renderer.paint(["one", "two", "three"]);
    renderer.paint(["one", "two", "three"]);
    expect(out.text()).toBe("one\ntwo\nthree\n");
    expect(out.text()).not.toContain("\x1b[");
  });

  test("linear mode after a frame shrink continues appending from the new tail", () => {
    const out = capture();
    const renderer = syncRenderer(out, "linear");
    renderer.paint(["a", "b", "c"]);
    renderer.paint(["a", "collapsed"]);
    renderer.paint(["a", "collapsed", "after"]);
    expect(out.text()).toBe("a\nb\nc\nafter\n");
  });
});

describe("DifferentialRenderer throttle", () => {
  test("rapid paints coalesce: leading paint writes, trailing flush carries the latest frame", async () => {
    const out = capture();
    const renderer = new DifferentialRenderer({
      write: out.write,
      mode: "tty",
      colorEnabled: false,
      width: 80,
      intervalMs: 25,
    });
    renderer.paint(["a"]);
    renderer.paint(["a", "b"]);
    expect(out.text()).toBe("\x1b[2Ka\r\n");
    await Bun.sleep(80);
    expect(out.text()).toBe("\x1b[2Ka\r\n\x1b[1A\r\n\x1b[2Kb\r\n");
  });

  test("flush() writes the pending frame synchronously", () => {
    const out = capture();
    const renderer = new DifferentialRenderer({
      write: out.write,
      mode: "tty",
      colorEnabled: false,
      width: 80,
      intervalMs: 25,
    });
    renderer.paint(["a"]);
    out.chunks.length = 0;
    renderer.paint(["a", "b"]);
    expect(out.text()).toBe("");
    renderer.flush();
    expect(out.text()).toBe("\x1b[1A\r\n\x1b[2Kb\r\n");
    renderer.flush();
    expect(out.text()).toBe("\x1b[1A\r\n\x1b[2Kb\r\n");
  });

  test("reset() drops the pending frame so nothing stale is written", () => {
    const out = capture();
    const renderer = new DifferentialRenderer({
      write: out.write,
      mode: "tty",
      colorEnabled: false,
      width: 80,
      intervalMs: 25,
    });
    renderer.paint(["a"]);
    renderer.paint(["a", "stale"]);
    renderer.reset();
    expect(out.text()).toBe("\x1b[2Ka\r\n");
    renderer.flush();
    expect(out.text()).toBe("\x1b[2Ka\r\n");
  });

  test("throttled linear mode never loses lines, only delays them", async () => {
    const out = capture();
    const renderer = new DifferentialRenderer({
      write: out.write,
      mode: "linear",
      colorEnabled: false,
      width: 80,
      intervalMs: 25,
    });
    renderer.paint(["one", "two"]);
    renderer.paint(["one", "two", "three"]);
    renderer.paint(["one", "two", "three", "four"]);
    expect(out.text()).toBe("one\ntwo\n");
    await Bun.sleep(80);
    expect(out.text()).toBe("one\ntwo\nthree\nfour\n");
    expect(out.text()).not.toContain("\x1b[");
  });
});

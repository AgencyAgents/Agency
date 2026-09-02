import type { RenderMode } from "./theme.ts";

export type { RenderMode };

/** What the environment can do, decided once at startup from env + stream. */
export interface TerminalCapabilities {
  mode: RenderMode;
  colorEnabled: boolean;
  width: number;
}

export interface DetectOptions {
  /** process.env (or a test fixture). */
  env: Record<string, string | undefined>;
  /** Whether the output stream is a TTY. */
  isTTY: boolean;
  /** Terminal width in columns, when known. */
  columns?: number;
}

function envFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false";
}

/**
 * Single source of truth for degradation (R14): screen-reader env wins first,
 * then TTY-ness decides tty vs linear, then NO_COLOR/FORCE_COLOR decide color.
 * Width defaults to 80 so narrow terminals and CI pipes reflow identically.
 */
export function detectCapabilities(options: DetectOptions): TerminalCapabilities {
  const { env, isTTY } = options;
  const screenReader = envFlag(env.AGENCY_SCREEN_READER);
  const width = options.columns && options.columns > 0 ? options.columns : 80;

  if (screenReader) {
    return { mode: "screen-reader", colorEnabled: false, width };
  }

  let colorEnabled = isTTY;
  if (env.NO_COLOR !== undefined) colorEnabled = false;
  if (env.FORCE_COLOR !== undefined) colorEnabled = env.FORCE_COLOR !== "0";

  return { mode: isTTY ? "tty" : "linear", colorEnabled, width };
}

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI_PATTERN = new RegExp(`${ESC}(?:\\[[0-9;?]*[ -/]*[@-~]|\\][^${BEL}]*${BEL})`, "g");

/**
 * Code-point ranges that occupy two terminal columns: East Asian Wide and
 * Fullwidth plus the emoji blocks terminals overwhelmingly present as wide.
 * Hand-maintained (no wcwidth dependency), trimmed to the ranges that
 * actually reach a terminal, sorted ascending for binary search.
 */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo leading consonants
  [0x2329, 0x232a], // angle brackets
  [0x231a, 0x231b], // watch, hourglass
  [0x23e9, 0x23f3], // media control emoji
  [0x23f8, 0x23fa],
  [0x25fd, 0x25fe], // small squares
  [0x2614, 0x2615], // umbrella, hot beverage
  [0x2648, 0x2653], // zodiac
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e], // CJK radicals through CJK symbols/punctuation
  [0x3041, 0x33ff], // Hiragana .. CJK compatibility
  [0x3400, 0x4dbf], // CJK extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xa000, 0xa4cf], // Yi syllables/radicals
  [0xa960, 0xa97f], // Hangul Jamo extended-A
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe10, 0xfe19], // vertical forms
  [0xfe30, 0xfe6f], // CJK compatibility forms
  [0xff00, 0xff60], // fullwidth forms
  [0xffe0, 0xffe6], // fullwidth signs
  [0x1f004, 0x1f004], // mahjong tile
  [0x1f0cf, 0x1f0cf], // playing card joker
  [0x1f18e, 0x1f18e], // AB button
  [0x1f191, 0x1f19a], // CL/COOL/etc buttons
  [0x1f200, 0x1f202], // squared ideographs
  [0x1f210, 0x1f23b],
  [0x1f240, 0x1f244],
  [0x1f250, 0x1f251],
  [0x1f260, 0x1f265],
  [0x1f300, 0x1f320], // pictographs (Emoji_Presentation blocks)
  [0x1f32d, 0x1f335],
  [0x1f337, 0x1f37c],
  [0x1f37e, 0x1f393],
  [0x1f3a0, 0x1f3ca],
  [0x1f3cf, 0x1f3d3],
  [0x1f3e0, 0x1f3f0],
  [0x1f3f4, 0x1f3f4],
  [0x1f3f8, 0x1f43e],
  [0x1f440, 0x1f440], // eyes
  [0x1f442, 0x1f4fc],
  [0x1f4ff, 0x1f53d],
  [0x1f54b, 0x1f54e],
  [0x1f550, 0x1f567],
  [0x1f57a, 0x1f57a],
  [0x1f595, 0x1f596],
  [0x1f5a4, 0x1f5a4],
  [0x1f5fb, 0x1f64f], // landmarks through emoticons
  [0x1f680, 0x1f6c5], // transport & map
  [0x1f6cc, 0x1f6cc],
  [0x1f6d0, 0x1f6d2],
  [0x1f6d5, 0x1f6d7],
  [0x1f6eb, 0x1f6ec],
  [0x1f6f4, 0x1f6fc],
  [0x1f7e0, 0x1f7eb], // colored circles/squares
  [0x1f90c, 0x1f93a],
  [0x1f93c, 0x1f945],
  [0x1f947, 0x1f978],
  [0x1f97a, 0x1f9cb],
  [0x1f9cd, 0x1f9ff],
  [0x1fa70, 0x1fa74],
  [0x1fa78, 0x1fa7a],
  [0x1fa80, 0x1fa86],
  [0x1fa90, 0x1faa8],
  [0x1fab0, 0x1fab6],
  [0x1fac0, 0x1fac2],
  [0x1fad0, 0x1fad6],
  [0x20000, 0x2fffd], // CJK extensions B-F
  [0x30000, 0x3fffd], // CJK extensions G+
];

function isWideCodePoint(code: number): boolean {
  let lo = 0;
  let hi = WIDE_RANGES.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const range = WIDE_RANGES[mid]!;
    if (code < range[0]) {
      hi = mid - 1;
    } else if (code > range[1]) {
      lo = mid + 1;
    } else {
      return true;
    }
  }
  return false;
}

const COMBINING_MARK = /\p{M}/u;

/**
 * Terminal columns a single code point occupies: 2 for wide/fullwidth
 * characters and most emoji, 0 for combining marks, zero-width joiners,
 * variation selectors, and control characters, 1 otherwise.
 */
export function charWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  if (code === 0) return 0;
  if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return 0; // C0/C1 controls
  if (code === 0x200b || code === 0x200c || code === 0x200d || code === 0xfeff) return 0; // zero-width
  if (code >= 0xfe00 && code <= 0xfe0f) return 0; // variation selectors
  if (COMBINING_MARK.test(ch)) return 0;
  return isWideCodePoint(code) ? 2 : 1;
}

/** Display width in terminal cells: ANSI stripped, then per-code-point widths. */
export function visibleWidth(text: string): number {
  const clean = text.indexOf(ESC) === -1 ? text : text.replace(ANSI_PATTERN, "");
  let total = 0;
  for (const ch of clean) total += charWidth(ch);
  return total;
}

/**
 * Greedy word wrap to a column budget. Widths are display widths (a CJK or
 * emoji character costs 2 columns, combining marks 0), words longer than the
 * budget are hard-broken at column boundaries so no visible line exceeds the
 * width; explicit newlines and blank lines are preserved.
 */
export function reflow(text: string, width: number): string {
  const effective = Math.max(1, Math.floor(width));
  const out: string[] = [];

  for (const paragraph of text.split("\n")) {
    if (paragraph.trim() === "") {
      out.push("");
      continue;
    }

    let line = "";
    let lineWidth = 0;
    for (const word of paragraph.split(/ +/)) {
      const wordWidth = visibleWidth(word);
      if (lineWidth > 0 && lineWidth + 1 + wordWidth <= effective) {
        line += ` ${word}`;
        lineWidth += 1 + wordWidth;
        continue;
      }
      if (lineWidth > 0) {
        out.push(line);
        line = "";
        lineWidth = 0;
      }
      if (wordWidth > effective) {
        let chunk = "";
        let chunkWidth = 0;
        for (const ch of word) {
          const w = charWidth(ch);
          if (chunkWidth + w > effective) {
            if (chunk !== "") out.push(chunk);
            chunk = "";
            chunkWidth = 0;
          }
          chunk += ch;
          chunkWidth += w;
        }
        line = chunk;
        lineWidth = chunkWidth;
      } else {
        line = word;
        lineWidth = wordWidth;
      }
    }
    if (line.length > 0 || out.length === 0) out.push(line);
  }

  return out.join("\n");
}

export interface DifferentialRendererOptions {
  /** Sink for every byte the renderer emits (stdout, a pipe, or a test buffer). */
  write: (chunk: string) => void;
  mode: RenderMode;
  colorEnabled: boolean;
  width: number;
  /**
   * Minimum milliseconds between writes (frame throttle, ~60fps at 16).
   * Rapid paints coalesce: the newest frame wins. 0 restores synchronous
   * write-per-paint (tests, final shutdown flushes).
   */
  intervalMs?: number;
}

/**
 * Owns the paint path. Each paint diffs the new frame against the previous
 * one: in tty mode it emits cursor-up plus erase-and-rewrite only for lines
 * that changed (standard CSI, CRLF line endings, so Windows Terminal's VT
 * handling is happy); in linear and screen-reader modes it appends only the
 * lines the previous frame did not have, with no cursor control at all.
 *
 * Paints are throttled to one write per `intervalMs` (leading edge immediate,
 * trailing edge carries the latest frame) so a fast token stream cannot
 * repaint per token. Intermediate tty frames are skipped safely because the
 * diff always runs against the last written frame; in linear mode every line
 * is still appended exactly once, in order.
 */
export class DifferentialRenderer {
  readonly mode: RenderMode;
  readonly colorEnabled: boolean;
  readonly width: number;

  private readonly write: (chunk: string) => void;
  private readonly intervalMs: number;
  private previous: string[] = [];
  private pending: string[] | undefined;
  private lastPaintAt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: DifferentialRendererOptions) {
    this.write = options.write;
    this.mode = options.mode;
    this.colorEnabled = options.colorEnabled;
    this.width = options.width;
    this.intervalMs = Math.max(0, options.intervalMs ?? 16);
  }

  /** Paints a frame of already-styled lines. */
  paint(lines: string[]): void {
    if (this.intervalMs === 0) {
      this.paintNow(lines);
      return;
    }
    this.pending = lines;
    if (this.timer !== undefined) return;
    const elapsed = Date.now() - this.lastPaintAt;
    if (elapsed >= this.intervalMs) {
      this.flush();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, this.intervalMs - elapsed);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Writes any pending frame now (final paint on shutdown, synchronous tests). */
  flush(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const lines = this.pending;
    if (lines === undefined) return;
    this.pending = undefined;
    this.lastPaintAt = Date.now();
    this.paintNow(lines);
  }

  /** Forgets the previous frame so the next paint repaints everything. */
  reset(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.pending = undefined;
    this.previous = [];
  }

  private paintNow(lines: string[]): void {
    if (this.mode === "tty") {
      this.paintTty(lines);
    } else {
      this.paintLinear(lines);
    }
  }

  private paintTty(lines: string[]): void {
    const prev = this.previous;
    let out = "";
    if (prev.length > 0) out += `\x1b[${prev.length}A`;

    for (let i = 0; i < lines.length; i++) {
      if (i >= prev.length || prev[i] !== lines[i]) out += `\x1b[2K${lines[i]}`;
      out += "\r\n";
    }

    const shrunk = prev.length - lines.length;
    for (let i = 0; i < shrunk; i++) out += "\x1b[2K\r\n";
    if (shrunk > 0) out += `\x1b[${shrunk}A`;

    this.previous = [...lines];
    if (out.length > 0) this.write(out);
  }

  private paintLinear(lines: string[]): void {
    const base = this.previous.length;
    let out = "";
    if (lines.length > base) out = `${lines.slice(base).join("\n")}\n`;
    this.previous = [...lines];
    if (out.length > 0) this.write(out);
  }
}

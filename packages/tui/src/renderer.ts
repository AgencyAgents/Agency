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

/** Display width of a string with ANSI escape sequences excluded. */
export function visibleWidth(text: string): number {
  return text.replace(ANSI_PATTERN, "").length;
}

/**
 * Greedy word wrap to a column budget. Words longer than the budget are
 * hard-broken so no visible line exceeds the width; explicit newlines and
 * blank lines are preserved.
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
    for (const word of paragraph.split(/ +/)) {
      if (line.length > 0 && line.length + 1 + word.length <= effective) {
        line += ` ${word}`;
        continue;
      }
      if (line.length > 0) {
        out.push(line);
        line = "";
      }
      let rest = word;
      while (rest.length > effective) {
        out.push(rest.slice(0, effective));
        rest = rest.slice(effective);
      }
      line = rest;
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
}

/**
 * Owns the paint path. Each paint diffs the new frame against the previous
 * one: in tty mode it emits cursor-up plus erase-and-rewrite only for lines
 * that changed (standard CSI, CRLF line endings, so Windows Terminal's VT
 * handling is happy); in linear and screen-reader modes it appends only the
 * lines the previous frame did not have, with no cursor control at all.
 */
export class DifferentialRenderer {
  readonly mode: RenderMode;
  readonly colorEnabled: boolean;
  readonly width: number;

  private readonly write: (chunk: string) => void;
  private previous: string[] = [];

  constructor(options: DifferentialRendererOptions) {
    this.write = options.write;
    this.mode = options.mode;
    this.colorEnabled = options.colorEnabled;
    this.width = options.width;
  }

  /** Paints a frame of already-styled lines. */
  paint(lines: string[]): void {
    if (this.mode === "tty") {
      this.paintTty(lines);
    } else {
      this.paintLinear(lines);
    }
  }

  /** Forgets the previous frame so the next paint repaints everything. */
  reset(): void {
    this.previous = [];
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

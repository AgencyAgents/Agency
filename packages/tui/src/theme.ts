import { type MessageKey, t } from "@agency/i18n";

/**
 * How output reaches the user. "tty" is the full differential ANSI path,
 * "linear" is append-only plain output for pipes and files, "screen-reader"
 * is linear output where every visual signal also exists as a word.
 */
export type RenderMode = "tty" | "linear" | "screen-reader";

/** The five semantic styles the transcript uses. Every style pairs a color with a non-color cue. */
export type StyleKind = "accent" | "dim" | "error" | "success" | "warning";

/** SGR foreground codes per style kind. One accent (cyan) plus four states. */
export interface Palette {
  accent: number;
  dim: number;
  error: number;
  success: number;
  warning: number;
}

export const DEFAULT_PALETTE: Palette = {
  accent: 36,
  dim: 90,
  error: 31,
  success: 32,
  warning: 33,
};

/**
 * The non-color half of a style: a glyph prepended in tty/linear modes and a
 * spoken word (via i18n) prepended in screen-reader mode. Color never carries
 * meaning alone: if you can see the color you also see the glyph, and if you
 * can't, you hear the word.
 */
export interface Cue {
  glyph: string;
  wordKey: MessageKey;
}

const CUES: Record<StyleKind, Cue> = {
  accent: { glyph: ">", wordKey: "tui.cue.accent" },
  dim: { glyph: "~", wordKey: "tui.cue.dim" },
  error: { glyph: "x", wordKey: "tui.cue.error" },
  success: { glyph: "+", wordKey: "tui.cue.success" },
  warning: { glyph: "!", wordKey: "tui.cue.warning" },
};

export interface Theme {
  palette: Palette;
  /** The non-color cue for a style kind. */
  cue(kind: StyleKind): Cue;
  /** The localized spoken word for a style kind (screen-reader mode). */
  cueWord(kind: StyleKind): string;
  /**
   * Renders text in a style for tty/linear modes: glyph prefix, ANSI color
   * when colors are enabled. Screen-reader mode uses `styledWord` instead.
   */
  style(kind: StyleKind, text: string, colorEnabled: boolean): string;
  /** Screen-reader rendering: spoken cue word, never color, never glyphs. */
  styledWord(kind: StyleKind, text: string): string;
}

export function createTheme(palette: Palette = DEFAULT_PALETTE): Theme {
  return {
    palette,
    cue(kind) {
      return CUES[kind];
    },
    cueWord(kind) {
      return t(CUES[kind].wordKey);
    },
    style(kind, text, colorEnabled) {
      const glyph = `${CUES[kind].glyph} `;
      if (!colorEnabled) return glyph + text;
      return `${glyph}\x1b[${palette[kind]}m${text}\x1b[0m`;
    },
    styledWord(kind, text) {
      return `${this.cueWord(kind)} ${text}`;
    },
  };
}

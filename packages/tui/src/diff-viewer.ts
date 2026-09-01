import { t } from "@agency/i18n";
import { createTheme, type RenderMode, type StyleKind, type Theme } from "./theme.ts";

export type DiffLineKind = "context" | "added" | "removed";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldNumber?: number;
  newNumber?: number;
}

export interface DiffStats {
  added: number;
  removed: number;
}

/** Simple line diff: finds common prefix/suffix then marks middle as changed. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const lines: DiffLine[] = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    const av = a[i];
    const bv = b[i];
    if (av === undefined && bv !== undefined) {
      lines.push({ kind: "added", text: bv, newNumber: i + 1 });
    } else if (bv === undefined && av !== undefined) {
      lines.push({ kind: "removed", text: av, oldNumber: i + 1 });
    } else if (av === bv && av !== undefined) {
      lines.push({ kind: "context", text: av, oldNumber: i + 1, newNumber: i + 1 });
    } else if (av !== undefined && bv !== undefined) {
      lines.push({ kind: "removed", text: av, oldNumber: i + 1 });
      lines.push({ kind: "added", text: bv, newNumber: i + 1 });
    }
  }
  return lines;
}

export function diffStats(lines: readonly DiffLine[]): DiffStats {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === "added") added++;
    else if (line.kind === "removed") removed++;
  }
  return { added, removed };
}

export function formatUnifiedDiff(path: string, before: string, after: string): string {
  const lines = diffLines(before, after);
  const stats = diffStats(lines);
  if (stats.added === 0 && stats.removed === 0) return "";
  const out: string[] = [`--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@"];
  for (const line of lines) {
    const sign = line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " ";
    out.push(`${sign}${line.text}`);
  }
  return out.join("\n");
}

const DIFF_STYLES: Record<DiffLineKind, StyleKind> = {
  context: "dim",
  added: "success",
  removed: "error",
};

const DIFF_SIGNS: Record<DiffLineKind, string> = {
  context: " ",
  added: "+",
  removed: "-",
};

export interface DiffViewerOptions {
  theme?: Theme;
  mode?: RenderMode;
  colorEnabled?: boolean;
  contextLines?: number;
}

/**
 * Collapsed-by-default diff view: summary line is path with +N -M,
 * expansion shows styled lines.
 */
export class DiffViewer {
  private readonly theme: Theme;
  private readonly mode: RenderMode;
  private readonly colorEnabled: boolean;
  private readonly contextLines: number;
  private path = "";
  private lines: DiffLine[] = [];
  private expanded = false;

  constructor(options: DiffViewerOptions = {}) {
    this.theme = options.theme ?? createTheme();
    this.mode = options.mode ?? "tty";
    this.colorEnabled = options.colorEnabled ?? true;
    this.contextLines = options.contextLines ?? 3;
  }

  show(path: string, before: string, after: string): void {
    this.path = path;
    this.lines = diffLines(before, after);
    this.expanded = false;
  }

  toggle(): void {
    this.expanded = !this.expanded;
  }

  expand(): void {
    this.expanded = true;
  }

  collapse(): void {
    this.expanded = false;
  }

  isExpanded(): boolean {
    return this.expanded;
  }

  isEmpty(): boolean {
    const stats = diffStats(this.lines);
    return stats.added === 0 && stats.removed === 0;
  }

  frame(): string[] {
    if (this.isEmpty()) return [];
    const stats = diffStats(this.lines);
    const summary = t("tui.diff.summary", {
      added: stats.added,
      removed: stats.removed,
      path: this.path,
    });
    if (!this.expanded) return [this.styled("accent", summary)];
    return [this.styled("accent", summary), ...this.visibleLines().map((line) => this.styledLine(line))];
  }

  private visibleLines(): DiffLine[] {
    if (this.contextLines === 0) return this.lines;
    const keep = new Set<number>();
    for (let i = 0; i < this.lines.length; i++) {
      const line = this.lines[i];
      if (!line || line.kind === "context") continue;
      for (
        let j = Math.max(0, i - this.contextLines);
        j <= Math.min(this.lines.length - 1, i + this.contextLines);
        j++
      ) {
        keep.add(j);
      }
    }
    return this.lines.filter((_, i) => keep.has(i));
  }

  private styledLine(line: DiffLine): string {
    const text = `${DIFF_SIGNS[line.kind]}${line.text}`;
    return this.styled(DIFF_STYLES[line.kind], text);
  }

  private styled(kind: StyleKind, text: string): string {
    if (this.mode === "screen-reader") return this.theme.styledWord(kind, text);
    return this.theme.style(kind, text, this.colorEnabled);
  }
}

export function inlineDiffSummary(path: string, before: string, after: string): string {
  const stats = diffStats(diffLines(before, after));
  return t("tui.diff.summary", { added: stats.added, removed: stats.removed, path });
}

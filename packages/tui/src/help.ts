export interface HelpEntry {
  key: string;
  description: string;
}

export type PanelId = "transcript" | "browser" | "diff" | "palette" | "models";

/**
 * Contextual help: ? shows shortcuts for the focused panel, /help lists
 * all commands, hints appear inline on first use then stop.
 */
export class HelpSystem {
  private seenPanels = new Set<PanelId>();
  private readonly panelHelp: Record<PanelId, HelpEntry[]> = {
    transcript: [
      { key: "Ctrl+T", description: "toggle thinking" },
      { key: "Ctrl+L", description: "models picker" },
      { key: "Ctrl+P", description: "cycle model" },
      { key: "Esc", description: "clear focus" },
    ],
    browser: [
      { key: "/", description: "search" },
      { key: "b", description: "bookmark" },
      { key: "Enter", description: "resume session" },
      { key: "Esc", description: "close" },
    ],
    diff: [
      { key: "Enter", description: "toggle diff" },
      { key: "Esc", description: "close" },
    ],
    palette: [
      { key: "Ctrl+K", description: "open palette" },
      { key: "Enter", description: "execute" },
      { key: "Esc", description: "close" },
    ],
    models: [
      { key: "Enter", description: "select model" },
      { key: "Ctrl+S", description: "save default" },
      { key: "Esc", description: "close" },
    ],
  };

  /** Shortcuts for the currently focused panel. */
  forPanel(panel: PanelId): HelpEntry[] {
    return [...(this.panelHelp[panel] ?? [])];
  }

  /** All commands for /help. */
  all(): HelpEntry[] {
    const seen = new Map<string, HelpEntry>();
    for (const entries of Object.values(this.panelHelp)) {
      for (const e of entries) seen.set(`${e.key}:${e.description}`, e);
    }
    return [...seen.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  /** Hint to show inline on first use of a panel, then never again. */
  hint(panel: PanelId): string | undefined {
    if (this.seenPanels.has(panel)) return undefined;
    this.seenPanels.add(panel);
    const entries = this.panelHelp[panel];
    if (!entries || entries.length === 0) return undefined;
    return entries.map((e) => `${e.key} ${e.description}`).join("  ");
  }

  /** Every panel is escapable with Esc consistently. */
  isEscapable(_panel: PanelId): boolean {
    return true;
  }

  /** Rendered frame for ? overlay. */
  frame(panel: PanelId): string[] {
    const entries = this.forPanel(panel);
    if (entries.length === 0) return ["(no help)"];
    return entries.map((e) => `${e.key.padEnd(12)} ${e.description}`);
  }
}

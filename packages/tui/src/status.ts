import { t } from "@agency/i18n";
import type { Theme } from "./theme.ts";

export interface StatusInfo {
  model?: string;
  thinkingLevel?: string;
  contextUsed?: number;
  contextTotal?: number;
  costUsd?: number;
}

/**
 * One persistent status line: model, thinking level, context used, session cost.
 * Everything else is on demand.
 */
export class StatusLine {
  constructor(
    private readonly theme: Theme,
    private readonly colorEnabled: boolean,
  ) {}

  render(info: StatusInfo): string {
    const parts: string[] = [];
    if (info.model) parts.push(t("tui.status.model", { model: info.model }));
    if (info.thinkingLevel) parts.push(t("tui.status.thinking", { level: info.thinkingLevel }));
    if (info.contextUsed !== undefined && info.contextTotal !== undefined) {
      parts.push(t("tui.status.context", { used: info.contextUsed, total: info.contextTotal }));
    }
    if (info.costUsd !== undefined) {
      parts.push(t("tui.status.cost", { cost: info.costUsd.toFixed(4) }));
    }
    if (parts.length === 0) return "";
    const text = parts.join(" | ");
    return this.theme.style("dim", text, this.colorEnabled);
  }
}

import { t } from "@agency/i18n";
import type { Theme } from "./theme.ts";

export type EmptyState =
  | "first_run"
  | "no_credentials"
  | "offline"
  | "rate_limited"
  | "cancelled"
  | "no_sessions";
export type ErrorState = "offline" | "rate_limited" | "cancelled" | "auth" | "unknown";

/**
 * Designed empty and error states, not defaults. Each gets a specific
 * screen saying what happened and what to do next.
 */
export class EmptyStateView {
  constructor(
    private readonly theme: Theme,
    private readonly colorEnabled: boolean,
  ) {}

  render(state: EmptyState | ErrorState): string[] {
    switch (state) {
      case "first_run":
        return [this.styled("accent", t("tui.empty.first_run"))];
      case "no_credentials":
        return [this.styled("warning", t("tui.empty.no_credentials"))];
      case "offline":
        return [this.styled("error", t("tui.error.offline"))];
      case "rate_limited":
        return [this.styled("warning", t("tui.error.rate_limited"))];
      case "cancelled":
        return [this.styled("dim", t("tui.error.cancelled"))];
      case "no_sessions":
        return [this.styled("dim", t("tui.browser.empty"))];
      default:
        return [this.styled("error", t("error.internal"))];
    }
  }

  private styled(kind: "accent" | "dim" | "error" | "warning" | "success", text: string): string {
    return this.theme.style(kind, text, this.colorEnabled);
  }
}

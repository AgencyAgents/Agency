import { t } from "@agency/i18n";
import type { MessageKey } from "@agency/i18n";
import { ErrorCode } from "@agency/schema";
import type { StyleKind } from "./theme.ts";

export interface ErrorStateConfig {
  code: (typeof ErrorCode)[keyof typeof ErrorCode];
  messageKey: MessageKey;
  actionKey?: MessageKey;
  style: StyleKind;
  retryClass: "retryable" | "retryable_after_action" | "fatal";
  recoverable: boolean;
  hint: string;
}



export const ERROR_STATES: Record<string, ErrorStateConfig> = {
  [ErrorCode.AUTH]: {
    code: ErrorCode.AUTH,
    messageKey: "error.auth",
    style: "error",
    retryClass: "fatal",
    recoverable: false,
    hint: "Run `agency auth login <provider>` or /connect to reconnect.",
  },
  [ErrorCode.RATE_LIMIT]: {
    code: ErrorCode.RATE_LIMIT,
    messageKey: "error.rate_limit",
    style: "warning",
    retryClass: "retryable",
    recoverable: true,
    hint: "Retrying automatically — watch the countdown.",
  },
  [ErrorCode.OVERLOAD]: {
    code: ErrorCode.OVERLOAD,
    messageKey: "error.overload",
    style: "warning",
    retryClass: "retryable",
    recoverable: true,
    hint: "Retrying automatically.",
  },
  [ErrorCode.CONTEXT_OVERFLOW]: {
    code: ErrorCode.CONTEXT_OVERFLOW,
    messageKey: "error.context_overflow",
    style: "warning",
    retryClass: "retryable_after_action",
    recoverable: true,
    hint: "Compacting conversation and retrying.",
  },
  [ErrorCode.NETWORK]: {
    code: ErrorCode.NETWORK,
    messageKey: "error.network",
    style: "error",
    retryClass: "retryable",
    recoverable: true,
    hint: "Check your connection — catalog serves stale data while offline.",
  },
  [ErrorCode.PROXY]: {
    code: ErrorCode.PROXY,
    messageKey: "error.proxy",
    style: "error",
    retryClass: "fatal",
    recoverable: false,
    hint: "Check proxy settings.",
  },
  [ErrorCode.TRANSIENT]: {
    code: ErrorCode.TRANSIENT,
    messageKey: "error.transient",
    style: "warning",
    retryClass: "retryable",
    recoverable: true,
    hint: "Retrying automatically.",
  },
  [ErrorCode.REFUSAL]: {
    code: ErrorCode.REFUSAL,
    messageKey: "error.refusal",
    style: "error",
    retryClass: "fatal",
    recoverable: false,
    hint: "The model refused — try rephrasing.",
  },
  [ErrorCode.TOOL_ERROR]: {
    code: ErrorCode.TOOL_ERROR,
    messageKey: "error.tool_error",
    style: "warning",
    retryClass: "retryable",
    recoverable: true,
    hint: "Recoverable — the turn continues.",
  },
  [ErrorCode.PERMISSION_DENIED]: {
    code: ErrorCode.PERMISSION_DENIED,
    messageKey: "error.permission_denied",
    style: "error",
    retryClass: "fatal",
    recoverable: false,
    hint: "Approve once / always / deny, or adjust permissions config.",
  },
  [ErrorCode.INTERNAL]: {
    code: ErrorCode.INTERNAL,
    messageKey: "error.internal",
    style: "error",
    retryClass: "fatal",
    recoverable: false,
    hint: "Run `agency debug` to file a report.",
  },
};

export function getErrorState(code: string): ErrorStateConfig | undefined {
  return ERROR_STATES[code];
}

export function formatErrorState(
  code: string,
  message: string,
  source?: string,
  detail?: string,
): { text: string; style: StyleKind; recoverable: boolean } {
  const state = getErrorState(code);
  if (!state) {
    return { text: t("tui.error.message", { code, message }), style: "error", recoverable: false };
  }
  const params: Record<string, string | number> = {};
  if (source) params.source = source;
  if (detail) params.detail = detail;
  let rendered: string;
  try {
    rendered = t(state.messageKey, params as never);
  } catch {
    rendered = message;
  }
  if (!rendered || rendered === state.messageKey) rendered = message;
  const hint = state.hint ? ` — ${state.hint}` : "";
  return { text: `${rendered}${hint}`, style: state.style, recoverable: state.recoverable };
}

export function stopReasonState(stopReason: string): { style: StyleKind; text: string } | undefined {
  if (stopReason === "error") {
    const s = getErrorState(ErrorCode.INTERNAL);
    return s ? { style: s.style, text: t(s.messageKey) } : undefined;
  }
  if (stopReason === "cancelled") {
    return { style: "warning" as StyleKind, text: t("tui.error.cancelled") };
  }
  return undefined;
}

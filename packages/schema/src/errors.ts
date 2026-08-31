/**
 * One taxonomy for every failure the harness can hit, provider or otherwise.
 * Adapters translate provider-specific errors into this shape at the boundary;
 * nothing past that boundary (scheduler, loop, TUI) ever sees a provider error directly.
 */
export const ErrorCode = {
  AUTH: "auth",
  RATE_LIMIT: "rate_limit",
  OVERLOAD: "overload",
  CONTEXT_OVERFLOW: "context_overflow",
  NETWORK: "network",
  PROXY: "proxy",
  TRANSIENT: "transient",
  REFUSAL: "refusal",
  TOOL_ERROR: "tool_error",
  INTERNAL: "internal",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export type RetryClass =
  /** Retry immediately behind the scheduler's backoff policy. */
  | "retryable"
  /** Retry only after the caller changes something (e.g. compact and resubmit). */
  | "retryable_after_action"
  /** Never retry automatically; surface to the user. */
  | "fatal";

const RETRY_CLASS: Record<ErrorCode, RetryClass> = {
  [ErrorCode.AUTH]: "fatal",
  [ErrorCode.RATE_LIMIT]: "retryable",
  [ErrorCode.OVERLOAD]: "retryable",
  [ErrorCode.CONTEXT_OVERFLOW]: "retryable_after_action",
  [ErrorCode.NETWORK]: "retryable",
  [ErrorCode.PROXY]: "fatal",
  [ErrorCode.TRANSIENT]: "retryable",
  [ErrorCode.REFUSAL]: "fatal",
  [ErrorCode.TOOL_ERROR]: "fatal",
  [ErrorCode.INTERNAL]: "fatal",
};

/** i18n message key, resolved by @agency/i18n. Never a hardcoded user-facing string here. */
const MESSAGE_KEY: Record<ErrorCode, string> = {
  [ErrorCode.AUTH]: "error.auth",
  [ErrorCode.RATE_LIMIT]: "error.rate_limit",
  [ErrorCode.OVERLOAD]: "error.overload",
  [ErrorCode.CONTEXT_OVERFLOW]: "error.context_overflow",
  [ErrorCode.NETWORK]: "error.network",
  [ErrorCode.PROXY]: "error.proxy",
  [ErrorCode.TRANSIENT]: "error.transient",
  [ErrorCode.REFUSAL]: "error.refusal",
  [ErrorCode.TOOL_ERROR]: "error.tool_error",
  [ErrorCode.INTERNAL]: "error.internal",
};

export interface AgencyErrorOptions {
  /** Provider or subsystem name that raised this, for logs — never shown to the user. */
  source: string;
  /** Underlying error, chained for debug bundles. */
  cause?: unknown;
  /** Extra structured context (status code, header values) for logs. */
  context?: Record<string, unknown>;
}

/** The only error type that crosses package boundaries in Agency. */
export class AgencyError extends Error {
  readonly code: ErrorCode;
  readonly retryClass: RetryClass;
  readonly messageKey: string;
  readonly source: string;
  readonly context: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, options: AgencyErrorOptions) {
    super(message, { cause: options.cause });
    this.name = "AgencyError";
    this.code = code;
    this.retryClass = RETRY_CLASS[code];
    this.messageKey = MESSAGE_KEY[code];
    this.source = options.source;
    this.context = options.context ?? {};
  }

  get isRetryable(): boolean {
    return this.retryClass === "retryable";
  }
}

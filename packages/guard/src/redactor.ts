/**
 * Common provider API key shapes, redacted even if a secret was never
 * explicitly registered: defense in depth for a key that leaked into a log
 * line some other way (e.g. echoed back inside a tool's stdout).
 */
const KNOWN_KEY_PATTERNS: RegExp[] = [
  // `\b`: "risk-assessment-..." in a file listing is not a key.
  /\bsk-ant-[a-zA-Z0-9_-]{20,}/g, // Anthropic
  /\bsk-(proj-)?[a-zA-Z0-9_-]{20,}/g, // OpenAI
  /AIzaSy[a-zA-Z0-9_-]{33}/g, // Google
  /gh[pousr]_[A-Za-z0-9]{36,}/g, // GitHub
  /github_pat_[A-Za-z0-9_]{50,}/g,
  /\bAKIA[0-9A-Z]{16}/g, // AWS access key id
  /xox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /npm_[A-Za-z0-9]{36,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/** Tools whose result is the output of a program, not the text of a file that the model then edits. */
const COMMAND_OUTPUT_TOOLS: ReadonlySet<string> = new Set(["bash", "code"]);

const PLACEHOLDER = "[REDACTED]";

/**
 * The one chokepoint every log line, telemetry payload, and crash bundle
 * passes through (R11): secrets are scrubbed once here, not re-implemented
 * at each call site.
 */
export class Redactor {
  private readonly secrets = new Set<string>();

  /** Call this the moment a secret is loaded (keychain, env, flag), before
   *  it's ever used, so nothing can log it unredacted in between. */
  registerSecret(secret: string): void {
    if (secret.length >= 4) this.secrets.add(secret);
  }

  /**
   * Only the registered values, for text that the model reads and edits (a tool result):
   * the key patterns would also change a test key in a source file.
   */
  redactSecrets = (text: string): string => {
    let result = text;
    for (const secret of this.secrets) {
      result = result.split(secret).join(PLACEHOLDER);
    }
    return result;
  };

  /**
   * For a tool result. The output of a command also loses tokens by their shape (`gh auth token`, `env`).
   * A password with no known shape still passes.
   */
  redactToolResult = (text: string, tool?: string): string =>
    tool !== undefined && COMMAND_OUTPUT_TOOLS.has(tool) ? this.redact(text) : this.redactSecrets(text);

  redact(text: string): string {
    let result = this.redactSecrets(text);
    for (const pattern of KNOWN_KEY_PATTERNS) {
      result = result.replace(pattern, PLACEHOLDER);
    }
    return result;
  }
}

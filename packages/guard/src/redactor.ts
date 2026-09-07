/**
 * Common provider API key shapes, redacted even if a secret was never
 * explicitly registered: defense in depth for a key that leaked into a log
 * line some other way (e.g. echoed back inside a tool's stdout).
 */
const KNOWN_KEY_PATTERNS: RegExp[] = [
  /sk-ant-[a-zA-Z0-9_-]{20,}/g, // Anthropic
  /sk-(proj-)?[a-zA-Z0-9_-]{20,}/g, // OpenAI
  /AIzaSy[a-zA-Z0-9_-]{33}/g, // Google
];

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

  redact(text: string): string {
    let result = text;
    for (const secret of this.secrets) {
      result = result.split(secret).join(PLACEHOLDER);
    }
    for (const pattern of KNOWN_KEY_PATTERNS) {
      result = result.replace(pattern, PLACEHOLDER);
    }
    return result;
  }
}

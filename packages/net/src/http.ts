import { AgencyError, ErrorCode } from "@agency/schema";

export interface HttpClientOptions {
  /**
   * Explicit proxy URL, an Agency-config-level override. When unset, the
   * runtime's own ambient HTTP_PROXY/HTTPS_PROXY/NO_PROXY handling applies.
   * Bun's fetch already implements that correctly, so this package doesn't
   * duplicate it; it only adds an override on top when Agency's own config
   * asks for one, itself still exempting NO_PROXY-listed hosts.
   */
  proxy?: string;
  /** Path to a custom CA bundle (PEM). Falls back to NODE_EXTRA_CA_CERTS from env when unset. */
  caFile?: string;
  /** Per-request timeout. A hang becomes a NETWORK error instead of hanging forever. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface HttpClient {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

function isExempt(url: string, env: NodeJS.ProcessEnv): boolean {
  const noProxy = env.NO_PROXY ?? env.no_proxy;
  if (!noProxy) return false;
  const host = new URL(url).hostname;
  return noProxy
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean)
    .some((pattern) => host === pattern || host.endsWith(`.${pattern}`));
}

/** Module-level cache keyed by CA file path: the bundle is read and parsed once
 *  per path instead of on every single request. */
const caCache = new Map<string, string>();

async function resolveCa(options: HttpClientOptions, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const path = options.caFile ?? env.NODE_EXTRA_CA_CERTS;
  if (!path) return undefined;
  const cached = caCache.get(path);
  if (cached !== undefined) return cached;
  const ca = await Bun.file(path).text();
  caCache.set(path, ca);
  return ca;
}

/**
 * The one outbound HTTP path in Agency. Every provider adapter and every future
 * network caller goes through this so custom-CA and timeout behavior is defined
 * once instead of per call site (R9), and Agency's own explicit proxy override
 * (when configured) is applied consistently.
 */
export function createHttpClient(options: HttpClientOptions = {}): HttpClient {
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? 30_000;

  return {
    async fetch(url, init = {}) {
      const explicitProxy = options.proxy && !isExempt(url, env) ? options.proxy : undefined;
      const ca = await resolveCa(options, env);
      const controller = new AbortController();
      const onCallerAbort = () => controller.abort();
      init.signal?.addEventListener("abort", onCallerAbort);
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        return await fetch(url, {
          ...init,
          signal: controller.signal,
          // Bun-native fetch extensions; ignored (harmlessly) by a strict DOM lib typing.
          ...(explicitProxy ? { proxy: explicitProxy } : {}),
          ...(ca ? { tls: { ca } } : {}),
        } as RequestInit);
      } catch (cause) {
        throw translateFetchError(cause, url, Boolean(explicitProxy));
      } finally {
        clearTimeout(timer);
        init.signal?.removeEventListener("abort", onCallerAbort);
      }
    },
  };
}

function translateFetchError(cause: unknown, url: string, throughExplicitProxy: boolean): AgencyError {
  const message = cause instanceof Error ? cause.message : String(cause);

  if (cause instanceof DOMException && cause.name === "AbortError") {
    return new AgencyError(ErrorCode.NETWORK, `request to ${url} timed out`, {
      source: "net",
      cause,
      context: { url },
    });
  }

  if (throughExplicitProxy) {
    return new AgencyError(ErrorCode.PROXY, `request to ${url} failed through the configured proxy`, {
      source: "net",
      cause,
      context: { url },
    });
  }

  return new AgencyError(ErrorCode.NETWORK, `request to ${url} failed: ${message}`, {
    source: "net",
    cause,
    context: { url },
  });
}

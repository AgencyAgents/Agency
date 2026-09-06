import { EVENT_RETRY_MS, EVENT_RING_SIZE } from "./catalog.ts";
import { EventRing, sseFrame } from "./event-buffer.ts";
import { buildGatewayDocument } from "./gateway-doc.ts";
import { matchesSubscription } from "./protocol.ts";
import type { MethodHandler } from "./server.ts";
import { MintedTokenStore, scopeGrants } from "./tokens.ts";

/** Minimal store interface: the gateway only needs `load()` for replay. */
export interface SessionStoreLike {
  load(sessionId: string): { id: string; type: string; createdAt: string; [key: string]: unknown }[];
}

/**
 * The HTTP + SSE surface alongside the TCP loopback transport (A3, pulled
 * forward so the desktop app has a real client surface): the SAME handler
 * table the TCP server dispatches, exposed as JSON-RPC-style HTTP endpoints,
 * with daemon events pushed as `text/event-stream` frames.
 *
 * Unlike the TCP transport (which broadcasts every event frame to every
 * connected client and lets each client filter locally), an SSE connection
 * here subscribes to specific streams (`GET /events?stream=<name>`), and
 * `publish()` fans an event out only to the subscriptions it matches. Two
 * terminals on one workspace therefore see only their own turn streams.
 *
 * Resumability: every published event takes a monotonic id from a bounded
 * per-key ring. A reconnect carrying Last-Event-ID gap-tails the missed
 * frames; a reconnect past the retained tail gets the `state` snapshot
 * instead, so it renders correctly without replaying a run.
 *
 * This is one adapter over the shared handlers, not a second implementation:
 * callers wire `startDaemonServer({ handlers })` and `createHttpGateway({
 * handlers })` to the same `Record<string, MethodHandler>` object.
 */

export interface HttpGatewayOptions {
  /** The shared method table (same object the TCP server was given). */
  handlers: Record<string, MethodHandler>;
  /**
   * Bootstrap credential from the instance file. Presented ONLY as
   * `Authorization: Bearer` (mint scoped tokens for everything else).
   * When unset the gateway accepts anonymous callers.
   */
  token?: string;
  /** Interval between SSE keepalive comments; 0 disables. Default 15s. */
  keepAliveMs?: number;
  /** Emit CORS headers; the allowlist decides which origins get them. */
  cors?: boolean;
  /** Origins echoed back as Access-Control-Allow-Origin; empty means none. */
  allowedOrigins?: string[];
  /** Optional SessionStore for the /sync-events endpoint. */
  store?: SessionStoreLike;
  /** Per-key ring bound for resumable events. Default 256. */
  ringSize?: number;
  /** SSE `retry:` hint in ms served on connect. Default 3000. */
  retryMs?: number;
  /** Maps an event name to its ring key (usually a session id). */
  sessionForEvent?: (event: string) => string | undefined;
  /** Connect-time snapshot behind the `state` frame (turns, approvals, agents, cost). */
  stateSnapshot?: (sessionId?: string) => unknown;
  /** Default TTL for minted tokens. */
  mintTtlMs?: number;
}

export interface HttpGateway {
  /** A Bun.serve-compatible request handler (`Bun.serve({ fetch: gw.fetch })`). */
  fetch(request: Request): Promise<Response>;
  /**
   * Pushes an event to every SSE client whose subscription matches. The
   * daemon's turn events arrive here with their TCP event names, e.g.
   * `turn.<turnId>`; a client that subscribed with the bare `<turnId>`
   * matches those too.
   */
  publish(event: string, payload: unknown): void;
  /** Ends every open SSE stream. Idempotent. */
  close(): void;
  /** How many SSE clients are currently attached (observability/tests). */
  readonly subscriberCount: number;
}

interface SseClient {
  /** Stream filters: empty = every event; otherwise exact event name or a
   *  bare turn id (matches `turn.<id>`). */
  streams: string[];
  /** Delivers one SSE frame; returns false when the client is gone. */
  write: (chunk: string) => boolean;
  /** Idempotently tears the client down: unregisters, stops keepalive, closes. */
  close: () => void;
}

function errorPayload(error: unknown): { message: string; code?: string } {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return code === undefined ? { message } : { message, code };
}

const QUERY_BEARER_GONE =
  "query-string bearer was removed in protocol v2: send Authorization: Bearer or mint a scoped token via POST /auth/mint";

export function createHttpGateway(options: HttpGatewayOptions): HttpGateway {
  const keepAliveMs = options.keepAliveMs ?? 15_000;
  const cors = options.cors ?? true;
  const allowedOrigins = options.allowedOrigins ?? [];
  const retryMs = options.retryMs ?? EVENT_RETRY_MS;
  const ring = new EventRing(options.ringSize ?? EVENT_RING_SIZE);
  const minted = new MintedTokenStore();
  const subscribers = new Set<SseClient>();

  function withCors(headers: Record<string, string>, request?: Request): Record<string, string> {
    if (!cors) return headers;
    const origin = request?.headers.get("origin") ?? "";
    if (origin !== "" && allowedOrigins.includes(origin)) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers.Vary = "Origin";
    }
    return headers;
  }

  function corsPreflight(request: Request): Record<string, string> {
    const base: Record<string, string> = {};
    if (!cors) return base;
    const origin = request.headers.get("origin") ?? "";
    if (origin !== "" && allowedOrigins.includes(origin)) {
      base["Access-Control-Allow-Origin"] = origin;
      base["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
      base["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
      base["Access-Control-Max-Age"] = "86400";
      base.Vary = "Origin";
    }
    return base;
  }

  function json(status: number, body: unknown, request?: Request, extra?: Record<string, string>): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: withCors({ "Content-Type": "application/json", ...extra }, request),
    });
  }

  /** Bearer scopes for this request, or null when anonymous. */
  function bearerScopes(request: Request): readonly string[] | null {
    if (!options.token) return ["*"];
    const header = request.headers.get("authorization") ?? "";
    const prefix = "Bearer ";
    if (!header.startsWith(prefix)) return null;
    const presented = header.slice(prefix.length);
    if (presented === options.token) return ["*"];
    return minted.scopesFor(presented);
  }

  /** Header-only auth: the query-string bearer is gone since v2. */
  function authorized(request: Request, url: URL, need: string): Response | null {
    if (url.searchParams.has("token")) {
      return json(401, { error: { message: QUERY_BEARER_GONE } }, request, {
        "WWW-Authenticate": "Bearer",
      });
    }
    if (!options.token) return null;
    const scopes = bearerScopes(request);
    if (scopes === null || !scopeGrants(scopes, need)) {
      return json(401, { error: { message: "unauthorized: missing or invalid bearer token" } }, request, {
        "WWW-Authenticate": "Bearer",
      });
    }
    return null;
  }

  /** POST /rpc: the same request/response semantics as the TCP transport:
   *  `{ id, method, params }` in, `{ id, result }` out, handler throws and
   *  unknown methods surfacing as `{ id, error: { message, code? } }`. */
  async function handleRpc(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = JSON.parse(await request.text());
    } catch {
      return json(400, { id: null, error: { message: "request body must be valid JSON" } }, request);
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return json(400, { id: null, error: { message: "request body must be a JSON object" } }, request);
    }
    const { id, method, params } = body as Record<string, unknown>;
    if (typeof method !== "string" || method.length === 0) {
      return json(
        400,
        { id: id ?? null, error: { message: 'request body must include a string "method"' } },
        request,
      );
    }

    const handler = options.handlers[method];
    if (!handler) {
      return json(404, { id: id ?? null, error: { message: `unknown method: ${method}` } }, request);
    }

    try {
      const result = await handler(params, { clientId: "http" });
      return json(200, { id: id ?? null, result }, request);
    } catch (error: unknown) {
      return json(500, { id: id ?? null, error: errorPayload(error) }, request);
    }
  }

  /** POST /auth/mint: bootstrap token in, short-lived scoped token out. */
  async function handleMint(request: Request): Promise<Response> {
    if (!options.token) return json(400, { error: { message: "mint unavailable: no token configured" } });
    const header = request.headers.get("authorization") ?? "";
    if (header !== `Bearer ${options.token}`) {
      return json(401, { error: { message: "mint requires the bootstrap token" } }, request, {
        "WWW-Authenticate": "Bearer",
      });
    }
    let body: { scopes?: unknown; ttlMs?: unknown } = {};
    try {
      const text = await request.text();
      if (text.length > 0) body = JSON.parse(text) as typeof body;
    } catch {
      return json(400, { error: { message: "request body must be valid JSON" } }, request);
    }
    const scopes = Array.isArray(body.scopes)
      ? body.scopes.filter((s): s is string => typeof s === "string")
      : ["*"];
    const ttlMs = typeof body.ttlMs === "number" ? body.ttlMs : options.mintTtlMs;
    const token = minted.mint(scopes.length > 0 ? scopes : ["*"], ttlMs);
    return json(200, { token: token.token, scopes: [...token.scopes], expiresAt: token.expiresAt }, request);
  }

  /** GET /events?stream=<name>: a per-client SSE subscription. */
  function handleEvents(request: Request, url: URL): Response {
    const streams = url.searchParams
      .getAll("stream")
      .flatMap((value) => value.split(","))
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    const sessionId = url.searchParams.get("sessionId") ?? undefined;
    const lastEventId = parseLastEventId(request.headers.get("last-event-id"));
    const match = (event: string): boolean => matchesSubscription(streams, event);
    // Gap-tail only over retained ids; anything older renders from state.
    const backlog =
      lastEventId !== undefined && ring.covers(lastEventId) ? ring.since(lastEventId, match) : [];
    const snapshot = options.stateSnapshot?.(sessionId) ?? {};

    const encoder = new TextEncoder();
    let client: SseClient | undefined;

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        const timer = keepAliveMs > 0 ? setInterval(() => write(": keepalive\n\n"), keepAliveMs) : undefined;
        if (timer) timer.unref?.();

        function write(chunk: string): boolean {
          if (closed) return false;
          try {
            controller.enqueue(encoder.encode(chunk));
            return true;
          } catch {
            // The controller can reject if the stream is already torn down;
            // treat it as a disconnect and drop the subscriber.
            cleanup();
            return false;
          }
        }

        function cleanup() {
          if (closed) return;
          closed = true;
          if (timer) clearInterval(timer);
          if (client) subscribers.delete(client);
          try {
            controller.close();
          } catch {
            // Already closed/errored by the runtime after a disconnect.
          }
        }

        client = { streams, write, close: cleanup };
        subscribers.add(client);
        write(`retry: ${retryMs}\n\n`);
        write(`event: state\ndata: ${JSON.stringify(snapshot)}\n\n`);
        for (const entry of backlog) {
          if (!write(sseFrame(entry.id, entry.event, entry.payload))) break;
        }
      },
      cancel() {
        client?.close();
      },
    });

    // Bun aborts request.signal when the client connection drops; the
    // stream's cancel callback is the primary cleanup, this is the backstop.
    if (request.signal.aborted) client?.close();
    else request.signal.addEventListener("abort", () => client?.close());

    return new Response(body, {
      headers: withCors(
        {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
        },
        request,
      ),
    });
  }

  /** GET /sync-events?sessionId=<id>: replay session entries as SSE. */
  function handleSyncEvents(request: Request, url: URL): Response {
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) {
      return json(400, { error: { message: "sessionId query parameter is required" } }, request);
    }

    const store = options.store;
    if (!store) {
      return json(501, { error: { message: "sync-events not available: no session store configured" } });
    }

    const entries = store.load(sessionId);
    if (entries.length === 0) {
      return json(404, { error: { message: `session not found: ${sessionId}` } });
    }

    const encoder = new TextEncoder();

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;

        function write(chunk: string): boolean {
          if (closed) return false;
          try {
            controller.enqueue(encoder.encode(chunk));
            return true;
          } catch {
            closed = true;
            try {
              controller.close();
            } catch {}
            return false;
          }
        }

        // Stream each entry as an SSE event.
        for (const entry of entries) {
          if (!write(`event: sync-entry\ndata: ${JSON.stringify(entry)}\n\n`)) break;
        }

        // Signal completion.
        write(`event: sync-complete\ndata: ${JSON.stringify({ count: entries.length })}\n\n`);

        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {}
        }
      },
    });

    // Bun aborts request.signal when the client connection drops.
    if (request.signal.aborted) request.signal.addEventListener("abort", () => {});
    else request.signal.addEventListener("abort", () => {});

    return new Response(body, {
      headers: withCors(
        {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
        },
        request,
      ),
    });
  }

  function methodNotAllowed(request: Request, allow: string): Response {
    return json(405, { error: { message: `method not allowed; use ${allow}` } }, request, {
      Allow: allow,
    });
  }

  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      try {
        // Preflights are answered before auth: they carry no credentials by spec.
        if (request.method === "OPTIONS") {
          return new Response(null, { status: 204, headers: corsPreflight(request) });
        }
        // Health check is always open (clients probe liveness without a token).
        if (url.pathname === "/health") {
          if (request.method !== "GET") return methodNotAllowed(request, "GET");
          return json(200, { ok: true, subscribers: subscribers.size }, request);
        }
        if (url.pathname === "/auth/mint") {
          if (request.method !== "POST") return methodNotAllowed(request, "POST");
          return await handleMint(request);
        }
        const need = url.pathname === "/events" || url.pathname === "/sync-events" ? "events" : "rpc";
        const rejection = authorized(request, url, need);
        if (rejection) return rejection;

        switch (url.pathname) {
          case "/rpc":
            if (request.method !== "POST") return methodNotAllowed(request, "POST");
            return await handleRpc(request);
          case "/events":
            if (request.method !== "GET") return methodNotAllowed(request, "GET");
            return handleEvents(request, url);
          case "/sync-events":
            if (request.method !== "GET") return methodNotAllowed(request, "GET");
            return handleSyncEvents(request, url);
          case "/doc":
            if (request.method !== "GET") return methodNotAllowed(request, "GET");
            return json(200, buildGatewayDocument(Object.keys(options.handlers)), request);
          default:
            return json(404, { error: { message: `no such endpoint: ${url.pathname}` } }, request);
        }
      } catch (error: unknown) {
        return json(500, { error: errorPayload(error) }, request);
      }
    },

    publish(event, payload) {
      const key = options.sessionForEvent?.(event) ?? "global";
      const id = ring.append(event, payload, key);
      const frame = sseFrame(id, event, payload);
      for (const client of [...subscribers]) {
        if (matchesSubscription(client.streams, event)) client.write(frame);
      }
    },

    close() {
      for (const client of [...subscribers]) client.close();
    },

    get subscriberCount(): number {
      return subscribers.size;
    },
  };
}

function parseLastEventId(header: string | null): number | undefined {
  if (header === null || header.trim() === "") return undefined;
  const id = Number(header.trim());
  return Number.isInteger(id) && id >= 0 ? id : undefined;
}

export interface HttpGatewayServerOptions extends HttpGatewayOptions {
  /** Port to bind; 0 (default) picks a free port. */
  port?: number;
  /** Interface to bind; 127.0.0.1 (default) keeps the daemon loopback-only. */
  hostname?: string;
}

export interface HttpGatewayServer {
  readonly port: number;
  publish(event: string, payload: unknown): void;
  /** Ends all SSE streams and stops the HTTP server. Idempotent. */
  close(): Promise<void>;
  readonly subscriberCount: number;
}

/**
 * Stands the gateway up as a real Bun HTTP server, mirroring
 * `startDaemonServer`'s shape so the daemon can wire both transports over
 * the same handler table.
 */
export function startHttpGateway(serverOptions: HttpGatewayServerOptions): HttpGatewayServer {
  const gateway = createHttpGateway(serverOptions);
  const server = Bun.serve({
    port: serverOptions.port ?? 0,
    hostname: serverOptions.hostname ?? "127.0.0.1",
    fetch: (request) => gateway.fetch(request),
  });

  let stopped = false;
  return {
    port: server.port ?? 0,
    publish: (event, payload) => gateway.publish(event, payload),
    async close() {
      // Streams must end BEFORE stopping the server: force-stopping resets
      // sockets before clients drain the stream's buffered tail (ECONNRESET).
      gateway.close();
      if (!stopped) {
        stopped = true;
        await server.stop();
      }
    },
    get subscriberCount(): number {
      return gateway.subscriberCount;
    },
  };
}

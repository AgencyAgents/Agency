import type { MethodHandler } from "./server.ts";

/**
 * The HTTP + SSE surface alongside the TCP loopback transport (A3, pulled
 * forward so the desktop app has a real client surface): the SAME handler
 * table the TCP server dispatches, exposed as JSON-RPC-style HTTP endpoints,
 * with daemon events pushed as `text/event-stream` frames.
 *
 * Unlike the TCP transport — which broadcasts every event frame to every
 * connected client and lets each client filter locally — an SSE connection
 * here subscribes to specific streams (`GET /events?stream=<name>`), and
 * `publish()` fans an event out only to the subscriptions it matches. Two
 * terminals on one workspace therefore see only their own turn streams.
 *
 * This is one adapter over the shared handlers, not a second implementation:
 * callers wire `startDaemonServer({ handlers })` and `createHttpGateway({
 * handlers })` to the same `Record<string, MethodHandler>` object.
 */

export interface HttpGatewayOptions {
  /** The shared method table (same object the TCP server was given). */
  handlers: Record<string, MethodHandler>;
  /**
   * When set, every request must present `Authorization: Bearer <token>`
   * (or `?token=<token>` for clients like native EventSource that cannot
   * set headers). When unset the gateway accepts anonymous callers.
   */
  token?: string;
  /** Interval between SSE keepalive comments; 0 disables. Default 15s. */
  keepAliveMs?: number;
  /**
   * Emit CORS headers and answer preflights, for webview clients served
   * from other origins. Default true; harmless for a loopback-only daemon.
   */
  cors?: boolean;
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

function matchesSubscription(streams: string[], event: string): boolean {
  if (streams.length === 0) return true;
  return streams.some((stream) => stream === event || event === `turn.${stream}`);
}

function errorPayload(error: unknown): { message: string; code?: string } {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return code === undefined ? { message } : { message, code };
}

export function createHttpGateway(options: HttpGatewayOptions): HttpGateway {
  const keepAliveMs = options.keepAliveMs ?? 15_000;
  const cors = options.cors ?? true;
  const subscribers = new Set<SseClient>();

  function withCors(headers: Record<string, string>): Record<string, string> {
    if (!cors) return headers;
    headers["Access-Control-Allow-Origin"] = "*";
    headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
    headers["Access-Control-Max-Age"] = "86400";
    return headers;
  }

  function json(status: number, body: unknown, extra?: Record<string, string>): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: withCors({ "Content-Type": "application/json", ...extra }),
    });
  }

  function authorized(request: Request, url: URL): boolean {
    if (!options.token) return true;
    if (request.headers.get("authorization") === `Bearer ${options.token}`) return true;
    // Native EventSource cannot set headers; the query param is its only way in.
    return url.searchParams.get("token") === options.token;
  }

  /** POST /rpc — the same request/response semantics as the TCP transport:
   *  `{ id, method, params }` in, `{ id, result }` out, handler throws and
   *  unknown methods surfacing as `{ id, error: { message, code? } }`. */
  async function handleRpc(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = JSON.parse(await request.text());
    } catch {
      return json(400, { id: null, error: { message: "request body must be valid JSON" } });
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return json(400, { id: null, error: { message: "request body must be a JSON object" } });
    }
    const { id, method, params } = body as Record<string, unknown>;
    if (typeof method !== "string" || method.length === 0) {
      return json(400, { id: id ?? null, error: { message: 'request body must include a string "method"' } });
    }

    const handler = options.handlers[method];
    if (!handler) {
      return json(404, { id: id ?? null, error: { message: `unknown method: ${method}` } });
    }

    try {
      const result = await handler(params);
      return json(200, { id: id ?? null, result });
    } catch (error: unknown) {
      return json(500, { id: id ?? null, error: errorPayload(error) });
    }
  }

  /** GET /events?stream=<name> — a per-client SSE subscription. */
  function handleEvents(request: Request, url: URL): Response {
    const streams = url.searchParams
      .getAll("stream")
      .flatMap((value) => value.split(","))
      .map((value) => value.trim())
      .filter((value) => value.length > 0);

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
        write(": connected\n\n");
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
      headers: withCors({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      }),
    });
  }

  /** GET /doc — an OpenAPI description of the gateway's surface. */
  function openApiDocument(): Record<string, unknown> {
    const unauthorized: Record<string, unknown> = {
      description: "Missing or invalid bearer token (only when the daemon was started with a token)",
    };
    return {
      openapi: "3.1.0",
      info: {
        title: "Agency Daemon Gateway",
        version: "0.1.0",
        description:
          "HTTP + SSE transport for the Agency daemon: the same handler table the " +
          "TCP loopback transport serves, exposed as JSON-RPC-style HTTP endpoints. " +
          "Bound to loopback only. Auth is active only when the daemon was started " +
          "with a per-instance token.",
      },
      paths: {
        "/rpc": {
          post: {
            summary: "Call a daemon RPC method",
            description:
              "Body: { id?, method, params? }. Success: { id, result }. Handler throws " +
              "surface as { id, error: { message, code? } }; the payload shape matches " +
              "the TCP transport's response_error frames.",
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { id: {}, method: { type: "string" }, params: {} },
                    required: ["method"],
                  },
                },
              },
            },
            responses: {
              "200": {
                description: "Handler succeeded",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: { id: {}, result: {} },
                      required: ["id", "result"],
                    },
                  },
                },
              },
              "400": { description: "Malformed request body" },
              "401": unauthorized,
              "404": { description: "Unknown method" },
              "500": { description: "Handler threw" },
            },
          },
        },
        "/events": {
          get: {
            summary: "Subscribe to daemon events over SSE",
            description:
              "text/event-stream. Each frame is `event: <name>` + `data: <json>`. " +
              "Subscribe with ?stream=<name> (repeatable): a value matches events by " +
              "exact name, and a bare turn id also matches its `turn.<id>` events. " +
              "Omitting stream receives every event. Keepalive comments are sent " +
              "periodically; reconnects do not replay missed events.",
            parameters: [
              {
                name: "stream",
                in: "query",
                required: false,
                schema: { type: "array", items: { type: "string" } },
                description: "Event names (or bare turn ids) to subscribe to; omit for all events.",
              },
              {
                name: "token",
                in: "query",
                schema: { type: "string" },
                description: "Alternative to the Authorization header for EventSource clients.",
              },
            ],
            responses: {
              "200": {
                description: "SSE stream of daemon events",
                content: { "text/event-stream": { schema: { type: "string" } } },
              },
              "401": unauthorized,
            },
          },
        },
        "/health": {
          get: {
            summary: "Health check",
            responses: {
              "200": {
                description: "Daemon is serving",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: { ok: { type: "boolean" }, subscribers: { type: "integer" } },
                      required: ["ok"],
                    },
                  },
                },
              },
              "401": unauthorized,
            },
          },
        },
        "/doc": {
          get: {
            summary: "This document",
            description: "The gateway's OpenAPI description (the document being served).",
            responses: {
              "200": {
                description: "OpenAPI document",
                content: { "application/json": { schema: { type: "object" } } },
              },
              "401": unauthorized,
            },
          },
        },
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            description: "Active only when the daemon was started with a token.",
          },
        },
      },
    };
  }

  function methodNotAllowed(allow: string): Response {
    return json(405, { error: { message: `method not allowed; use ${allow}` } }, { Allow: allow });
  }

  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      try {
        // Preflights are answered before auth: they carry no credentials by spec.
        if (request.method === "OPTIONS") {
          return new Response(null, { status: 204, headers: withCors({}) });
        }
        if (!authorized(request, url)) {
          return json(
            401,
            { error: { message: "unauthorized: missing or invalid bearer token" } },
            { "WWW-Authenticate": "Bearer" },
          );
        }

        switch (url.pathname) {
          case "/rpc":
            if (request.method !== "POST") return methodNotAllowed("POST");
            return await handleRpc(request);
          case "/events":
            if (request.method !== "GET") return methodNotAllowed("GET");
            return handleEvents(request, url);
          case "/health":
            if (request.method !== "GET") return methodNotAllowed("GET");
            return json(200, { ok: true, subscribers: subscribers.size });
          case "/doc":
            if (request.method !== "GET") return methodNotAllowed("GET");
            return json(200, openApiDocument());
          default:
            return json(404, { error: { message: `no such endpoint: ${url.pathname}` } });
        }
      } catch (error: unknown) {
        return json(500, { error: errorPayload(error) });
      }
    },

    publish(event, payload) {
      const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
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

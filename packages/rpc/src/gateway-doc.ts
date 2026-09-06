import { EVENT_CATALOG, METHOD_DOCS } from "./catalog.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";

/**
 * The `/doc` payload: OpenAPI paths plus the versioned agency catalogs.
 * `x-agency.protocolVersion` tracks PROTOCOL_VERSION so SDK drift and the
 * query-bearer removal note travel with the document, not tribal memory.
 */
export function buildGatewayDocument(liveMethods?: readonly string[]): Record<string, unknown> {
  const unauthorized: Record<string, unknown> = {
    description: "Missing or invalid bearer token (only when the daemon was started with a token)",
  };
  const methods = (liveMethods ?? Object.keys(METHOD_DOCS)).map((name) => ({
    name,
    description: METHOD_DOCS[name] ?? "",
  }));
  return {
    openapi: "3.1.0",
    info: {
      title: "Agency Daemon Gateway",
      version: `protocol-${PROTOCOL_VERSION}`,
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
                  schema: { type: "object", properties: { id: {}, result: {} }, required: ["id", "result"] },
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
            "text/event-stream. Each frame carries `id: <monotonic>` + `event: <name>` + " +
            "`data: <json>`, and the connect opens with a `retry:` hint plus an `event: state` " +
            "snapshot (live turns, outstanding approvals, per-agent status, cost to date). " +
            "Subscribe with ?stream=<name> (repeatable) and ?sessionId=<id> to scope the " +
            "state frame; reconnect with Last-Event-ID to gap-tail missed frames. " +
            "A reconnect past the retained tail gets the state frame only, never a replay.",
          parameters: [
            {
              name: "stream",
              in: "query",
              required: false,
              schema: { type: "array", items: { type: "string" } },
              description: "Event names (or bare turn ids) to subscribe to; omit for all events.",
            },
            {
              name: "sessionId",
              in: "query",
              required: false,
              schema: { type: "string" },
              description: "Session id scoping the state frame snapshot.",
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
      "/sync-events": {
        get: {
          summary: "Replay session entries as SSE for durable event replay",
          description:
            "text/event-stream. Each entry from the session's JSONL is streamed as " +
            "an `event: sync-entry` frame with the entry JSON as data. A final " +
            "`event: sync-complete` frame signals the end of the replay. " +
            "Requires a SessionStore to be configured on the gateway.",
          parameters: [
            {
              name: "sessionId",
              in: "query",
              required: true,
              schema: { type: "string" },
              description: "The session ID to replay entries from.",
            },
          ],
          responses: {
            "200": {
              description: "SSE stream of session entries",
              content: { "text/event-stream": { schema: { type: "string" } } },
            },
            "400": { description: "Missing sessionId parameter" },
            "401": unauthorized,
            "404": { description: "Session not found" },
            "501": { description: "No session store configured on gateway" },
          },
        },
      },
      "/auth/mint": {
        post: {
          summary: "Exchange the bootstrap token for a short-lived scoped token",
          description:
            "Requires the instance-file bootstrap token as bearer. Body: " +
            "{ scopes?: string[], ttlMs?: number }. The minted token carries " +
            "only the requested scopes (or *), expires within the hour, and is " +
            "the credential SSE and RPC callers should use.",
          responses: {
            "200": { description: "Minted token with scopes and expiry" },
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
    "x-agency": {
      protocolVersion: PROTOCOL_VERSION,
      methods,
      events: EVENT_CATALOG.map((e) => ({ ...e })),
      auth: {
        bootstrap: "instance-file token (Authorization header only, mints scoped tokens)",
        queryBearerRemovedIn: 2,
        note: "v2 removed ?token= query-string bearer; EventSource clients fetch then mint via POST /auth/mint",
      },
    },
  };
}

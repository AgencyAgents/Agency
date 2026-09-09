import type { SandboxBackend } from "@agency/guard";
import { AgencyError, ErrorCode } from "@agency/schema";
import {
  asContainerExecBackend,
  asContainerStdioBackend,
  type ContainerStdioBackend,
} from "../container-exec.ts";
import type { McpServerConfig } from "./config.ts";

export interface McpTransport {
  start(): Promise<void>;
  send(message: Record<string, unknown>): Promise<void>;
  onMessage(handler: (msg: Record<string, unknown>) => void): void;
  onClose?(handler: () => void): void;
  stderrTail?(): string;
  close(): Promise<void>;
}

export interface TransportOptions {
  adopt?: (proc: { pid?: number; kill: () => void }, command: string) => void;
  /** Host cwd the container backend maps into the mount; unset keeps the backend default. */
  cwd?: string;
}

export function createMcpTransport(
  _serverName: string,
  config: McpServerConfig,
  options: TransportOptions = {},
): McpTransport {
  if (config.url) {
    return createHttpTransport(config.url, config.headers, config.timeoutMs ?? config.requestTimeoutMs);
  }
  if (config.command) {
    return createStdioTransport(config.command, config.args ?? [], config.env ?? {}, options);
  }
  throw new Error(`MCP server config needs command or url`);
}

/**
 * Routes stdio servers into the container when the sandbox offers the
 * streaming spawn surface. HTTP/SSE configs always use the host HTTP
 * transport; software sandboxes yield undefined so the manager keeps its
 * default spawn path. An exec-only container backend fails closed with a
 * typed error at selection time, never silently on the host.
 */
export function transportForWithContainerSandbox(
  sandbox: SandboxBackend,
  options: TransportOptions = {},
): ((serverName: string, config: McpServerConfig) => McpTransport) | undefined {
  const stdio = asContainerStdioBackend(sandbox);
  if (stdio) {
    return (_serverName, config) => {
      if (config.url) return createMcpTransport(_serverName, config);
      return createContainerStdioTransport(stdio, config, options);
    };
  }
  if (asContainerExecBackend(sandbox) !== undefined) {
    return (serverName, config) => {
      if (config.url) return createMcpTransport(serverName, config);
      throw new AgencyError(
        ErrorCode.INTERNAL,
        `MCP server "${serverName}" needs container stdio, but the sandbox backend has no streaming spawn surface`,
        { source: "mcp-container-transport", context: { serverName } },
      );
    };
  }
  return undefined;
}

/** Spawns a stdio server across the mount; JSONL pumps and kill-on-close match the local path. */
export function createContainerStdioTransport(
  backend: ContainerStdioBackend,
  config: McpServerConfig,
  options: TransportOptions = {},
): McpTransport {
  if (!config.command) throw new Error(`MCP server config needs command or url`);
  const argv = [config.command, ...(config.args ?? [])];
  const env = config.env ?? {};
  return createStdioTransportFromChild(
    () => backend.spawnStdio(argv, { ...(options.cwd !== undefined ? { cwd: options.cwd } : {}), env }),
    config.command,
    options,
  );
}

function parseSseBlock(block: string): Record<string, unknown> | undefined {
  const lines = block.split("\n");
  const dataLines: string[] = [];
  for (const raw of lines) {
    // Tolerate CRLF writers: strip a single trailing \r per line.
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    else if (line.startsWith("data")) {
      // "data" without colon is an empty payload line per SSE spec.
      if (line.trim() === "data") dataLines.push("");
    } else if (line.length === 0) continue;
    else if (line.startsWith(":")) continue;
    // event:, id:, retry: fields are intentionally ignored.
  }
  if (dataLines.length === 0) return undefined;
  // Multi-line data frames join with \n per SSE spec.
  const data = dataLines.join("\n");
  if (!data) return undefined;
  try {
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function createHttpTransport(
  url: string,
  headers?: Record<string, string>,
  timeoutMs?: number,
): McpTransport {
  let handler: ((msg: Record<string, unknown>) => void) | undefined;
  let closeHandler: (() => void) | undefined;
  const abortController = new AbortController();
  let streamStarted = false;

  /** Pump a ReadableStream body for SSE frames, feeding each parsed message to handler. */
  async function pumpSse(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let sep = buf.indexOf("\n\n");
      while (sep !== -1) {
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const msg = parseSseBlock(block);
        if (msg) handler?.(msg);
        sep = buf.indexOf("\n\n");
      }
    }
    // Flush remaining buffer
    buf += decoder.decode();
    buf = buf.replace(/\r\n/g, "\n");
    if (buf.trim().length > 0) {
      for (const block of buf.split("\n\n")) {
        if (!block.trim()) continue;
        const msg = parseSseBlock(block);
        if (msg) handler?.(msg);
      }
    }
  }

  async function fetchWithTimeout(input: string, init: RequestInit): Promise<Response> {
    if (timeoutMs === undefined) {
      return fetch(input, { ...init, signal: abortController.signal });
    }
    const ctrl = new AbortController();
    const onParentAbort = () => ctrl.abort();
    if (abortController.signal.aborted) {
      ctrl.abort();
    } else {
      abortController.signal.addEventListener("abort", onParentAbort, { once: true });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutError = () => new Error(`MCP HTTP request timed out after ${timeoutMs}ms for ${url}`);
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ctrl.abort();
        reject(timeoutError());
      }, timeoutMs);
    });
    try {
      return await Promise.race([fetch(input, { ...init, signal: ctrl.signal }), timeoutPromise]);
    } catch (error) {
      if (ctrl.signal.aborted && (error as Error)?.name === "AbortError") throw timeoutError();
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      abortController.signal.removeEventListener("abort", onParentAbort);
    }
  }

  return {
    async start() {
      if (streamStarted) return;
      streamStarted = true;
      // Start a persistent GET stream for server notifications (MCP Streamable HTTP).
      // This is a long-lived connection that receives unsolicited server notifications
      // outside of request/response cycles.
      const pump = async () => {
        try {
          const res = await fetch(url, {
            method: "GET",
            headers: {
              accept: "text/event-stream",
              ...(headers ?? {}),
            },
            signal: abortController.signal,
          });
          if (!res.ok || !res.body) {
            // If the server doesn't support GET streaming, that's fine —
            // notifications will still arrive via POST response SSE.
            return;
          }
          await pumpSse(res.body, abortController.signal);
        } catch (error) {
          // AbortError is expected on close; other errors are logged but
          // non-fatal — the transport still works for request/response.
          if ((error as Error).name !== "AbortError") {
            console.warn(`[mcp] GET stream error for ${url}:`, error);
          }
        }
      };
      // Fire-and-forget: the GET stream runs independently of request/response.
      void pump();
    },
    async send(message) {
      const res = await fetchWithTimeout(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(headers ?? {}),
        },
        body: JSON.stringify(message),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`MCP HTTP ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 500)}` : ""}`);
      }
      const ct = res.headers.get("content-type") ?? "";
      if (ct.includes("text/event-stream")) {
        if (!res.body) return;
        await pumpSse(res.body, abortController.signal);
        return;
      }
      const text = await res.text();
      if (!text.trim()) return;
      if (text.trimStart().startsWith("data:") || text.includes("\n\ndata:")) {
        for (const block of text.split("\n\n")) {
          const msg = parseSseBlock(block);
          if (msg) handler?.(msg);
        }
        return;
      }
      try {
        const data = JSON.parse(text) as Record<string, unknown>;
        handler?.(data);
      } catch {
        for (const line of text.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const msg = JSON.parse(trimmed) as Record<string, unknown>;
            handler?.(msg);
          } catch {
            /* best-effort: skip non-JSON lines in mixed response */
          }
        }
      }
    },
    onMessage(h) {
      handler = h;
    },
    onClose(h) {
      closeHandler = h;
    },
    stderrTail() {
      return "";
    },
    async close() {
      abortController.abort();
      closeHandler?.();
    },
  };
}

function createStdioTransport(
  command: string,
  args: string[],
  env: Record<string, string>,
  options: TransportOptions,
): McpTransport {
  return createStdioTransportFromChild(
    () =>
      Bun.spawn([command, ...args], {
        env: { ...process.env, ...env } as Record<string, string>,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      }),
    command,
    options,
  );
}

/** Piped child subset the JSONL pumps drive; both Bun.spawn results and container children fit. */
interface StdioChild {
  readonly stdin: unknown;
  readonly stdout: unknown;
  readonly stderr: unknown;
  readonly exited: Promise<number>;
  readonly pid?: number;
  kill(): void;
}

function createStdioTransportFromChild(
  startChild: () => StdioChild | Promise<StdioChild>,
  command: string,
  options: TransportOptions,
): McpTransport {
  let proc: StdioChild | undefined;
  let handler: ((msg: Record<string, unknown>) => void) | undefined;
  let closeHandler: (() => void) | undefined;
  let stderrBuf = "";
  const MAX_STDERR = 8192;

  const appendStderr = (chunk: string) => {
    stderrBuf += chunk;
    if (stderrBuf.length > MAX_STDERR) stderrBuf = stderrBuf.slice(-MAX_STDERR);
  };

  return {
    async start() {
      proc = await startChild();
      if (options.adopt && proc.pid) {
        options.adopt({ pid: proc.pid, kill: () => proc?.kill() }, command);
      }
      if (proc.stdout && typeof proc.stdout !== "number") {
        const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
        let buf = "";
        const pump = async () => {
          while (true) {
            const { value, done } = await reader.read();
            if (done) {
              closeHandler?.();
              break;
            }
            buf += new TextDecoder().decode(value);
            let idx = buf.indexOf("\n");
            while (idx !== -1) {
              const line = buf.slice(0, idx).trim();
              buf = buf.slice(idx + 1);
              if (line.length === 0) continue;
              try {
                const msg = JSON.parse(line) as Record<string, unknown>;
                handler?.(msg);
              } catch {}
              idx = buf.indexOf("\n");
            }
          }
        };
        void pump();
      }
      if (proc.stderr && typeof proc.stderr !== "number") {
        const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
        const pumpErr = async () => {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            appendStderr(new TextDecoder().decode(value));
          }
        };
        void pumpErr();
      }
      if (proc && typeof (proc as unknown as { exited?: Promise<number> }).exited === "object") {
        void (proc as unknown as { exited: Promise<number> }).exited
          .then(() => closeHandler?.())
          .catch(() => {
            /* best-effort: process may already have exited */
          });
      }
    },
    async send(message) {
      if (!proc?.stdin || typeof proc.stdin === "number") throw new Error("transport not started");
      const payload = `${JSON.stringify(message)}\n`;
      const stdin = proc.stdin as unknown as {
        write: (d: string | Uint8Array) => void;
        getWriter?: () => { write: (c: Uint8Array) => Promise<void>; releaseLock: () => void };
        on?: (ev: string, cb: () => void) => void;
      };
      if (typeof stdin.write === "function") {
        try {
          stdin.write(payload);
        } catch {
          /* best-effort write: stdin may have closed */
        }
        if (typeof stdin.on === "function") stdin.on("error", () => {});
      } else if (stdin.getWriter) {
        const writer = stdin.getWriter();
        await writer.write(new TextEncoder().encode(payload)).catch(() => {
          /* best-effort write: stream may have closed */
        });
        writer.releaseLock();
      } else {
        throw new Error("transport stdin not writable");
      }
    },
    onMessage(h) {
      handler = h;
    },
    onClose(h) {
      closeHandler = h;
    },
    stderrTail() {
      return stderrBuf.trim();
    },
    async close() {
      proc?.kill();
      closeHandler?.();
    },
  };
}

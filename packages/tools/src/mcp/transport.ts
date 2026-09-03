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
}

export function createMcpTransport(
  _serverName: string,
  config: McpServerConfig,
  options: TransportOptions = {},
): McpTransport {
  if (config.url) {
    return createHttpTransport(config.url, config.headers);
  }
  if (config.command) {
    return createStdioTransport(config.command, config.args ?? [], config.env ?? {}, options);
  }
  throw new Error(`MCP server config needs command or url`);
}

function parseSseBlock(block: string): Record<string, unknown> | undefined {
  const lines = block.split("\n");
  let data = "";
  for (const line of lines) {
    if (line.startsWith("data:")) data += line.slice(5).trimStart();
    else if (line.length === 0) continue;
    else if (line.startsWith(":")) continue;
  }
  if (!data) return undefined;
  try {
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function createHttpTransport(url: string, headers?: Record<string, string>): McpTransport {
  let handler: ((msg: Record<string, unknown>) => void) | undefined;
  let closeHandler: (() => void) | undefined;
  return {
    async start() {},
    async send(message) {
      const res = await fetch(url, {
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
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let sep = buf.indexOf("\n\n");
          while (sep !== -1) {
            const block = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            const msg = parseSseBlock(block);
            if (msg) handler?.(msg);
            sep = buf.indexOf("\n\n");
          }
        }
        buf += decoder.decode();
        if (buf.trim().length > 0) {
          for (const block of buf.split("\n\n")) {
            if (!block.trim()) continue;
            const msg = parseSseBlock(block);
            if (msg) handler?.(msg);
          }
        }
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
          } catch {}
        }
      }
    },
    onMessage(h) {
      handler = h;
    },
    onClose(h) {
      closeHandler = h;
    },
    async close() {
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
  let proc: ReturnType<typeof Bun.spawn> | undefined;
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
      proc = Bun.spawn([command, ...args], {
        env: { ...process.env, ...env } as Record<string, string>,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      if (options.adopt && proc.pid) {
        options.adopt({ pid: proc.pid, kill: () => proc?.kill() }, command);
      }
      if (proc.stdout && typeof proc.stdout !== "number") {
        const reader = proc.stdout.getReader();
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
        const reader = proc.stderr.getReader();
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
        void (proc as unknown as { exited: Promise<number> }).exited.then(() => closeHandler?.()).catch(() => {});
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
        } catch {}
        if (typeof stdin.on === "function") stdin.on("error", () => {});
      } else if (stdin.getWriter) {
        const writer = stdin.getWriter();
        await writer.write(new TextEncoder().encode(payload)).catch(() => {});
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

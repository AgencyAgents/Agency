import type { McpServerConfig } from "./config.ts";

export interface McpTransport {
  start(): Promise<void>;
  send(message: Record<string, unknown>): Promise<void>;
  onMessage(handler: (msg: Record<string, unknown>) => void): void;
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
    return createHttpTransport(config.url);
  }
  if (config.command) {
    return createStdioTransport(config.command, config.args ?? [], config.env ?? {}, options);
  }
  throw new Error(`MCP server config needs command or url`);
}

function createHttpTransport(url: string): McpTransport {
  let handler: ((msg: Record<string, unknown>) => void) | undefined;
  return {
    async start() {},
    async send(message) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(message),
      });
      const data = (await res.json()) as Record<string, unknown>;
      handler?.(data);
    },
    onMessage(h) {
      handler = h;
    },
    async close() {},
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
            if (done) break;
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
    },
    async send(message) {
      if (!proc?.stdin || typeof proc.stdin === "number") throw new Error("transport not started");
      const payload = `${JSON.stringify(message)}\n`;
      const stdin = proc.stdin as unknown as {
        write: (d: string | Uint8Array) => void;
        getWriter?: () => { write: (c: Uint8Array) => Promise<void>; releaseLock: () => void };
      };
      if (typeof stdin.write === "function") {
        stdin.write(payload);
      } else if (stdin.getWriter) {
        const writer = stdin.getWriter();
        await writer.write(new TextEncoder().encode(payload));
        writer.releaseLock();
      } else {
        throw new Error("transport stdin not writable");
      }
    },
    onMessage(h) {
      handler = h;
    },
    async close() {
      proc?.kill();
    },
  };
}

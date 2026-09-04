import { counterIds, PendingRequestManager } from "@agency/net";
import type { McpToolDefinition } from "./adapt.ts";
import type { McpTransport } from "./transport.ts";

export interface McpClientOptions {
  requestTimeoutMs?: number;
  toolCallTimeoutMs?: number;
}

export class McpClient {
  private readonly pending = new PendingRequestManager({ makeId: counterIds() });
  private onToolListChanged?: () => void;
  private readonly requestTimeoutMs: number;
  private readonly toolCallTimeoutMs: number;

  constructor(
    private readonly name: string,
    private readonly transport: McpTransport,
    options: McpClientOptions = {},
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.toolCallTimeoutMs = options.toolCallTimeoutMs ?? options.requestTimeoutMs ?? 10_000;
    this.transport.onMessage((msg) => this.handleMessage(msg));
    this.transport.onClose?.(() => {
      this.pending.failAll(new Error(`MCP ${this.name} transport closed`));
    });
  }

  onListChanged(cb: () => void): void {
    this.onToolListChanged = cb;
  }

  async initialize(): Promise<void> {
    await this.request("initialize", { clientInfo: { name: "agency", version: "0.1.0" } });
    this.notify("notifications/initialized", {});
  }

  async listTools(): Promise<McpToolDefinition[]> {
    const result = (await this.request("tools/list", {})) as { tools?: McpToolDefinition[] };
    return result.tools ?? [];
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ content: unknown; isError?: boolean }> {
    const result = (await this.request(
      "tools/call",
      { name, arguments: args },
      { timeoutMs: this.toolCallTimeoutMs, signal },
    )) as {
      content?: unknown;
      isError?: boolean;
    };
    return { content: result.content, isError: result.isError };
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  private notify(method: string, params: unknown): void {
    this.transport.send({ jsonrpc: "2.0", method, params }).catch(() => {
      /* best-effort notification: transport may be closing */
    });
  }

  private request(
    method: string,
    params: unknown,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    const timeoutMs =
      opts.timeoutMs ?? (method === "tools/call" ? this.toolCallTimeoutMs : this.requestTimeoutMs);
    const { id, promise } = this.pending.register(
      timeoutMs,
      () => new Error(`MCP ${this.name} ${method} timed out`),
    );
    if (opts.signal) {
      if (opts.signal.aborted) {
        this.pending.reject(id, new Error(`MCP ${this.name} ${method} aborted`));
      } else {
        const onAbort = () => {
          this.pending.reject(id, new Error(`MCP ${this.name} ${method} aborted`));
        };
        opts.signal.addEventListener("abort", onAbort, { once: true });
        void promise.then(
          () => opts.signal?.removeEventListener("abort", onAbort),
          () => opts.signal?.removeEventListener("abort", onAbort),
        );
      }
    }
    this.transport.send({ jsonrpc: "2.0", id, method, params }).catch((error: unknown) => {
      this.pending.reject(id, error instanceof Error ? error : new Error(String(error)));
    });
    return promise;
  }

  private handleMessage(msg: Record<string, unknown>): void {
    if (typeof msg.method === "string") {
      if (msg.method === "notifications/tools/list_changed") {
        this.onToolListChanged?.();
      }
      return;
    }
    const id = msg.id as number | undefined;
    if (typeof id !== "number") return;
    if (msg.error) {
      this.pending.reject(id, new Error(String((msg.error as { message?: string })?.message ?? "MCP error")));
      return;
    }
    this.pending.resolve(id, msg.result);
  }
}

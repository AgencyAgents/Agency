import { counterIds, PendingRequestManager } from "@agency/net";
import type { McpToolDefinition } from "./adapt.ts";
import type { McpTransport } from "./transport.ts";

export class McpClient {
  private readonly pending = new PendingRequestManager({ makeId: counterIds() });
  private onToolListChanged?: () => void;

  constructor(
    private readonly name: string,
    private readonly transport: McpTransport,
  ) {
    this.transport.onMessage((msg) => this.handleMessage(msg));
  }

  onListChanged(cb: () => void): void {
    this.onToolListChanged = cb;
  }

  async initialize(): Promise<void> {
    await this.request("initialize", { clientInfo: { name: "agency", version: "0.1.0" } });
  }

  async listTools(): Promise<McpToolDefinition[]> {
    const result = (await this.request("tools/list", {})) as { tools?: McpToolDefinition[] };
    return result.tools ?? [];
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    _signal?: AbortSignal,
  ): Promise<{ content: unknown; isError?: boolean }> {
    const result = (await this.request("tools/call", { name, arguments: args })) as {
      content?: unknown;
      isError?: boolean;
    };
    return { content: result.content, isError: result.isError };
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const { id, promise } = this.pending.register(
      10_000,
      () => new Error(`MCP ${this.name} ${method} timed out`),
    );
    // A failed write must fail the request now with the real error, not 10s
    // from now as a generic timeout. If a response already settled the
    // request, reject() is a no-op (so a late send failure can't clobber it).
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

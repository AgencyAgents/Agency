import type { McpToolDefinition } from "./adapt.ts";
import type { McpTransport } from "./transport.ts";

export class McpClient {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(
    private readonly name: string,
    private readonly transport: McpTransport,
  ) {
    this.transport.onMessage((msg) => this.handleMessage(msg));
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
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      void this.transport.send({ jsonrpc: "2.0", id, method, params });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP ${this.name} ${method} timed out`));
        }
      }, 10_000);
    });
  }

  private handleMessage(msg: Record<string, unknown>): void {
    const id = msg.id as number | undefined;
    if (typeof id !== "number") return;
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    if (msg.error) {
      entry.reject(new Error(String((msg.error as { message?: string })?.message ?? "MCP error")));
      return;
    }
    entry.resolve(msg.result);
  }
}

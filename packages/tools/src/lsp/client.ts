import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { t } from "@agency/i18n";
import { counterIds, PendingRequestManager } from "@agency/net";

/** One language-server diagnostic, narrowed to what edit verification reports. */
export interface LspDiagnostic {
  /** LSP severity: 1=Error 2=Warning 3=Information 4=Hint. */
  severity: number;
  message: string;
  /** 0-based line. */
  line: number;
  /** 0-based character. */
  character: number;
  source?: string;
}

export interface LspClientOptions {
  command: string;
  args?: string[];
  cwd?: string;
  requestTimeoutMs?: number;
}

export interface LspLocation {
  path: string;
  line: number;
  character: number;
}

const HEADER_SEPARATOR = Buffer.from("\r\n\r\n");

function indexOfSubsequence(haystack: Buffer, needle: Buffer, from = 0): number {
  const last = haystack.length - needle.length;
  for (let i = from; i <= last; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}

/**
 * Minimal LSP client over a spawned stdio process: initialize handshake,
 * didOpen/didChange notifications, push-based publishDiagnostics cache, and
 * the textDocument/references request. Push-based diagnostics mean the cached
 * read IS the query — an empty result (no server, nothing pushed yet) never
 * blocks or fails a caller.
 */
export class LspClient {
  private readonly pending = new PendingRequestManager({ makeId: counterIds() });
  private readonly diagnostics = new Map<string, LspDiagnostic[]>();
  private buffer = Buffer.alloc(0);
  private child: ReturnType<typeof spawn> | undefined;
  private readonly timeoutMs: number;
  private closed = false;

  /** Resolves once the initialize handshake completes. */
  readonly ready: Promise<void>;

  constructor(private readonly options: LspClientOptions) {
    this.timeoutMs = options.requestTimeoutMs ?? 10_000;
    this.ready = this.start();
  }

  private async start(): Promise<void> {
    this.child = spawn(this.options.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      stdio: ["pipe", "pipe", "ignore"],
    });
    this.child.stdout?.on("data", (chunk: Buffer) => this.handleChunk(chunk));
    this.child.on("error", (error) =>
      this.pending.failAll(new Error(`language server failed to start: ${error.message}`)),
    );
    this.child.on("exit", () => {
      if (!this.closed) this.pending.failAll(new Error("language server exited unexpectedly"));
    });

    await this.request("initialize", {
      processId: process.pid,
      rootUri: this.options.cwd ? pathToFileURL(this.options.cwd).href : undefined,
      capabilities: {},
    });
    this.notify("initialized", {});
  }

  /** Sends textDocument/didOpen so the server starts analyzing the file. */
  open(path: string, text: string, languageId: string): void {
    this.notify("textDocument/didOpen", {
      textDocument: { uri: pathToFileURL(path).href, languageId, version: 1, text },
    });
  }

  /** Sends textDocument/didChange with the file's full new text. */
  change(path: string, text: string): void {
    this.notify("textDocument/didChange", {
      textDocument: { uri: pathToFileURL(path).href, version: this.nextVersion() },
      contentChanges: [{ text }],
    });
  }

  private version = 1;
  private nextVersion(): number {
    this.version += 1;
    return this.version;
  }

  /** The diagnostics the server has pushed for `path` so far (sync cache read). */
  diagnosticsFor(path: string): readonly LspDiagnostic[] {
    return this.diagnostics.get(pathToFileURL(path).href) ?? [];
  }

  /** textDocument/references, resolved to plain paths. */
  async references(path: string, line: number, character: number): Promise<LspLocation[]> {
    const result = (await this.request("textDocument/references", {
      textDocument: { uri: pathToFileURL(path).href },
      position: { line, character },
      context: { includeDeclaration: true },
    })) as Array<{ uri: string; range: { start: { line: number; character: number } } }> | undefined;
    return (result ?? []).map((location) => ({
      path: fileURLToPath(location.uri),
      line: location.range.start.line,
      character: location.range.start.character,
    }));
  }

  /** shutdown + exit, then kills the process; safe to call more than once. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.request("shutdown", null, 2_000);
      this.notify("exit", null);
    } catch {
      // A hung or crashed server still gets killed below.
    }
    this.child?.kill();
    this.pending.failAll(new Error("language server closed"));
  }

  private request(method: string, params: unknown, timeoutMs = this.timeoutMs): Promise<unknown> {
    const { id, promise } = this.pending.register(
      timeoutMs,
      () => new Error(t("lsp.request.timeout", { method, ms: timeoutMs })),
    );
    this.send({ jsonrpc: "2.0", id, method, params });
    return promise;
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private send(message: Record<string, unknown>): void {
    const stdin = this.child?.stdin;
    if (!stdin?.writable) return;
    const body = Buffer.from(JSON.stringify(message), "utf8");
    stdin.on("error", () => {});
    stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    stdin.write(body);
  }

  private handleChunk(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (true) {
      const headerEnd = indexOfSubsequence(this.buffer, HEADER_SEPARATOR);
      if (headerEnd === -1) return;
      const header = this.buffer.subarray(0, headerEnd).toString("utf8");
      const match = /Content-Length: (\d+)/i.exec(header);
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + HEADER_SEPARATOR.length);
        continue;
      }
      const bodyStart = headerEnd + HEADER_SEPARATOR.length;
      const bodyEnd = bodyStart + Number(match[1]);
      if (this.buffer.length < bodyEnd) return;
      const body = this.buffer.subarray(bodyStart, bodyEnd).toString("utf8");
      this.buffer = this.buffer.subarray(bodyEnd);
      this.handleMessage(JSON.parse(body) as Record<string, unknown>);
    }
  }

  private handleMessage(message: Record<string, unknown>): void {
    const id = message.id;
    if (typeof id === "number" && typeof message.method === "string") {
      // Server->client request we don't implement: answer so it never hangs.
      this.send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
      return;
    }
    if (typeof id === "number") {
      if (message.error) {
        this.pending.reject(
          id,
          new Error(String((message.error as { message?: string }).message ?? "LSP error")),
        );
      } else {
        this.pending.resolve(id, message.result);
      }
      return;
    }
    if (message.method === "textDocument/publishDiagnostics") {
      const params = message.params as
        | { uri?: string; diagnostics?: Array<Record<string, unknown>> }
        | undefined;
      if (!params?.uri) return;
      this.diagnostics.set(params.uri, (params.diagnostics ?? []).map(toDiagnostic));
    }
  }
}

function toDiagnostic(raw: Record<string, unknown>): LspDiagnostic {
  const range = raw.range as { start?: { line?: number; character?: number } } | undefined;
  return {
    severity: typeof raw.severity === "number" ? raw.severity : 3,
    message: String(raw.message ?? ""),
    line: range?.start?.line ?? 0,
    character: range?.start?.character ?? 0,
    source: typeof raw.source === "string" ? raw.source : undefined,
  };
}

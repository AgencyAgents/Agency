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
  env?: Record<string, string>;
  requestTimeoutMs?: number;
}

export interface LspLocation {
  path: string;
  line: number;
  character: number;
}

/** One workspace/document symbol, flattened from the server's hierarchy. */
export interface LspSymbol {
  name: string;
  kind: number;
  path: string;
  line: number;
  character: number;
  containerName?: string;
}

/** A single text replacement inside one file (0-based positions). */
export interface LspTextEdit {
  path: string;
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
  newText: string;
}

/** What textDocument/prepareRename reported (null when rename is unavailable). */
export interface LspPrepareRename {
  placeholder?: string;
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
}

const HEADER_SEPARATOR = Buffer.from("\r\n\r\n");

const LSP_DIAGNOSTICS_POLL_MS = 50;

/** fileURLToPath without throwing on non-native URIs (keeps the raw uri then). */
function uriToPath(uri: string): string {
  try {
    return fileURLToPath(uri);
  } catch {
    return uri;
  }
}

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
      env: this.options.env ? ({ ...process.env, ...this.options.env } as Record<string, string>) : undefined,
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

  /**
   * Polls the push-based diagnostics cache until the server publishes for
   * `path` or `timeoutMs` elapses (default 1200ms). Resolves with whatever is
   * cached on timeout — never rejects, never blocks an edit.
   */
  async waitForDiagnostics(path: string, timeoutMs = 1200): Promise<readonly LspDiagnostic[]> {
    const uri = pathToFileURL(path).href;
    const initial = this.diagnostics.get(uri);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, LSP_DIAGNOSTICS_POLL_MS));
      const cur = this.diagnostics.get(uri);
      if (cur !== undefined && cur !== initial) return cur;
    }
    return this.diagnosticsFor(path);
  }

  /** textDocument/references, resolved to plain paths. */
  async references(path: string, line: number, character: number): Promise<LspLocation[]> {
    const result = (await this.request("textDocument/references", {
      textDocument: { uri: pathToFileURL(path).href },
      position: { line, character },
      context: { includeDeclaration: true },
    })) as Array<{ uri: string; range: { start: { line: number; character: number } } }> | undefined;
    return (result ?? []).map((location) => ({
      path: uriToPath(location.uri),
      line: location.range.start.line,
      character: location.range.start.character,
    }));
  }

  /** textDocument/definition, resolved to plain paths (single, array, or LocationLink). */
  async definition(path: string, line: number, character: number): Promise<LspLocation[]> {
    const result = (await this.request("textDocument/definition", {
      textDocument: { uri: pathToFileURL(path).href },
      position: { line, character },
    })) as
      | { uri: string; range: { start: { line: number; character: number } } }
      | Array<
          | { uri: string; range: { start: { line: number; character: number } } }
          | { targetUri: string; targetSelectionRange: { start: { line: number; character: number } } }
        >
      | undefined;
    if (!result) return [];
    const items = Array.isArray(result) ? result : [result];
    return items.map((location) => {
      if ("targetUri" in location) {
        return {
          path: uriToPath(location.targetUri),
          line: location.targetSelectionRange.start.line,
          character: location.targetSelectionRange.start.character,
        };
      }
      return {
        path: uriToPath(location.uri),
        line: location.range.start.line,
        character: location.range.start.character,
      };
    });
  }

  /** textDocument/documentSymbol for one file, flattened to a plain list. */
  async documentSymbols(path: string): Promise<LspSymbol[]> {
    const result = (await this.request("textDocument/documentSymbol", {
      textDocument: { uri: pathToFileURL(path).href },
    })) as Array<Record<string, unknown>> | undefined;
    const out: LspSymbol[] = [];
    const walk = (nodes: Array<Record<string, unknown>>, container?: string): void => {
      for (const node of nodes) {
        const range = node.range as { start?: { line?: number; character?: number } } | undefined;
        const selection = node.selectionRange as
          | { start?: { line?: number; character?: number } }
          | undefined;
        const start = selection?.start ?? range?.start;
        out.push({
          name: String(node.name ?? ""),
          kind: typeof node.kind === "number" ? node.kind : 0,
          path,
          line: start?.line ?? 0,
          character: start?.character ?? 0,
          containerName:
            container ?? (typeof node.containerName === "string" ? node.containerName : undefined),
        });
        const children = node.children;
        if (Array.isArray(children))
          walk(children as Array<Record<string, unknown>>, String(node.name ?? ""));
      }
    };
    walk(result ?? []);
    return out;
  }

  /** workspace/symbol query across the project. */
  async workspaceSymbols(query: string): Promise<LspSymbol[]> {
    const result = (await this.request("workspace/symbol", { query })) as
      | Array<{
          name?: string;
          kind?: number;
          location?: { uri?: string; range?: { start?: { line?: number; character?: number } } };
          containerName?: string;
        }>
      | undefined;
    return (result ?? []).map((symbol) => ({
      name: String(symbol.name ?? ""),
      kind: typeof symbol.kind === "number" ? symbol.kind : 0,
      path: symbol.location?.uri ? uriToPath(symbol.location.uri) : "",
      line: symbol.location?.range?.start?.line ?? 0,
      character: symbol.location?.range?.start?.character ?? 0,
      containerName: symbol.containerName,
    }));
  }

  /** textDocument/prepareRename; null when the server refuses the rename. */
  async prepareRename(path: string, line: number, character: number): Promise<LspPrepareRename | null> {
    let result: unknown;
    try {
      result = await this.request("textDocument/prepareRename", {
        textDocument: { uri: pathToFileURL(path).href },
        position: { line, character },
      });
    } catch {
      return null;
    }
    if (result === null || result === undefined) return null;
    if (
      typeof result === "object" &&
      ("placeholder" in (result as Record<string, unknown>) || "range" in (result as Record<string, unknown>))
    ) {
      const r = result as {
        placeholder?: string;
        range?: {
          start?: { line?: number; character?: number };
          end?: { line?: number; character?: number };
        };
        start?: { line?: number; character?: number };
        end?: { line?: number; character?: number };
      };
      const start = r.range?.start ?? r.start;
      const end = r.range?.end ?? r.end;
      return {
        placeholder: typeof r.placeholder === "string" ? r.placeholder : undefined,
        line: start?.line ?? line,
        character: start?.character ?? character,
        endLine: end?.line ?? line,
        endCharacter: end?.character ?? character,
      };
    }
    return { line, character, endLine: line, endCharacter: character };
  }

  /**
   * textDocument/rename, returned as a flat edit list the agent applies with
   * the edit tool (which owns snapshots, approval, and diagnostics) — the LSP
   * layer never writes files itself.
   */
  async rename(path: string, line: number, character: number, newName: string): Promise<LspTextEdit[]> {
    const result = (await this.request("textDocument/rename", {
      textDocument: { uri: pathToFileURL(path).href },
      position: { line, character },
      newName,
    })) as
      | {
          changes?: Record<
            string,
            Array<{
              range: { start: { line: number; character: number }; end: { line: number; character: number } };
              newText: string;
            }>
          >;
        }
      | undefined;
    const changes = result?.changes ?? {};
    const out: LspTextEdit[] = [];
    for (const [uri, edits] of Object.entries(changes)) {
      for (const edit of edits) {
        out.push({
          path: uriToPath(uri),
          line: edit.range.start.line,
          character: edit.range.start.character,
          endLine: edit.range.end.line,
          endCharacter: edit.range.end.character,
          newText: edit.newText,
        });
      }
    }
    return out;
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

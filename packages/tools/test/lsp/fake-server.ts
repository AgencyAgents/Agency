let buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;
    const header = buffer.subarray(0, headerEnd).toString("utf8");
    const length = Number(/Content-Length: (\d+)/i.exec(header)?.[1]);
    if (!length) break;
    const bodyEnd = headerEnd + 4 + length;
    if (buffer.length < bodyEnd) break;
    const message = JSON.parse(buffer.subarray(headerEnd + 4, bodyEnd).toString("utf8")) as Record<
      string,
      unknown
    >;
    buffer = buffer.subarray(bodyEnd);
    handle(message);
  }
});

function send(message: Record<string, unknown>): void {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function handle(message: Record<string, unknown>): void {
  const id = message.id as number | undefined;
  switch (message.method) {
    case "initialize":
      send({ jsonrpc: "2.0", id, result: { capabilities: { textDocumentSync: 1 } } });
      break;
    case "textDocument/didOpen":
      send({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: {
          uri: (message.params as { textDocument: { uri: string } }).textDocument.uri,
          diagnostics: [
            { severity: 1, message: "boom", range: { start: { line: 2, character: 4 } }, source: "fake" },
            { severity: 2, message: "meh", range: { start: { line: 0, character: 0 } } },
          ],
        },
      });
      break;
    case "textDocument/references":
      send({
        jsonrpc: "2.0",
        id,
        result: [
          {
            uri: (message.params as { textDocument: { uri: string } }).textDocument.uri,
            range: { start: { line: 7, character: 1 } },
          },
        ],
      });
      break;
    case "textDocument/definition":
      send({
        jsonrpc: "2.0",
        id,
        result: [
          {
            uri: (message.params as { textDocument: { uri: string } }).textDocument.uri,
            range: { start: { line: 3, character: 2 } },
          },
        ],
      });
      break;
    case "textDocument/documentSymbol":
      send({
        jsonrpc: "2.0",
        id,
        result: [
          {
            name: "greet",
            kind: 12,
            range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
            selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 14 } },
            children: [
              {
                name: "name",
                kind: 13,
                range: { start: { line: 0, character: 15 }, end: { line: 0, character: 19 } },
                selectionRange: { start: { line: 0, character: 15 }, end: { line: 0, character: 19 } },
              },
            ],
          },
        ],
      });
      break;
    case "workspace/symbol":
      send({
        jsonrpc: "2.0",
        id,
        result: [
          {
            name: "greet",
            kind: 12,
            location: {
              uri: "file:///ws/sample.ts",
              range: { start: { line: 0, character: 9 } },
            },
            containerName: "mod",
          },
        ],
      });
      break;
    case "textDocument/prepareRename": {
      const pos = (message.params as { position: { line: number; character: number } }).position;
      send({
        jsonrpc: "2.0",
        id,
        result: {
          range: {
            start: { line: pos.line, character: pos.character },
            end: { line: pos.line, character: pos.character + 5 },
          },
          placeholder: "greet",
        },
      });
      break;
    }
    case "textDocument/rename": {
      const uri = (message.params as { textDocument: { uri: string } }).textDocument.uri;
      const newName = (message.params as { newName: string }).newName;
      send({
        jsonrpc: "2.0",
        id,
        result: {
          changes: {
            [uri]: [
              {
                range: { start: { line: 0, character: 9 }, end: { line: 0, character: 14 } },
                newText: newName,
              },
            ],
          },
        },
      });
      break;
    }
    case "shutdown":
      send({ jsonrpc: "2.0", id, result: null });
      break;
    default:
      if (id !== undefined && message.method) {
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: "nope" } });
      }
  }
}

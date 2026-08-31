/** One `text/event-stream` frame: optional named event, joined multi-line data. */
export interface SseEvent {
  event?: string;
  data: string;
}

/**
 * Parses a fetch Response body as Server-Sent Events. Shared by every adapter
 * (Anthropic, OpenAI-compatible, Google) since they all speak SSE, even though
 * the JSON payload inside `data:` differs per provider.
 */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncIterable<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseEvent(rawEvent);
        if (parsed) yield parsed;
      }
    }

    if (buffer.trim()) {
      const parsed = parseEvent(buffer);
      if (parsed) yield parsed;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseEvent(raw: string): SseEvent | undefined {
  let event: string | undefined;
  const dataLines: string[] = [];

  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  if (dataLines.length === 0) return undefined;
  return { event, data: dataLines.join("\n") };
}

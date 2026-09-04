import type { StreamEvent } from "./types.ts";

/**
 * Wraps an adapter's event stream with mid-flight recovery: an SSE connection
 * that dies AFTER content has already been streamed (deltas or an open tool
 * call) would otherwise propagate out of the iterator and make the scheduler
 * retry the entire request, re-billing every input token for content the
 * caller already has. Instead, the partial turn is salvaged — the deltas seen
 * so far stand, and a synthetic `message_stop` with stopReason "error" ends
 * the turn cleanly so the loop can persist it like any other stop.
 *
 * A failure BEFORE any content arrives is rethrown untouched: retrying from
 * scratch is then correct and costs nothing beyond the failed connection.
 */
export async function* withMidStreamRecovery(events: AsyncIterable<StreamEvent>): AsyncIterable<StreamEvent> {
  const iterator = events[Symbol.asyncIterator]();
  let sawContent = false;
  let sawStop = false;
  // Track tool calls that have started but not yet ended, so we can close
  // them out if the connection drops mid-stream.
  const openToolCalls = new Set<string>();

  while (true) {
    let next: IteratorResult<StreamEvent>;
    try {
      next = await iterator.next();
    } catch (error) {
      if (sawStop) return;
      if (!sawContent) throw error;
      // Close any dangling tool calls before synthesizing the stop.
      for (const id of openToolCalls) {
        yield { type: "tool_call_end", id };
      }
      yield {
        type: "message_stop",
        stopReason: "error",
        // The connection died before the provider reported usage for this
        // request; the partial output is billed server-side but unreportable.
        usage: { inputTokens: 0, outputTokens: 0 },
      };
      return;
    }
    if (next.done) return;
    const event = next.value;
    if (event.type === "message_stop") sawStop = true;
    else sawContent = true;
    // Track tool call lifecycle so we can close dangling calls on recovery.
    if (event.type === "tool_call_start") openToolCalls.add(event.id);
    else if (event.type === "tool_call_end") openToolCalls.delete(event.id);
    yield event;
  }
}

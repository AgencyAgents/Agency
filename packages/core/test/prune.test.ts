import { expect, test } from "bun:test";
import type { Message } from "@agency/schema";
import { pruneStaleResults } from "../src/prune.ts";

/** A history of `calls` model calls, each a call of `tool` with a result of `size` characters. */
function history(calls: number, tool: string, size: number): Message[] {
  const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "go" }] }];
  for (let i = 0; i < calls; i++) {
    messages.push({
      role: "assistant",
      content: [{ type: "tool_call", id: `c${i}`, name: tool, input: {} }],
    });
    messages.push({
      role: "user",
      content: [
        { type: "tool_result", toolCallId: `c${i}`, content: `${i}:`.padEnd(size, "x"), isError: false },
      ],
    });
  }
  return messages;
}

const notes = (messages: Message[]) =>
  messages.flatMap((m) =>
    m.content.flatMap((b) =>
      b.type === "tool_result" && b.content.startsWith("[The ") ? [b.toolCallId] : [],
    ),
  );

test("old results of re-runnable tools become a note, in batches, and the same history gives the same request", () => {
  // 10k characters each: a batch passes 20k tokens at 9 results that are over 10 calls old.
  const long = history(30, "bash", 10_000);
  const pruned = pruneStaleResults(long);
  // Two batches are due by call 30: c0-c8 at call 20 and c9-c17 at call 29.
  expect(notes(pruned)).toEqual(Array.from({ length: 18 }, (_, i) => `c${i}`));
  expect(JSON.stringify(pruneStaleResults(long))).toBe(JSON.stringify(pruned));
  // The request after one more call starts with the messages of the request before: the prompt cache holds.
  const after = pruneStaleResults(history(31, "bash", 10_000));
  expect(JSON.stringify(after.slice(0, pruned.length))).toBe(JSON.stringify(pruned));
  expect(pruned[2]?.content[0]).toMatchObject({
    content:
      "[The 10000-character result of this old bash call was removed to save context. Call bash again if you need it.]",
  });
});

test("a short history, short results and the results of other tools stay whole", () => {
  const short = history(10, "bash", 10_000);
  expect(pruneStaleResults(short)).toBe(short);
  const small = history(40, "read", 1_500);
  expect(pruneStaleResults(small)).toBe(small);
  const agents = history(40, "spawn", 10_000);
  expect(pruneStaleResults(agents)).toBe(agents);
});

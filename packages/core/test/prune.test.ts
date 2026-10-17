import { expect, test } from "bun:test";
import type { Message } from "@agency/schema";
import { dedupeReads, pruneStaleResults } from "../src/prune.ts";

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

test("a read the model can still see comes back as a note; once that result is pruned, a read gives the text again", () => {
  const text = "line\n".repeat(200);
  const read = (id: string): Message => ({
    role: "assistant",
    content: [{ type: "tool_call", id, name: "read", input: { path: "a.ts" } }],
  });
  const result = (id: string, content = text) => ({
    type: "tool_result" as const,
    toolCallId: id,
    content,
    isError: false,
  });
  const visible: Message[] = [read("c1"), { role: "user", content: [result("c1")] }];
  const calls = [{ id: "c2", name: "read", input: { path: "a.ts" } }];

  const [same] = dedupeReads([result("c2")], calls, visible);
  expect(same?.type === "tool_result" && same.content).toBe(
    "[Unchanged: the same text as the earlier read result of a.ts, which is still above.]",
  );
  expect(dedupeReads([result("c2", `${text}changed`)], calls, visible)[0]).toEqual(
    result("c2", `${text}changed`),
  );
  const pruned: Message[] = [
    read("c1"),
    { role: "user", content: [result("c1", "[The old result was removed.]")] },
  ];
  expect(dedupeReads([result("c2")], calls, pruned)[0]).toEqual(result("c2"));
  const twice = dedupeReads(
    [result("c2"), result("c3")],
    [...calls, { id: "c3", name: "read", input: { path: "a.ts" } }],
    [],
  );
  expect(twice[0]).toEqual(result("c2"));
  expect(twice[1]?.type === "tool_result" && twice[1].content.startsWith("[Unchanged")).toBe(true);
});

test("a read that a later read of the same file shows again goes in the next batch, not 10 calls later", () => {
  const reads = (inputs: Array<Record<string, unknown>>): Message[] => [
    { role: "user", content: [{ type: "text", text: "go" }] },
    ...inputs.flatMap((input, i): Message[] => [
      { role: "assistant", content: [{ type: "tool_call", id: `r${i}`, name: "read", input }] },
      {
        role: "user",
        content: [
          { type: "tool_result", toolCallId: `r${i}`, content: `v${i}:`.padEnd(10_000, "x"), isError: false },
        ],
      },
    ]),
  ];
  // Ten whole reads of a.ts as it changes: by the tenth, the nine before are out of date and pass a batch.
  const whole = reads(Array.from({ length: 10 }, () => ({ path: "a.ts" })));
  expect(notes(pruneStaleResults(whole))).toEqual(Array.from({ length: 9 }, (_, i) => `r${i}`));
  // A slice does not show the whole file again, and another file is another file.
  const other = reads([
    ...Array.from({ length: 10 }, () => ({ path: "a.ts" })),
    { path: "a.ts", offset: 10, limit: 20 },
  ]);
  expect(notes(pruneStaleResults(other))).toEqual(Array.from({ length: 9 }, (_, i) => `r${i}`));
  const files = reads(Array.from({ length: 10 }, (_, i) => ({ path: `f${i}.ts` })));
  expect(notes(pruneStaleResults(files))).toEqual([]);
});

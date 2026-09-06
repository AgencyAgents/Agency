/**
 * Compaction prompt: a structured session summarizer that compacts a
 * conversation into a condensed representation. All tools denied. Preserves
 * todo_state entries and recent assistant texts verbatim.
 */
export function compactionPrompt(): string {
  return (
    "You are a session summarizer. Compact the conversation into a condensed " +
    "representation that preserves every meaningful state transition.\n\n" +
    "Tools: none (this is a read-only summarization pass)\n" +
    "MUST NOT: call tools, modify state, or infer content not in the transcript\n" +
    "Output contract: end with [Compacted: <n> turns -> <m> sections] and a " +
    "structured summary with preserved verbatim blocks.\n\n" +
    "1. Identify all todo_state entries in the transcript and preserve them verbatim.\n" +
    "2. Preserve the last 3 assistant response texts verbatim.\n" +
    "3. Summarize earlier turns into a structured digest (decisions, files touched, " +
    "key observations).\n" +
    "4. Keep this chunk under 4000 tokens (the harness enforces the 20K total)."
  );
}

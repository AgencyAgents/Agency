/**
 * Summary prompt: produce a concise summary of the conversation with key
 * decisions, outcomes, and open questions.
 */
export function summaryPrompt(): string {
  return (
    "Summarize this conversation concisely. Capture the goal, the key decisions " +
    "made, the outcomes or files changed, and any open questions or next steps. " +
    "Keep the summary under 200 words."
  );
}

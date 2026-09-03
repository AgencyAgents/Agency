import { t } from "@agency/i18n";
import type { ToolSpec } from "../contract.ts";
import { str, summarize } from "../render.ts";

interface QuestionInput {
  question: string;
  choices?: string[];
}

/**
 * Poses a structured clarifying question: the result content carries the
 * question and choices for the TUI to render, and the model ends its turn so
 * the user's answer arrives as their next message. No approval-surface
 * involvement — the question is conversation, not a permission ask.
 */
export function createQuestionTool(): ToolSpec {
  const spec: ToolSpec<QuestionInput> = {
    name: "question",
    description:
      "Asks the user a structured clarifying question with optional choices. Use when the request is " +
      "ambiguous and the answer changes what you do. After calling this, END YOUR TURN — the user's " +
      "answer arrives as their next message.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question to ask." },
        choices: {
          type: "array",
          description: "Optional answer choices, rendered as a pick list.",
          items: { type: "string" },
        },
      },
      required: ["question"],
    },
    riskTier: "safe",
    renderCall: (input) => `question ${summarize(str(input.question))}`,
    renderResult: (result) =>
      result.isError ? `question failed: ${summarize(result.content)}` : summarize(result.content),

    async handler(input) {
      const question = str(input.question).trim();
      if (question.length === 0) {
        return { content: "question requires a non-empty question string", isError: true };
      }
      const choices = Array.isArray(input.choices)
        ? input.choices.filter((choice): choice is string => typeof choice === "string")
        : [];

      const structured: Record<string, unknown> = { type: "question", question };
      if (choices.length > 0) structured.choices = choices;

      const lines = [JSON.stringify(structured)];
      if (choices.length > 0) lines.push(...choices.map((choice, index) => `  ${index + 1}. ${choice}`));
      lines.push(t("tool.question.answer_next_message"));
      return { content: lines.join("\n") };
    },
  };
  return spec as unknown as ToolSpec;
}
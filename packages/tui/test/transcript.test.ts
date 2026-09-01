import { describe, expect, test } from "bun:test";
import { visibleWidth } from "../src/renderer.ts";
import { Transcript } from "../src/transcript.ts";

function plainTranscript(width = 80): Transcript {
  return new Transcript({ colorEnabled: false, width });
}

describe("Transcript text streaming", () => {
  test("text deltas accumulate into a single block", () => {
    const transcript = plainTranscript();
    transcript.consume({ type: "text_delta", text: "Hello " });
    transcript.consume({ type: "text_delta", text: "world." });
    const frame = transcript.frame();
    expect(frame).toEqual(["Hello world."]);
  });

  test("text and thinking deltas produce separate blocks in stream order", () => {
    const transcript = plainTranscript();
    transcript.consume({ type: "thinking_delta", text: "pondering" });
    transcript.consume({ type: "text_delta", text: "answer" });
    const frame = transcript.frame();
    expect(frame.length).toBe(2);
    expect(frame[1]).toBe("answer");
  });
});

describe("Transcript thinking collapse", () => {
  test("thinking blocks start collapsed and hide their raw text", () => {
    const transcript = plainTranscript();
    transcript.consume({ type: "thinking_delta", text: "secret reasoning steps" });
    const frame = transcript.frame();
    expect(frame.length).toBe(1);
    expect(frame[0]).toContain("collapsed");
    expect(frame[0]).toContain("22");
    expect(frame.join("\n")).not.toContain("secret reasoning");
  });

  test("expandThinking reveals the text, collapseThinking hides it again", () => {
    const transcript = plainTranscript();
    transcript.consume({ type: "thinking_delta", text: "visible now" });
    const id = transcript.thinkingIds()[0];
    transcript.expandThinking(id);
    expect(transcript.frame().join("\n")).toContain("visible now");
    transcript.collapseThinking(id);
    expect(transcript.frame().join("\n")).not.toContain("visible now");
  });

  test("toggleThinking flips the most recent block when no id is given", () => {
    const transcript = plainTranscript();
    transcript.consume({ type: "thinking_delta", text: "first" });
    transcript.consume({ type: "text_delta", text: "mid" });
    transcript.consume({ type: "thinking_delta", text: "second" });
    transcript.toggleThinking();
    const ids = transcript.thinkingIds();
    expect(transcript.isThinkingCollapsed(ids[0]!)).toBe(true);
    expect(transcript.isThinkingCollapsed(ids[1]!)).toBe(false);
  });
});

describe("Transcript tool rendering", () => {
  test("tool_start without a registered renderer falls back to a one-line summary", () => {
    const transcript = plainTranscript();
    transcript.consume({ type: "tool_start", id: "call_1", name: "mystery" });
    const frame = transcript.frame();
    expect(frame).toEqual(["> Tool: mystery"]);
  });

  test("renderCall and renderResult take over when the ToolSpec provides them", () => {
    const transcript = new Transcript({
      colorEnabled: false,
      width: 80,
      tools: [
        {
          name: "edit",
          renderCall: (input) => `Editing ${String(input.path)}`,
          renderResult: (result) => `${result.isError ? "Failed" : "Patched"} ${String(result.content)}`,
        },
      ],
    });
    transcript.consume({ type: "tool_start", id: "c1", name: "edit" }, { toolInput: { path: "a.ts" } });
    expect(transcript.frame()).toEqual(["> Editing a.ts"]);
    transcript.consume({ type: "tool_result", id: "c1", content: "a.ts", isError: false });
    expect(transcript.frame()).toEqual(["+ Patched a.ts"]);
  });

  test("a failed tool result renders with the error cue glyph", () => {
    const transcript = plainTranscript();
    transcript.consume({ type: "tool_start", id: "c2", name: "bash" });
    transcript.consume({ type: "tool_result", id: "c2", content: "boom", isError: true });
    const frame = transcript.frame();
    expect(frame.length).toBe(1);
    expect(frame[0]).toContain("x ");
    expect(frame[0]).toContain("bash failed");
  });

  test("tool_result for an unknown id is ignored without crashing", () => {
    const transcript = plainTranscript();
    transcript.consume({ type: "tool_result", id: "ghost", content: "x", isError: false });
    expect(transcript.frame()).toEqual([]);
  });
});

describe("Transcript turn status", () => {
  test("turn_complete renders stop reason and token total", () => {
    const transcript = plainTranscript();
    transcript.consume({
      type: "turn_complete",
      stopReason: "end_turn",
      usage: { inputTokens: 12, outputTokens: 8 },
    });
    const frame = transcript.frame();
    expect(frame.length).toBe(1);
    expect(frame[0]).toContain("end_turn");
    expect(frame[0]).toContain("20 tokens");
    expect(frame[0]!.startsWith("+ ")).toBe(true);
  });

  test("budget_exceeded renders a warning line with spend", () => {
    const transcript = plainTranscript();
    transcript.consume({ type: "budget_exceeded", spentTokens: 5000, spentCostUsd: 0.42 });
    const frame = transcript.frame();
    expect(frame.length).toBe(1);
    expect(frame[0]!.startsWith("! ")).toBe(true);
    expect(frame[0]).toContain("5000");
    expect(frame[0]).toContain("0.42");
  });
});

describe("Transcript degradation", () => {
  test("frames reflow to the configured width before styling", () => {
    const transcript = plainTranscript(20);
    transcript.consume({ type: "text_delta", text: "the quick brown fox jumps over the lazy dog" });
    for (const line of transcript.frame()) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(20);
    }
  });

  test("screen-reader mode swaps glyphs and color for spoken cue words", () => {
    const transcript = new Transcript({ mode: "screen-reader", colorEnabled: false, width: 80 });
    transcript.consume({ type: "tool_start", id: "c3", name: "bash" });
    transcript.consume({ type: "tool_result", id: "c3", content: "ok", isError: false });
    transcript.consume({
      type: "turn_complete",
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const frame = transcript.frame();
    expect(frame[0]).toBe("ok Tool bash finished");
    expect(frame[1]).toBe("ok Turn complete (end_turn, 2 tokens)");
    expect(frame.join("\n")).not.toContain("\x1b[");
  });

  test("color-enabled tty frames carry ANSI around styled text", () => {
    const transcript = new Transcript({ mode: "tty", colorEnabled: true, width: 80 });
    transcript.consume({ type: "tool_start", id: "c4", name: "bash" });
    const frame = transcript.frame();
    expect(frame[0]).toContain("\x1b[36m");
    expect(frame[0]).toContain("\x1b[0m");
    expect(frame[0]!.startsWith("> ")).toBe(true);
  });
});

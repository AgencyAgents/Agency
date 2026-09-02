import { describe, expect, test } from "bun:test";
import { visibleWidth } from "../src/renderer.ts";
import { consumeRpcEvent, eventContextOf, toolPresentations, Transcript } from "../src/transcript.ts";

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

  test("tool_start input from the event itself drives renderCall without a context", () => {
    const transcript = new Transcript({
      colorEnabled: false,
      width: 80,
      tools: [{ name: "edit", renderCall: (input) => `Editing ${String(input.path)}` }],
    });
    transcript.consume({ type: "tool_start", id: "c1", name: "edit", input: { path: "wire.ts" } });
    expect(transcript.frame()).toEqual(["> Editing wire.ts"]);
  });

  test("an explicit context toolInput wins over the event's own input", () => {
    const transcript = new Transcript({
      colorEnabled: false,
      width: 80,
      tools: [{ name: "edit", renderCall: (input) => `Editing ${String(input.path)}` }],
    });
    transcript.consume(
      { type: "tool_start", id: "c1", name: "edit", input: { path: "wire.ts" } },
      { toolInput: { path: "context.ts" } },
    );
    expect(transcript.frame()).toEqual(["> Editing context.ts"]);
  });

  test("renderResult receives the call input captured from the event", () => {
    const transcript = new Transcript({
      colorEnabled: false,
      width: 80,
      tools: [
        {
          name: "read",
          renderResult: (result) => `read ${String(result.input?.path)}: ${result.content}`,
        },
      ],
    });
    transcript.consume({ type: "tool_start", id: "c1", name: "read", input: { path: "a.ts" } });
    transcript.consume({ type: "tool_result", id: "c1", content: "3 lines", isError: false });
    expect(transcript.frame()).toEqual(["+ read a.ts: 3 lines"]);
  });

  test("a tool_result context fills the input when tool_start carried none", () => {
    const transcript = new Transcript({
      colorEnabled: false,
      width: 80,
      tools: [
        {
          name: "read",
          renderResult: (result) => `read ${String(result.input?.path)}: ${result.content}`,
        },
      ],
    });
    transcript.consume({ type: "tool_start", id: "c1", name: "read" });
    transcript.consume(
      { type: "tool_result", id: "c1", content: "ok", isError: false },
      { toolInput: { path: "late.ts" } },
    );
    expect(transcript.frame()).toEqual(["+ read late.ts: ok"]);
  });
});

describe("Transcript RPC bridge", () => {
  test("eventContextOf extracts toolInput from tool_start payloads", () => {
    expect(eventContextOf({ type: "tool_start", id: "c1", name: "bash", input: { command: "ls" } })).toEqual({
      toolInput: { command: "ls" },
    });
    expect(eventContextOf({ type: "tool_start", id: "c1", name: "bash" })).toBeUndefined();
    expect(eventContextOf({ type: "text_delta", text: "x" })).toBeUndefined();
  });

  test("consumeRpcEvent renders built-in calls from wire events with no explicit context", () => {
    const transcript = new Transcript({
      colorEnabled: false,
      width: 80,
      tools: [{ name: "bash", renderCall: (input) => `bash ${String(input.command)}` }],
    });
    consumeRpcEvent(transcript, {
      type: "tool_start",
      id: "c1",
      name: "bash",
      input: { command: "bun test" },
    });
    expect(transcript.frame()).toEqual(["> bash bun test"]);
  });

  test("toolPresentations adapts tool specs to the structural subset", () => {
    const specs = [
      {
        name: "bash",
        renderCall: (input: { command: string }) => `bash ${input.command}`,
        renderResult: (result: { content: string }) => result.content,
      },
      { name: "plain" },
    ];
    const presentations = toolPresentations(specs);
    expect(presentations.map((p) => p.name)).toEqual(["bash", "plain"]);
    const transcript = new Transcript({ colorEnabled: false, tools: presentations });
    transcript.consume({ type: "tool_start", id: "c1", name: "bash", input: { command: "ls" } });
    expect(transcript.frame()).toEqual(["> bash ls"]);
  });
});

describe("Transcript incremental frames and scrollback cap", () => {
  test("incremental caching renders identically to a fresh full replay", () => {
    const events: Parameters<Transcript["consume"]>[0][] = [
      { type: "thinking_delta", text: "pondering " },
      { type: "thinking_delta", text: "deeply" },
      { type: "text_delta", text: "Answer part one. " },
      { type: "tool_start", id: "t1", name: "bash", input: { command: "ls" } },
      { type: "tool_result", id: "t1", content: "a.ts\nb.ts", isError: false },
      { type: "text_delta", text: "part two" },
      { type: "thinking_delta", text: "more" },
      { type: "retry", attempt: 2, message: "rate limited" },
      { type: "text_delta", text: "final" },
    ];
    const warmed = plainTranscript(40);
    for (const event of events) warmed.consume(event);
    warmed.toggleThinking();
    warmed.frame();

    const fresh = plainTranscript(40);
    for (const event of events) fresh.consume(event);
    fresh.toggleThinking();

    expect(warmed.frame()).toEqual(fresh.frame());
  });

  test("frames reflect mutations after being built once (cache invalidation)", () => {
    const transcript = plainTranscript();
    transcript.consume({ type: "text_delta", text: "before" });
    expect(transcript.frame()).toEqual(["before"]);
    transcript.consume({ type: "text_delta", text: " and after" });
    expect(transcript.frame()[0]).toBe("before and after");
    transcript.consume({ type: "thinking_delta", text: "hidden" });
    expect(transcript.frame().length).toBe(2);
    const id = transcript.thinkingIds()[0]!;
    transcript.expandThinking(id);
    expect(transcript.frame().join("\n")).toContain("hidden");
  });

  test("scrollback cap drops the oldest blocks beyond maxBlocks", () => {
    const transcript = plainTranscript();
    for (let i = 0; i < 1005; i++) {
      transcript.consume({ type: "tool_start", id: `call_${i}`, name: `tool${i}` });
    }
    const frame = transcript.frame();
    expect(frame.length).toBe(1000);
    expect(frame[0]).toContain("tool5");
    expect(frame[999]).toContain("tool1004");
  });

  test("a tool_result for a dropped (scrolled-out) block is ignored without crashing", () => {
    const transcript = new Transcript({ colorEnabled: false, width: 80, maxBlocks: 10 });
    transcript.consume({ type: "tool_start", id: "first", name: "bash" });
    for (let i = 0; i < 15; i++) {
      transcript.consume({ type: "tool_start", id: `later_${i}`, name: `tool${i}` });
    }
    transcript.consume({ type: "tool_result", id: "first", content: "boom", isError: true });
    const frame = transcript.frame();
    expect(frame.length).toBe(10);
    expect(frame[0]).toContain("tool5");
    expect(frame[0]).not.toContain("Tool: bash");
  });

  test("a single streaming block is capped, so frames stay bounded", () => {
    const transcript = plainTranscript(80);
    transcript.consume({ type: "text_delta", text: "a".repeat(250_000) });
    const frame = transcript.frame();
    const total = frame.join("").length;
    expect(frame.length).toBeGreaterThan(0);
    expect(total).toBeLessThan(110_000);
    for (const line of frame) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(80);
    }
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

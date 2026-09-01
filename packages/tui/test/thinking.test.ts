import { describe, expect, test } from "bun:test";
import { THINKING_COMMAND_NAMES, ThinkingController } from "../src/thinking.ts";
import { Transcript } from "../src/transcript.ts";

function transcriptWithThinking(): { transcript: Transcript; ids: string[] } {
  const transcript = new Transcript({ colorEnabled: false, width: 80 });
  transcript.consume({ type: "thinking_delta", text: "first block" });
  transcript.consume({ type: "text_delta", text: "answer" });
  transcript.consume({ type: "thinking_delta", text: "second block" });
  return { transcript, ids: transcript.thinkingIds() };
}

describe("ThinkingController", () => {
  test("exposes exactly the five named commands for keybind wiring", () => {
    const controller = new ThinkingController(new Transcript());
    const names = Object.keys(controller.commands()).sort();
    expect(names).toEqual([...THINKING_COMMAND_NAMES].sort());
    expect(names).toEqual([
      "thinking.collapse",
      "thinking.collapseAll",
      "thinking.expand",
      "thinking.expandAll",
      "thinking.toggle",
    ]);
  });

  test("thinking.toggle flips the most recent block by default", () => {
    const { transcript, ids } = transcriptWithThinking();
    const controller = new ThinkingController(transcript);
    controller.execute("thinking.toggle");
    expect(transcript.isThinkingCollapsed(ids[1]!)).toBe(false);
    expect(transcript.isThinkingCollapsed(ids[0]!)).toBe(true);
    controller.execute("thinking.toggle");
    expect(transcript.isThinkingCollapsed(ids[1]!)).toBe(true);
  });

  test("thinking.toggle with an id targets that block only", () => {
    const { transcript, ids } = transcriptWithThinking();
    const controller = new ThinkingController(transcript);
    controller.execute("thinking.toggle", { id: ids[0]! });
    expect(transcript.isThinkingCollapsed(ids[0]!)).toBe(false);
    expect(transcript.isThinkingCollapsed(ids[1]!)).toBe(true);
  });

  test("thinking.expand and thinking.collapse set explicit states", () => {
    const { transcript, ids } = transcriptWithThinking();
    const controller = new ThinkingController(transcript);
    controller.execute("thinking.expand", { id: ids[0]! });
    expect(transcript.isThinkingCollapsed(ids[0]!)).toBe(false);
    controller.execute("thinking.collapse", { id: ids[0]! });
    expect(transcript.isThinkingCollapsed(ids[0]!)).toBe(true);
  });

  test("thinking.expandAll and thinking.collapseAll hit every block", () => {
    const { transcript, ids } = transcriptWithThinking();
    const controller = new ThinkingController(transcript);
    controller.execute("thinking.expandAll");
    expect(ids.every((id) => !transcript.isThinkingCollapsed(id))).toBe(true);
    controller.execute("thinking.collapseAll");
    expect(ids.every((id) => transcript.isThinkingCollapsed(id))).toBe(true);
  });

  test("expanded thinking changes the frame, collapsed hides raw text", () => {
    const { transcript } = transcriptWithThinking();
    const controller = new ThinkingController(transcript);
    const collapsedFrame = transcript.frame().join("\n");
    expect(collapsedFrame).not.toContain("first block");
    controller.execute("thinking.expandAll");
    const expandedFrame = transcript.frame().join("\n");
    expect(expandedFrame).toContain("first block");
    expect(expandedFrame).toContain("second block");
    expect(expandedFrame.split("\n").length).toBeGreaterThan(collapsedFrame.split("\n").length);
    controller.execute("thinking.collapseAll");
    expect(transcript.frame().join("\n")).not.toContain("first block");
  });

  test("commands on a transcript without thinking blocks are safe no-ops", () => {
    const transcript = new Transcript({ colorEnabled: false, width: 80 });
    const controller = new ThinkingController(transcript);
    for (const name of THINKING_COMMAND_NAMES) {
      controller.execute(name);
    }
    expect(transcript.frame()).toEqual([]);
  });
});

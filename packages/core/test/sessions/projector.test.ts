import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@agency/schema";
import { type SessionEvent, SessionProjector } from "../../src/sessions/projector.ts";
import { SessionStore } from "../../src/sessions/store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "agency-projector-"));
  dirs.push(dir);
  return { store: new SessionStore(dir), dir };
}

function userMsg(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistantMsg(
  text: string,
  toolCalls?: Array<{ name: string; input: Record<string, unknown> }>,
): Message {
  const content: Message["content"] = [{ type: "text", text }];
  if (toolCalls) {
    for (const tc of toolCalls) {
      content.push({ type: "tool_call", id: `tc-${tc.name}`, name: tc.name, input: tc.input });
    }
  }
  return { role: "assistant", content };
}

/** Filter events to only the types relevant to the test, for concise assertions. */
function byType<T extends SessionEvent["type"]>(
  events: SessionEvent[],
  ...types: T[]
): Extract<SessionEvent, { type: T }>[] {
  const set = new Set<string>(types);
  return events.filter((e): e is Extract<SessionEvent, { type: T }> => set.has(e.type));
}

describe("SessionProjector", () => {
  test("projects Created and Updated for a basic session", async () => {
    const { store } = setup();
    const meta = store.create("s1");
    const e1 = await store.append(meta.id, { type: "message", parentId: null, message: userMsg("hi") });
    const e2 = await store.append(meta.id, { type: "message", parentId: e1.id, message: userMsg("again") });

    const projector = new SessionProjector(store);
    const events = projector.project(meta.id);

    // First entry → Created + Updated; second entry → Updated
    const created = byType(events, "Created");
    expect(created).toHaveLength(1);
    expect(created[0]?.entry?.id).toBe(e1.id);

    const updated = byType(events, "Updated");
    expect(updated).toHaveLength(2);
    expect(updated[0]?.entry?.id).toBe(e1.id);
    expect(updated[1]?.entry?.id).toBe(e2.id);
  });

  test("projects StepStarted, Success, Ended from agent_lifecycle entries", async () => {
    const { store } = setup();
    const meta = store.create("s1");
    const msg = await store.append(meta.id, { type: "message", parentId: null, message: userMsg("do it") });
    const working = await store.append(meta.id, {
      type: "agent_lifecycle",
      parentId: msg.id,
      handle: "coder",
      state: "working",
    });
    const completed = await store.append(meta.id, {
      type: "agent_lifecycle",
      parentId: working.id,
      handle: "coder",
      state: "completed",
    });

    const projector = new SessionProjector(store);
    const events = projector.project(meta.id);

    const stepStarted = byType(events, "StepStarted");
    expect(stepStarted).toHaveLength(1);
    expect(stepStarted[0]?.stepId).toBe(working.id);
    expect(stepStarted[0]?.detail).toBeUndefined();

    const success = byType(events, "Success");
    expect(success).toHaveLength(1);
    expect(success[0]?.stepId).toBe(completed.id);

    const ended = byType(events, "Ended");
    expect(ended).toHaveLength(1);
    expect(ended[0]?.stepId).toBe(completed.id);
  });

  test("projects Failed and Ended from agent_lifecycle failed state", async () => {
    const { store } = setup();
    const meta = store.create("s1");
    const msg = await store.append(meta.id, { type: "message", parentId: null, message: userMsg("do it") });
    const working = await store.append(meta.id, {
      type: "agent_lifecycle",
      parentId: msg.id,
      handle: "coder",
      state: "working",
    });
    const failed = await store.append(meta.id, {
      type: "agent_lifecycle",
      parentId: working.id,
      handle: "coder",
      state: "failed",
      detail: "timeout",
    });

    const projector = new SessionProjector(store);
    const events = projector.project(meta.id);

    const failedEvents = byType(events, "Failed");
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]?.stepId).toBe(failed.id);
    expect(failedEvents[0]?.error).toBe("timeout");

    const ended = byType(events, "Ended");
    expect(ended).toHaveLength(1);
    expect(ended[0]?.stepId).toBe(failed.id);
  });

  test("projects Ended from agent_lifecycle idle state", async () => {
    const { store } = setup();
    const meta = store.create("s1");
    const msg = await store.append(meta.id, { type: "message", parentId: null, message: userMsg("do it") });
    const working = await store.append(meta.id, {
      type: "agent_lifecycle",
      parentId: msg.id,
      handle: "coder",
      state: "working",
    });
    const idle = await store.append(meta.id, {
      type: "agent_lifecycle",
      parentId: working.id,
      handle: "coder",
      state: "idle",
    });

    const projector = new SessionProjector(store);
    const events = projector.project(meta.id);

    const ended = byType(events, "Ended");
    expect(ended).toHaveLength(1);
    expect(ended[0]?.stepId).toBe(idle.id);
  });

  test("projects ToolCalled from message entries with tool_call blocks", async () => {
    const { store } = setup();
    const meta = store.create("s1");
    await store.append(meta.id, {
      type: "message",
      parentId: null,
      message: assistantMsg("let me check", [
        { name: "read_file", input: { path: "/foo.txt" } },
        { name: "search_code", input: { pattern: "test" } },
      ]),
    });

    const projector = new SessionProjector(store);
    const events = projector.project(meta.id);

    const toolCalled = byType(events, "ToolCalled");
    expect(toolCalled).toHaveLength(2);
    expect(toolCalled[0]?.toolName).toBe("read_file");
    expect(toolCalled[0]?.toolInput).toEqual({ path: "/foo.txt" });
    expect(toolCalled[1]?.toolName).toBe("search_code");
    expect(toolCalled[1]?.toolInput).toEqual({ pattern: "test" });
  });

  test("projects chainFor a specific tip", async () => {
    const { store } = setup();
    const meta = store.create("s1");
    const root = await store.append(meta.id, { type: "message", parentId: null, message: userMsg("root") });
    const branchA = await store.append(meta.id, {
      type: "message",
      parentId: root.id,
      message: userMsg("branch a"),
    });
    await store.append(meta.id, { type: "message", parentId: root.id, message: userMsg("branch b") });

    const projector = new SessionProjector(store);
    const events = projector.projectChain(meta.id, branchA.id);

    // Only root + branchA in the chain
    const updated = byType(events, "Updated");
    expect(updated).toHaveLength(2);
    expect(updated[0]?.entry?.id).toBe(root.id);
    expect(updated[1]?.entry?.id).toBe(branchA.id);
  });

  test("returns empty array for a session with no entries", async () => {
    const { store } = setup();
    const meta = store.create("s1");

    const projector = new SessionProjector(store);
    const events = projector.project(meta.id);

    expect(events).toEqual([]);
  });

  test("returns Deleted event for a session that does not exist", async () => {
    const { store } = setup();
    const projector = new SessionProjector(store);
    const events = projector.project("nonexistent");

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("Deleted");
  });

  test("projects StepStarted with detail when agent_lifecycle has detail", async () => {
    const { store } = setup();
    const meta = store.create("s1");
    const msg = await store.append(meta.id, { type: "message", parentId: null, message: userMsg("debug") });
    const working = await store.append(meta.id, {
      type: "agent_lifecycle",
      parentId: msg.id,
      handle: "debugger",
      state: "working",
      detail: "investigating crash",
    });

    const projector = new SessionProjector(store);
    const events = projector.project(meta.id);

    const stepStarted = byType(events, "StepStarted");
    expect(stepStarted).toHaveLength(1);
    expect(stepStarted[0]?.stepId).toBe(working.id);
    expect(stepStarted[0]?.detail).toBe("investigating crash");
  });

  test("events are in chronological order matching entry order", async () => {
    const { store } = setup();
    const meta = store.create("s1");
    const e1 = await store.append(meta.id, { type: "message", parentId: null, message: userMsg("first") });
    const e2 = await store.append(meta.id, {
      type: "agent_lifecycle",
      parentId: e1.id,
      handle: "agent",
      state: "working",
    });
    await store.append(meta.id, {
      type: "agent_lifecycle",
      parentId: e2.id,
      handle: "agent",
      state: "completed",
    });

    const projector = new SessionProjector(store);
    const events = projector.project(meta.id);

    // All events should be in chronological order
    expect(events.map((e) => e.type)).toEqual([
      "Created",
      "Updated",
      "Updated",
      "StepStarted",
      "Updated",
      "Success",
      "Ended",
    ]);
  });

  test("projectChain returns empty for unknown tipId", async () => {
    const { store } = setup();
    const meta = store.create("s1");
    await store.append(meta.id, { type: "message", parentId: null, message: userMsg("hi") });

    const projector = new SessionProjector(store);
    const events = projector.projectChain(meta.id, "nonexistent-tip");

    expect(events).toEqual([]);
  });
});

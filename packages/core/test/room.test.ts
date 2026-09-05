import { describe, expect, it } from "bun:test";
import { AgencyError, type Message } from "@agency/schema";
import { AgentRegistry } from "../src/orchestra/registry.ts";
import { RoomStore } from "../src/orchestra/room.ts";

const msg = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] });

function handle(name: string, sessionId: string) {
  return { handle: name, role: "member", provider: "p", model: "m", effort: "low", sessionId, mailbox: [] };
}

function registryWith(names: string[]): AgentRegistry {
  const r = new AgentRegistry();
  for (const n of names) r.register(handle(n, `s-${n}`));
  return r;
}

describe("orchestra room", () => {
  it("create seeds leader as member with goal and timestamp", () => {
    const rooms = new RoomStore();
    const room = rooms.create("ship feature x", "lead");
    expect(room.goal).toBe("ship feature x");
    expect(room.leaderHandle).toBe("lead");
    expect(room.memberHandles).toEqual(["lead"]);
    expect(room.createdAt.length).toBeGreaterThan(0);
    expect(rooms.get(room.id)?.goal).toBe("ship feature x");
    expect(rooms.list().length).toBe(1);
  });

  it("create rejects empty goal/leader and duplicate ids", () => {
    const rooms = new RoomStore();
    expect(() => rooms.create("", "lead")).toThrow(AgencyError);
    expect(() => rooms.create("goal", "")).toThrow(AgencyError);
    rooms.create("goal", "lead", { id: "room-1" });
    expect(() => rooms.create("other", "lead", { id: "room-1" })).toThrow(AgencyError);
  });

  it("addMember/removeMember manage the roster; leader is protected", () => {
    const rooms = new RoomStore();
    const room = rooms.create("goal", "lead");
    expect(rooms.addMember(room.id, "dev-a")).toEqual({ ok: true });
    expect(rooms.addMember(room.id, "dev-a").ok).toBe(false);
    expect(rooms.addMember("nope", "x").ok).toBe(false);
    expect(rooms.removeMember(room.id, "lead").ok).toBe(false);
    expect(rooms.removeMember(room.id, "ghost").ok).toBe(false);
    expect(rooms.removeMember(room.id, "dev-a")).toEqual({ ok: true });
    expect(rooms.get(room.id)?.memberHandles).toEqual(["lead"]);
  });

  it("shared todos: append/claim/release with cross-member exclusion", () => {
    const rooms = new RoomStore();
    const room = rooms.create("goal", "lead", { memberHandles: ["dev-a", "dev-b"] });
    const todo = rooms.appendTodo(room.id, "implement x");
    expect(todo.status).toBe("pending");
    expect(rooms.listTodos(room.id).length).toBe(1);
    expect(rooms.claimTodo(room.id, "dev-a", todo.id)).toEqual({ ok: true });
    expect(rooms.claimTodo(room.id, "dev-b", todo.id).ok).toBe(false);
    expect(rooms.releaseTodo(room.id, "dev-b", todo.id).ok).toBe(false);
    expect(rooms.releaseTodo(room.id, "dev-a", todo.id)).toEqual({ ok: true });
    expect(rooms.claimTodo("nope", "dev-a", todo.id).ok).toBe(false);
    expect(rooms.get(room.id)?.sharedTodos.length).toBe(1);
  });

  it("appendMessage broadcasts to room members only (isolation across rooms)", () => {
    const registry = registryWith(["lead", "dev-a", "outsider"]);
    const rooms = new RoomStore(registry);
    const a = rooms.create("goal a", "lead", { id: "a", memberHandles: ["dev-a"] });
    rooms.create("goal b", "outsider", { id: "b" });
    const delivered = rooms.appendMessage(a.id, msg("hello room a"));
    expect(delivered).toBe(2);
    expect(registry.peek("lead").length).toBe(1);
    expect(registry.peek("dev-a").length).toBe(1);
    expect(registry.peek("outsider")).toEqual([]);
    expect(rooms.appendMessage(a.id, msg("skip me"), { exclude: ["dev-a"] })).toBe(1);
    expect(registry.drain("lead").length).toBe(2);
    expect(() => rooms.appendMessage("nope", msg("x"))).toThrow(AgencyError);
  });
});

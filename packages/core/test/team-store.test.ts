import { describe, expect, it } from "bun:test";
import { AgencyError, type Message } from "@agency/schema";
import { AgentRegistry } from "../src/team/registry.ts";
import { TeamStore } from "../src/team/team-store.ts";

const msg = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] });

function handle(name: string, sessionId: string) {
  return { handle: name, role: "member", provider: "p", model: "m", effort: "low", sessionId, mailbox: [] };
}

function registryWith(names: string[]): AgentRegistry {
  const r = new AgentRegistry();
  for (const n of names) r.register(handle(n, `s-${n}`));
  return r;
}

describe("team store", () => {
  it("create seeds leader as member with goal and timestamp", () => {
    const teams = new TeamStore();
    const team = teams.create("ship feature x", "lead");
    expect(team.goal).toBe("ship feature x");
    expect(team.leaderHandle).toBe("lead");
    expect(team.memberHandles).toEqual(["lead"]);
    expect(team.createdAt.length).toBeGreaterThan(0);
    expect(teams.get(team.id)?.goal).toBe("ship feature x");
    expect(teams.list().length).toBe(1);
  });

  it("create rejects empty goal/leader and duplicate ids", () => {
    const teams = new TeamStore();
    expect(() => teams.create("", "lead")).toThrow(AgencyError);
    expect(() => teams.create("goal", "")).toThrow(AgencyError);
    teams.create("goal", "lead", { id: "team-1" });
    expect(() => teams.create("other", "lead", { id: "team-1" })).toThrow(AgencyError);
  });

  it("addMember/removeMember manage the roster; leader is protected", () => {
    const teams = new TeamStore();
    const team = teams.create("goal", "lead");
    expect(teams.addMember(team.id, "dev-a")).toEqual({ ok: true });
    expect(teams.addMember(team.id, "dev-a").ok).toBe(false);
    expect(teams.addMember("nope", "x").ok).toBe(false);
    expect(teams.removeMember(team.id, "lead").ok).toBe(false);
    expect(teams.removeMember(team.id, "ghost").ok).toBe(false);
    expect(teams.removeMember(team.id, "dev-a")).toEqual({ ok: true });
    expect(teams.get(team.id)?.memberHandles).toEqual(["lead"]);
  });

  it("shared todos: append/claim/release with cross-member exclusion", () => {
    const teams = new TeamStore();
    const team = teams.create("goal", "lead", { memberHandles: ["dev-a", "dev-b"] });
    const todo = teams.appendTodo(team.id, "implement x");
    expect(todo.status).toBe("pending");
    expect(teams.listTodos(team.id).length).toBe(1);
    expect(teams.claimTodo(team.id, "dev-a", todo.id)).toEqual({ ok: true });
    expect(teams.claimTodo(team.id, "dev-b", todo.id).ok).toBe(false);
    expect(teams.releaseTodo(team.id, "dev-b", todo.id).ok).toBe(false);
    expect(teams.releaseTodo(team.id, "dev-a", todo.id)).toEqual({ ok: true });
    expect(teams.claimTodo("nope", "dev-a", todo.id).ok).toBe(false);
    expect(teams.get(team.id)?.sharedTodos.length).toBe(1);
  });

  it("appendMessage broadcasts to team members only (isolation across teams)", () => {
    const registry = registryWith(["lead", "dev-a", "outsider"]);
    const teams = new TeamStore(registry);
    const a = teams.create("goal a", "lead", { id: "a", memberHandles: ["dev-a"] });
    teams.create("goal b", "outsider", { id: "b" });
    const delivered = teams.appendMessage(a.id, msg("hello team a"));
    expect(delivered).toBe(2);
    expect(registry.peek("lead").length).toBe(1);
    expect(registry.peek("dev-a").length).toBe(1);
    expect(registry.peek("outsider")).toEqual([]);
    expect(teams.appendMessage(a.id, msg("skip me"), { exclude: ["dev-a"] })).toBe(1);
    expect(registry.drain("lead").length).toBe(2);
    expect(() => teams.appendMessage("nope", msg("x"))).toThrow(AgencyError);
  });
});

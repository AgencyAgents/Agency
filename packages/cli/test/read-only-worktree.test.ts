import { describe, expect, it } from "bun:test";
import { PermissionsGate, type ToolPermissionValue } from "@agency/guard";

describe("read-only agent detection via PermissionsGate", () => {
  function isReadOnlyAgent(permissions: Record<string, ToolPermissionValue>): boolean {
    const gate = new PermissionsGate({
      permissions,
      workspaceRoot: "/repo",
      absentToolsDenied: true,
    });
    const bashOffered = gate.toolOffered("bash", "dangerous");
    const writeOffered = gate.toolOffered("write", "moderate");
    const editOffered = gate.toolOffered("edit", "moderate");
    return bashOffered && !writeOffered && !editOffered;
  }

  it("code-reviewer permissions are detected as read-only", () => {
    const perms: Record<string, ToolPermissionValue> = {
      read: "allow",
      glob: "allow",
      grep: "allow",
      bash: "allow",
      write: "deny",
      edit: "deny",
      fetch: "deny",
      websearch: "deny",
    };
    expect(isReadOnlyAgent(perms)).toBe(true);
  });

  it("coder permissions are NOT read-only (has write+edit)", () => {
    const perms: Record<string, ToolPermissionValue> = {
      read: "allow",
      write: "allow",
      edit: "allow",
      bash: "allow",
      glob: "allow",
      grep: "allow",
    };
    expect(isReadOnlyAgent(perms)).toBe(false);
  });

  it("executor permissions are NOT read-only (has bash but no write/edit — but executor has no bash)", () => {
    // executor has bash: "allow" but write: "deny", edit: "deny" — this IS read-only
    const perms: Record<string, ToolPermissionValue> = {
      bash: "allow",
      read: "allow",
      glob: "allow",
      grep: "allow",
      write: "deny",
      edit: "deny",
    };
    expect(isReadOnlyAgent(perms)).toBe(true);
  });

  it("agent with bash denied is not read-only", () => {
    const perms: Record<string, ToolPermissionValue> = {
      read: "allow",
      bash: "deny",
      write: "deny",
      edit: "deny",
    };
    expect(isReadOnlyAgent(perms)).toBe(false);
  });

  it("agent with no permissions at all is not read-only (bash not offered)", () => {
    const gate = new PermissionsGate({
      permissions: {},
      workspaceRoot: "/repo",
      absentToolsDenied: true,
    });
    const bashOffered = gate.toolOffered("bash", "dangerous");
    const writeOffered = gate.toolOffered("write", "moderate");
    const editOffered = gate.toolOffered("edit", "moderate");
    expect(bashOffered).toBe(false);
    expect(writeOffered).toBe(false);
    expect(editOffered).toBe(false);
  });
});

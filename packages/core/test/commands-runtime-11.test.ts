import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandCommand } from "../src/commands/loader.ts";
import {
  BUILTIN_COMMANDS,
  expandAtFiles,
  extractShellBlocks,
  isBuiltinCommand,
  parseCommandFile,
  renderCommandHelp,
  resolveCommand,
  runShellBlocks,
  substituteArgs,
  unknownCommandMessage,
} from "../src/commands/runtime.ts";

function tempRoot(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("command file frontmatter", () => {
  test("description comes from frontmatter", () => {
    const parsed = parseCommandFile("---\ndescription: Deploy helper\n---\nRun $1");
    expect(parsed.description).toBe("Deploy helper");
    expect(parsed.body).toContain("Run $1");
    expect(parsed.body).not.toContain("description");
  });

  test("no frontmatter keeps the full body", () => {
    const parsed = parseCommandFile("# Title\nBody $ARGUMENTS");
    expect(parsed.description).toBeUndefined();
    expect(parsed.body).toBe("# Title\nBody $ARGUMENTS");
  });

  test("expandCommand strips frontmatter before substitution", () => {
    const out = expandCommand("---\ndescription: D\n---\nRun $1", "svc", undefined);
    expect(out).toBe("Run svc");
  });
});

describe("positional arg substitution", () => {
  test("$1..$9 fill in order, missing slots go empty", () => {
    expect(substituteArgs("$1 $2 $3", "a b")).toBe("a b ");
  });

  test("$ARGUMENTS still fills the whole string", () => {
    expect(substituteArgs("all: $ARGUMENTS", "x y")).toBe("all: x y");
  });

  test("expandCommand wires $N through the pipeline", () => {
    expect(expandCommand("deploy $1 to $2", "svc prod")).toBe("deploy svc to prod");
  });
});

describe("shell blocks", () => {
  test("extractShellBlocks lists blocks in order", () => {
    expect(extractShellBlocks("a !`echo hi` b !`echo yo`")).toEqual(["echo hi", "echo yo"]);
  });

  test("runShellBlocks inlines stdout", () => {
    expect(runShellBlocks("v: !`echo hello`", { cwd: tmpdir() })).toBe("v: hello");
  });

  test("failing shell degrades to a marker", () => {
    const out = runShellBlocks("v: !`exit-99-no-such-cmd`", { cwd: tmpdir() });
    expect(out).toContain("[[shell failed:");
  });

  test("expandCommand leaves shell blocks alone without opt-in", () => {
    const out = expandCommand("v: !`echo hello`", "", tmpdir());
    expect(out).toContain("!`echo hello`");
  });

  test("expandCommand runs shell blocks with opt-in", () => {
    const out = expandCommand("v: !`echo hello`", "", tmpdir(), { shell: true });
    expect(out).toBe("v: hello");
  });
});

describe("@file inlining", () => {
  test("existing in-workspace file inlines", () => {
    const dir = tempRoot("agency-atfile");
    try {
      writeFileSync(join(dir, "ctx.txt"), "CTX");
      expect(expandAtFiles("see @ctx.txt now", { workspaceRoot: dir })).toBe("see CTX now");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("prose mentions pass through untouched", () => {
    const dir = tempRoot("agency-atprose");
    try {
      expect(expandAtFiles("ask @lead about it", { workspaceRoot: dir })).toBe("ask @lead about it");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("traversal outside the workspace passes through", () => {
    const dir = tempRoot("agency-attrav");
    try {
      expect(expandAtFiles("see @../outside.txt", { workspaceRoot: dir })).toBe("see @../outside.txt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("command resolution", () => {
  test("33 built-ins across three tiers", () => {
    expect(BUILTIN_COMMANDS).toHaveLength(33);
    expect(BUILTIN_COMMANDS.filter((c) => c.tier === 1)).toHaveLength(9);
    expect(BUILTIN_COMMANDS.filter((c) => c.tier === 2)).toHaveLength(13);
    expect(BUILTIN_COMMANDS.filter((c) => c.tier === 3)).toHaveLength(11);
    expect(isBuiltinCommand("sessions")).toBe(true);
    expect(isBuiltinCommand("nope")).toBe(false);
  });

  test("builtin beats project file, project beats user, user beats plugin", () => {
    const templates = [
      { name: "help", content: "x", path: "p", source: "project" as const },
      { name: "deploy", content: "p", path: "p", source: "project" as const },
      { name: "deploy2", content: "u", path: "u", source: "user" as const },
    ];
    const pluginCommands = [{ pluginId: "pl", command: { name: "ship", template: "go" } }];
    expect(resolveCommand("help", { templates, pluginCommands }).kind).toBe("builtin");
    expect(resolveCommand("deploy", { templates, pluginCommands })).toMatchObject({ kind: "template" });
    const userOnly = resolveCommand("deploy2", { templates, pluginCommands });
    expect(userOnly.kind).toBe("template");
    if (userOnly.kind === "template") expect(userOnly.template.source).toBe("user");
    const both = resolveCommand("deploy", {
      templates: [...templates, { name: "deploy", content: "u", path: "u", source: "user" as const }],
      pluginCommands,
    });
    if (both.kind === "template") expect(both.template.source).toBe("project");
    const plug = resolveCommand("ship", { templates, pluginCommands });
    expect(plug).toMatchObject({ kind: "plugin", pluginId: "pl" });
    expect(resolveCommand("missing", { templates, pluginCommands })).toEqual({
      kind: "unknown",
      name: "missing",
    });
  });

  test("unknown names fail with a typed message", () => {
    expect(unknownCommandMessage("nope")).toBe("unknown command: nope");
  });

  test("help renders all three tiers plus files and plugins", () => {
    const text = renderCommandHelp({
      templates: [{ name: "deploy", content: "x", path: "p", source: "project" as const }],
      pluginCommands: [{ pluginId: "pl", command: { name: "ship", template: "go" } }],
    });
    expect(text).toContain("/sessions");
    expect(text).toContain("/undo-run");
    expect(text).toContain("/doctor");
    expect(text).toContain("/deploy");
    expect(text).toContain("/ship");
  });
});

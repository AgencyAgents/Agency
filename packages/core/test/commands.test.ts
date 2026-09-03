import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expandCommand, loadCommands, parseSlashInput } from "../src/commands/loader.ts";

describe("slash commands", () => {
  test("parseSlashInput splits name and args", () => {
    expect(parseSlashInput("/review fix bug")).toEqual({ name: "review", args: "fix bug" });
    expect(parseSlashInput("/help")).toEqual({ name: "help", args: "" });
    expect(parseSlashInput("not slash")).toBeUndefined();
    expect(parseSlashInput("/name  args with spaces  ")).toEqual({ name: "name", args: " args with spaces" });
  });

  test("$ARGUMENTS substitution", () => {
    const tmpl = "Review: $ARGUMENTS\nDone";
    expect(expandCommand(tmpl, "my feature")).toBe("Review: my feature\nDone");
  });

  test("${ARGUMENTS} and $ARGS substitution", () => {
    expect(expandCommand("args=${ARGUMENTS}", "hello")).toBe("args=hello");
    expect(expandCommand("args=$ARGS", "hello")).toBe("args=hello");
  });

  test("multiple $ARGUMENTS occurrences replaced", () => {
    const tmpl = "$ARGUMENTS and $ARGUMENTS";
    expect(expandCommand(tmpl, "x")).toBe("x and x");
  });

  test("file reference {{file:path}} includes file content", () => {
    const dir = join(tmpdir(), `agency-cmd-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, "note.txt");
    writeFileSync(filePath, "file content");
    const tmpl = "before {{file:note.txt}} after";
    const expanded = expandCommand(tmpl, "", dir);
    expect(expanded).toBe("before file content after");
    rmSync(dir, { recursive: true, force: true });
  });

  test("$FILE:path includes file content", () => {
    const dir = join(tmpdir(), `agency-cmd-test2-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.txt"), "hello");
    const expanded = expandCommand("prefix $FILE:a.txt suffix", "", dir);
    expect(expanded).toBe("prefix hello suffix");
    rmSync(dir, { recursive: true, force: true });
  });

  test("missing file reference yields placeholder", () => {
    const dir = join(tmpdir(), `agency-cmd-missing-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const expanded = expandCommand("{{file:missing.txt}}", "", dir);
    expect(expanded).toContain("missing file");
    rmSync(dir, { recursive: true, force: true });
  });

  test("loadCommands discovers project and user commands, project wins", () => {
    const ws = join(tmpdir(), `agency-ws-${Date.now()}`);
    const userDir = join(tmpdir(), `agency-user-${Date.now()}`);
    mkdirSync(join(ws, ".agency", "commands"), { recursive: true });
    mkdirSync(join(userDir, "commands"), { recursive: true });
    writeFileSync(join(ws, ".agency", "commands", "foo.md"), "# Foo project\n$ARGUMENTS");
    writeFileSync(join(userDir, "commands", "foo.md"), "# Foo user\n$ARGUMENTS");
    writeFileSync(join(userDir, "commands", "bar.md"), "# Bar\nhello");
    const cmds = loadCommands({ workspaceRoot: ws, configDirOverride: userDir });
    const foo = cmds.find((c) => c.name === "foo");
    const bar = cmds.find((c) => c.name === "bar");
    expect(foo?.description).toBe("Foo project");
    expect(foo?.source).toBe("project");
    expect(bar?.name).toBe("bar");
    rmSync(ws, { recursive: true, force: true });
    rmSync(userDir, { recursive: true, force: true });
  });

  test("loadCommands returns sorted list", () => {
    const ws = join(tmpdir(), `agency-ws-sort-${Date.now()}`);
    mkdirSync(join(ws, ".agency", "commands"), { recursive: true });
    writeFileSync(join(ws, ".agency", "commands", "z.md"), "z");
    writeFileSync(join(ws, ".agency", "commands", "a.md"), "a");
    const cmds = loadCommands({ workspaceRoot: ws });
    expect(cmds.map((c) => c.name)).toEqual(["a", "z"]);
    rmSync(ws, { recursive: true, force: true });
  });
});

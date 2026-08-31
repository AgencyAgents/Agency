import { describe, expect, test } from "bun:test";
import { CWD_MARKER, EXIT_MARKER, parseShellOutput, resolveShell } from "../src/shell.ts";

describe("resolveShell", () => {
  test("resolves POSIX sh on macOS and Linux regardless of windowsShell", () => {
    expect(resolveShell("darwin").command).toBe("/bin/sh");
    expect(resolveShell("linux", "cmd").command).toBe("/bin/sh");
  });

  test("defaults to PowerShell on Windows, resolved to an absolute path", () => {
    const shell = resolveShell("win32");
    expect(shell.command.toLowerCase()).toContain("powershell.exe");
    expect(shell.command).toMatch(/^[A-Za-z]:\\/); // absolute, not a bare PATH lookup
    expect(shell.label).toBe("PowerShell");
  });

  test("honors an explicit gitbash choice on Windows", () => {
    expect(resolveShell("win32", "gitbash").command).toBe("bash.exe");
  });

  test("honors an explicit cmd choice on Windows, resolved to an absolute path", () => {
    const shell = resolveShell("win32", "cmd");
    expect(shell.command.toLowerCase()).toContain("cmd.exe");
    expect(shell.command).toMatch(/^[A-Za-z]:\\/);
  });

  test("each shell wraps argv differently", () => {
    expect(resolveShell("win32", "powershell").buildArgs("echo hi")).toEqual([
      "-NoProfile",
      "-Command",
      "echo hi",
    ]);
    expect(resolveShell("win32", "cmd").buildArgs("echo hi")).toEqual(["/d", "/v:on", "/c", "echo hi"]);
    expect(resolveShell("linux").buildArgs("echo hi")).toEqual(["-c", "echo hi"]);
  });

  test("every shell's wrapped command appends both the exit and cwd markers", () => {
    for (const shell of [
      resolveShell("linux"),
      resolveShell("win32", "powershell"),
      resolveShell("win32", "cmd"),
    ]) {
      const wrapped = shell.wrapCommand("echo hi");
      expect(wrapped).toContain(CWD_MARKER);
      expect(wrapped).toContain(EXIT_MARKER);
    }
  });

  test("PowerShell and cmd wrapping forces UTF-8 output encoding", () => {
    expect(resolveShell("win32", "powershell").wrapCommand("x")).toContain("UTF8");
    expect(resolveShell("win32", "cmd").wrapCommand("x")).toContain("chcp 65001");
  });
});

describe("parseShellOutput", () => {
  test("splits both marker lines out of trailing output", () => {
    const raw = `hello world\n${EXIT_MARKER}0\n${CWD_MARKER}/home/user/project\n`;
    const result = parseShellOutput(raw, "/fallback");
    expect(result.output).toBe("hello world");
    expect(result.exitCode).toBe(0);
    expect(result.cwd).toBe("/home/user/project");
  });

  test("parses a nonzero exit code", () => {
    const raw = `some output\n${EXIT_MARKER}7\n${CWD_MARKER}/x\n`;
    expect(parseShellOutput(raw, "/fallback").exitCode).toBe(7);
  });

  test("falls back to the given cwd and exit 0 when no markers are present", () => {
    const result = parseShellOutput("plain output, no markers", "/fallback");
    expect(result.output).toBe("plain output, no markers");
    expect(result.cwd).toBe("/fallback");
    expect(result.exitCode).toBe(0);
  });

  test("handles a Windows path with a drive letter and backslashes", () => {
    const raw = `build ok\n${EXIT_MARKER}0\n${CWD_MARKER}C:\\Users\\pixel\\agency\r\n`;
    expect(parseShellOutput(raw, "C:\\fallback").cwd).toBe("C:\\Users\\pixel\\agency");
  });

  test("preserves multi-line command output before the markers", () => {
    const raw = `line one\nline two\nline three\n${EXIT_MARKER}0\n${CWD_MARKER}/x`;
    expect(parseShellOutput(raw, "/fallback").output).toBe("line one\nline two\nline three");
  });
});

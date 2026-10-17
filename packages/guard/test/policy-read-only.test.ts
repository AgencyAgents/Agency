import { expect, test } from "bun:test";
import { isReadOnlyCommand, PermissionsGate } from "../src/policy.ts";

test("a read-only command of the workspace, after the read-only set of Claude Code", () => {
  for (const command of [
    "ls -la src",
    "cat README.md | head -5",
    "cd packages && ls",
    "grep -n TODO src/a.ts 2>/dev/null",
    "find . -name '*.ts'",
    "git status && git diff --stat",
    "git log --oneline -5",
    "git branch --show-current",
    "wc -l < in.txt",
    "rg -n foo src",
    "sed -n 1p a.txt",
    "sed 's|src/||' list.txt | sort",
  ]) {
    expect([command, isReadOnlyCommand(command)]).toEqual([command, true]);
  }
  for (const command of [
    "rm a.txt",
    "ls > out.txt",
    "echo x>a.txt",
    "echo x>>a.txt",
    "git log --all>a.txt",
    "cat r.ts>out",
    "file -C",
    "cat /etc/passwd",
    "cat ~/.ssh/id_rsa",
    "cat ../other/x",
    "cat C:/Users/x",
    "cat .env",
    "head config/.env.local",
    "cat *env*",
    "ls *.ts",
    "grep -r KEY .",
    "rg --hidden KEY",
    "find . -delete",
    "find . -exec rm {} ;",
    "sort -no x.txt in.txt",
    "git commit -m x",
    "git branch new",
    "git -C .. status",
    "git diff --output=x",
    "cd sub && git status",
    "cat $HOME/x",
    "echo $(rm x)",
    "ls; npm test",
    "sed -i s/a/b/ a.txt",
    "sed 's/a/b/w out.txt' a.txt",
    "sed 'e rm x' a.txt",
    "sed -f script.sed a.txt",
    "PATH=. ls",
    "sudo cat a.txt",
    "cat (Remove-Item x)",
    "cat src\\a.ts",
  ]) {
    expect([command, isReadOnlyCommand(command)]).toEqual([command, false]);
  }
});

test("an absolute path reads when it is in the workspace, in Windows or MSYS form", () => {
  const root = String.raw`C:\Users\me\proj`;
  const find = `find /c/Users/me/proj/packages -name "*.ts" -path "*/src/*" | sed 's|/c/Users/me/proj/||' | sort`;
  expect(isReadOnlyCommand(find, root)).toBe(true);
  expect(isReadOnlyCommand("cat C:/Users/me/proj/a.ts", root)).toBe(true);
  expect(isReadOnlyCommand(find)).toBe(false);
  for (const command of [
    "cat /c/Users/me/other/a.ts",
    "cat /c/Users/me/project2/a.ts",
    "cat /c/Users/me/proj/../other/a.ts",
    "cat /etc/passwd",
  ]) {
    expect([command, isReadOnlyCommand(command, root)]).toEqual([command, false]);
  }
});

test("a read-only command runs without a prompt unless an ask or deny rule names it", () => {
  const decide = (
    permissions: ConstructorParameters<typeof PermissionsGate>[0]["permissions"],
    command: string,
  ) =>
    new PermissionsGate({ permissions, workspaceRoot: process.cwd() }).decisionFor({
      tool: "bash",
      command,
      riskTier: "dangerous",
    });
  expect(decide(undefined, "ls -la")).toBe("allow");
  expect(decide(undefined, "npm test")).toBe("ask");
  expect(decide({ bash: { "npm *": "allow" } }, "ls && cat a.txt")).toBe("allow");
  expect(decide({ bash: { "cat *": "ask" } }, "ls && cat a.txt")).toBe("ask");
  expect(decide({ bash: { "cat *": "deny" } }, "cat a.txt")).toBe("deny");
  expect(decide({ bash: { "*": "ask", "git *": "allow" } }, "ls")).toBe("ask");
  expect(decide({ bash: "ask" }, "ls")).toBe("ask");
  expect(decide({ read: { "**": "allow", "secret.txt": "deny" } }, "cat secret.txt")).toBe("deny");
});

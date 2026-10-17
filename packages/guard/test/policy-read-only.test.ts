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

test("the holes of the audit ask: home, abbreviated options, `<>`, secrets in any case, endless reads, drives", () => {
  for (const command of [
    "cd && cat .ssh/id_rsa",
    "cd - && ls",
    "sed --in=.bak 's/a/b/' a.txt",
    "sort --out=X s.txt",
    "sort --compress-p=sh a",
    "file --mag x",
    "cat <>NEWFILE",
    "cat .ENV",
    "head -n1 .Env.local",
    "git show HEAD:.env",
    "rg --unrestricted KEY",
    "rg --no-ignore-dot KEY",
    "rg -g '*.env' KEY",
    "grep -f/etc/passwd a.txt",
    "cat .npmrc",
    "cat .aws/credentials",
    "tail -f x.log",
    "tail --follow x.log",
    "cat CON",
    "cat env:USERPROFILE",
    "ls HKCU:/Software",
    "cat '.e*'",
    "cat '.[e]nv'",
    "uniq in.txt out.txt",
    "xxd -r dump bin",
    "awk '{print > \"x\"}' f",
    "awk 'BEGIN{system(\"rm x\")}'",
    "jq -n env",
    "ps e",
    "node -e 1",
    "command ls",
    "git tag v1",
    "git stash",
    "git config user.name x",
  ]) {
    expect([command, isReadOnlyCommand(command)]).toEqual([command, false]);
  }
});

test("common read-only commands of the audit run: quoted shell syntax, more programs, wildcards of plain readers", () => {
  for (const command of [
    "git diff HEAD~1",
    "awk '{print $1}' f",
    "sort a | uniq -c | sort -rn",
    "grep -n 'foo$' f",
    "grep -E '(a|b)' f",
    "rg -g '!node_modules' foo",
    "echo 'a>b'",
    "sed -n '/foo/,/bar/p' a.txt",
    "sed -E 's/(a)/\\1/' a.txt",
    "ls *.ts",
    "wc -l src/*.ts",
    "LC_ALL=C sort a",
    "timeout 5 ls",
    "command -v bun",
    "node -v",
    "git --no-pager log -3",
    "git remote -v",
    "git config --get user.name",
    "ps aux",
    "jq '.name' package.json",
    "echo hi >/dev/stdout",
  ]) {
    expect([command, isReadOnlyCommand(command)]).toEqual([command, true]);
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

test("the ask of a command says why the command is not read-only", async () => {
  const gate = new PermissionsGate({ workspaceRoot: process.cwd() });
  const asked: Array<{ reason?: string }> = [];
  await gate.check(
    { tool: "bash", title: "uniq", command: "uniq in.txt out.txt", riskTier: "dangerous" },
    async (r) => {
      asked.push(r);
      return "reject";
    },
  );
  expect(asked[0]?.reason).toBe("`uniq` writes its second file");
});

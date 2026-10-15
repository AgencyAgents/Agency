import { expect, test } from "bun:test";
import { PermissionsGate, shellFileTargets } from "../src/policy.ts";

test("the files that a shell command reads and writes, as far as the words of the command name them", () => {
  expect(shellFileTargets("cat .env")).toEqual({ reads: [".env"], writes: [] });
  expect(shellFileTargets("head -n 5 'my notes.txt' && grep KEY .env config.json")).toEqual({
    reads: ["my notes.txt", ".env", "config.json"],
    writes: [],
  });
  expect(shellFileTargets("grep -e KEY .env").reads).toEqual([".env"]);
  expect(shellFileTargets("sed -i s/a/b/ src/a.ts").writes).toEqual(["src/a.ts"]);
  expect(shellFileTargets("echo hi > out.txt 2>&1; echo more >>log.txt; wc -l < in.txt")).toEqual({
    reads: ["in.txt"],
    writes: ["out.txt", "log.txt"],
  });
  expect(shellFileTargets("git status | tee status.txt > /dev/null")).toEqual({
    reads: [],
    writes: ["status.txt"],
  });
  expect(shellFileTargets("env LANG=C cat secret.txt").reads).toContain("secret.txt");
  expect(shellFileTargets("ls -la src")).toEqual({ reads: [], writes: [] });
});

test("a Read or Edit deny rule holds for the files that a shell command names, as in Claude Code", () => {
  const gate = new PermissionsGate({
    permissions: { bash: "allow", read: { "**": "allow", ".env": "deny" }, edit: { "secrets/**": "deny" } },
    workspaceRoot: process.cwd(),
  });
  const decide = (command: string) => gate.decisionFor({ tool: "bash", command, riskTier: "dangerous" });
  for (const command of [
    "cat .env",
    "ls && head -3 .env",
    "grep TOKEN .env",
    "wc -c < .env",
    "echo key > secrets/key.txt",
    "printf x | tee secrets/b.txt",
    "sed -i s/a/b/ secrets/c.txt",
  ]) {
    expect([command, decide(command)]).toEqual([command, "deny"]);
  }
  for (const command of ["cat README.md", "grep .env notes.txt", "echo hi > out.txt", "ls secrets"]) {
    expect([command, decide(command)]).toEqual([command, "allow"]);
  }
});

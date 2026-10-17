import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expandCommand, loadCommands } from "../src/commands/loader.ts";
import {
  parseSkillFrontmatter,
  type SkillDescriptor,
  skillText,
  splitFrontmatter,
} from "../src/plugins/skill.ts";

test("frontmatter as skills write it: quotes, folded and literal blocks, lists, nested maps, CRLF", () => {
  const text = [
    "---",
    'name: "brainstorm"',
    "description: >",
    "  Use before any creative work:",
    "  features, components.",
    "when_to_use: 'when the user says ''design'''",
    "allowed-tools:",
    "  - Read",
    '  - "Bash(git *)"',
    "metadata:",
    "  author: someone",
    "notes: |",
    "  line one",
    "  line two",
    "long: first part",
    "  second part",
    "---",
    "Body",
  ].join("\r\n");
  expect(splitFrontmatter(text).fields).toEqual({
    name: "brainstorm",
    description: "Use before any creative work: features, components.",
    when_to_use: "when the user says 'design'",
    "allowed-tools": "Read, Bash(git *)",
    notes: "line one\nline two",
    long: "first part second part",
  });
  const skill = parseSkillFrontmatter(text);
  expect(skill.description).toBe(
    "Use before any creative work: features, components. when the user says 'design'",
  );
  expect(skill).toMatchObject({ modelInvocable: true, userInvocable: true });
  expect(
    parseSkillFrontmatter("---\ndisable-model-invocation: On\nuser-invocable: no\n---\nx"),
  ).toMatchObject({
    modelInvocable: false,
    userInvocable: false,
  });
  expect(parseSkillFrontmatter(`---\ndescription: ${"a".repeat(2000)}\n---\nx`).description).toHaveLength(
    1536,
  );
});

test("the text of a skill fills its folder and its arguments, as in Claude Code", () => {
  const skill = (body: string): SkillDescriptor => ({
    name: "fix",
    path: join(tmpdir(), "fix", "SKILL.md"),
    body,
    tier: "user",
    modelInvocable: true,
    userInvocable: true,
  });
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder of Claude Code
  const text = skillText(
    skill("Run ${CLAUDE_SKILL_DIR}/fix.sh $ARGUMENTS[1] on $ARGUMENTS"),
    '"issue 12" now',
  );
  expect(text).toContain(`Run ${join(tmpdir(), "fix")}/fix.sh now on "issue 12" now`);
  expect(skillText(skill("Fix it."), "issue 12")).toEndWith("Fix it.\n\nARGUMENTS: issue 12");
  expect(skillText(skill("Fix it."), "")).toEndWith("Fix it.");
});

test("a skill is the command /<name>, unless user-invocable is false or a command file has the name", () => {
  const ws = mkdtempSync(join(tmpdir(), "agency-skill-cmd-"));
  const config = mkdtempSync(join(tmpdir(), "agency-skill-cfg-"));
  try {
    const write = (path: string, text: string) => {
      mkdirSync(dirname(join(ws, path)), { recursive: true });
      writeFileSync(join(ws, path), text);
    };
    write(
      ".claude/skills/review/SKILL.md",
      "---\ndescription: Reviews a PR\n---\nReview PR $ARGUMENTS[0] now.",
    );
    write(".claude/skills/hidden/SKILL.md", "---\nuser-invocable: false\n---\nHidden.");
    write(".claude/skills/deploy/SKILL.md", "---\ndescription: skill\n---\nSkill body.");
    write(".claude/commands/deploy.md", "Command body.");
    const commands = loadCommands({ workspaceRoot: ws, configDirOverride: config });
    const byName = new Map(commands.map((command) => [command.name, command]));
    expect(byName.get("review")?.description).toBe("Reviews a PR");
    expect(expandCommand(byName.get("review")?.content ?? "", "42 extra")).toContain("Review PR 42 now.");
    expect(byName.has("hidden")).toBe(false);
    expect(byName.get("deploy")?.content).toBe("Command body.");
    expect(loadCommands({ workspaceRoot: ws, configDirOverride: config, projectTrusted: false })).toEqual([]);
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(config, { recursive: true, force: true });
  }
});

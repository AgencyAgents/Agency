import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createFileTrustStore } from "@agency/guard";
import { resolveFileRoster } from "../src/agents/files.ts";
import { expandCommand, loadCommands } from "../src/commands/loader.ts";
import { discoverSkills, resolveSkillDirs } from "../src/plugins/skill.ts";
import { loadInstructions } from "../src/prompt/instructions.ts";
import { outputStyleInstructions } from "../src/prompt/output-style.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "agency-foreign-"));
  dirs.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const skill = (name: string) => `---\nname: ${name}\ndescription: ${name} skill\n---\nbody of ${name}\n`;

test("the rules of Cursor, Windsurf, Cline, Copilot, Gemini, Roo, Junie, Kiro and Augment join the instructions, once each", () => {
  const ws = folder({
    "AGENTS.md": "agents text",
    "CLAUDE.md": "agents text",
    "GEMINI.md": "gemini text",
    ".cursorrules": "legacy cursor rule",
    ".windsurfrules": "windsurf rule",
    ".clinerules": "cline rule",
    ".github/copilot-instructions.md": "copilot rule",
    ".roo/rules/style.md": "roo rule",
    ".junie/guidelines.md": "junie rule",
    ".kiro/steering/product.md": "kiro rule",
    ".kiro/steering/tests.md":
      '---\ninclusion: fileMatch\nfileMatchPattern: "**/*.test.ts"\n---\nkiro test rule',
    ".kiro/steering/manual.md": "---\ninclusion: manual\n---\nkiro manual rule",
    ".augment/rules/always.md": "---\ntype: always_apply\n---\naugment rule",
    ".cursor/rules/always.mdc": "---\nalwaysApply: true\n---\nalways rule",
    ".cursor/rules/api/ts.mdc": '---\nglobs: "src/api/**/*.ts"\nalwaysApply: false\n---\napi rule',
    ".cursor/rules/chosen.mdc": "---\ndescription: Database migrations\n---\nmigration rule",
    ".cursor/rules/manual.mdc": "---\nalwaysApply: false\n---\nmanual rule",
    ".cursor/rules/plain.md": "not a cursor rule",
  });
  const trust = createFileTrustStore(join(folder({}), "trust.json"));
  trust.trust(ws);
  const text = loadInstructions(trust, ws, ws).join("\n---\n");
  // AGENTS.md and CLAUDE.md with the same text count once.
  expect(text.split("agents text")).toHaveLength(2);
  for (const part of [
    "gemini text",
    "legacy cursor rule",
    "windsurf rule",
    "cline rule",
    "copilot rule",
    "always rule",
    "roo rule",
    "junie rule",
    "kiro rule",
    "augment rule",
    "Files that match **/*.test.ts:\nkiro test rule",
  ]) {
    expect(text).toContain(part);
  }
  expect(text).toContain("Files that match src/api/**/*.ts:\napi rule");
  expect(text).toContain("When the task is about: Database migrations\nmigration rule");
  expect(text).not.toContain("manual rule");
  expect(text).not.toContain("not a cursor rule");
  expect(text).not.toContain("alwaysApply");
});

test("skills of the project folders of other agents load, and .agency/skills wins on a name", () => {
  const ws = folder({
    ".agency/skills/shared/SKILL.md": skill("shared"),
    ".claude/skills/shared/SKILL.md": skill("shared"),
    ".claude/skills/cc/SKILL.md": skill("cc"),
    ".agents/skills/std/SKILL.md": skill("std"),
    ".cursor/skills/cur/SKILL.md": skill("cur"),
    ".codex/skills/cdx/SKILL.md": skill("cdx"),
    ".pi/skills/pi/SKILL.md": skill("pi"),
    ".opencode/skills/oc/SKILL.md": skill("oc"),
    ".gemini/skills/gem/SKILL.md": skill("gem"),
  });
  const skills = discoverSkills(resolveSkillDirs(ws, folder({})));
  expect(skills.map((s) => s.name).sort()).toEqual(["cc", "cdx", "cur", "gem", "oc", "pi", "shared", "std"]);
  expect(skills.find((s) => s.name === "shared")?.path).toContain(".agency");
});

test("commands of Claude Code, Cursor, OpenCode, Pi and Gemini load; a Gemini TOML command is converted", () => {
  const ws = folder({
    ".claude/commands/review.md": "---\ndescription: Review\n---\nReview $ARGUMENTS",
    ".cursor/commands/fix.md": "Fix the bug",
    ".opencode/commands/test.md": "Run the tests of $1",
    ".pi/prompts/plan.md": "Plan $@",
    ".gemini/commands/gcs/sync.toml":
      'description = "Sync"\nprompt = """Sync {{args}}\n@{notes.md}\n!{echo hi}"""\n',
    ".gemini/commands/plain.toml": 'prompt = "Explain"\n',
    ".agency/commands/review.md": "Agency review $ARGUMENTS",
    "notes.md": "the notes",
  });
  const commands = loadCommands({ workspaceRoot: ws, configDirOverride: folder({}) });
  expect(commands.map((c) => c.name)).toEqual(["fix", "gcs:sync", "plain", "plan", "review", "test"]);
  const byName = (name: string) => commands.find((c) => c.name === name)?.content ?? "";
  expect(byName("review")).toBe("Agency review $ARGUMENTS");
  expect(commands.find((c) => c.name === "gcs:sync")?.description).toBe("Sync");
  expect(expandCommand(byName("gcs:sync"), "bucket", ws, { shell: true })).toBe("Sync bucket\nthe notes\nhi");
  expect(expandCommand(byName("plain"), "the loop", ws)).toBe("Explain\n\nthe loop");
  expect(loadCommands({ workspaceRoot: ws, configDirOverride: folder({}), projectTrusted: false })).toEqual(
    [],
  );
});

test("agent files of Claude Code, Cursor and OpenCode load with their unknown keys left out", () => {
  const ws = folder({
    ".claude/agents/reviewer.md":
      "---\nname: reviewer\ndescription: Reviews code\ntools: Read, Grep\nmodel: sonnet\nmaxTurns: 5\n---\nYou review.",
    ".cursor/agents/scout.md":
      "---\nname: scout\ndescription: Looks around\nreadonly: true\nis_background: false\n---\nYou look.",
    ".opencode/agents/docs.md":
      "---\ndescription: Writes docs\nmode: subagent\nmodel: anthropic/claude-sonnet-5\npermission:\n  edit: deny\n---\nYou write docs.",
    ".claude/agents/Bad Name.md": "---\ndescription: x\n---\nx",
  });
  const warnings: string[] = [];
  const { agents } = resolveFileRoster({
    workspaceRoot: ws,
    configDirOverride: folder({}),
    configAgents: {},
    seed: false,
    warn: (w) => warnings.push(w),
  });
  expect(agents.get("reviewer")).toMatchObject({ description: "Reviews code", tools: ["grep", "read"] });
  expect(agents.get("reviewer")?.model).toBeUndefined();
  expect(agents.get("scout")).toMatchObject({ description: "Looks around", tools: ["glob", "grep", "read"] });
  expect(agents.get("docs")).toMatchObject({
    provider: "anthropic",
    model: "claude-sonnet-5",
    systemPrompt: "You write docs.",
  });
  expect(warnings.join("\n")).toContain("Bad Name");
});

test("the user files of other agents load at the user tier, and AGENCY_AGENTS_HOME=off reads none", () => {
  const home = folder({
    ".claude/skills/mine/SKILL.md": skill("mine"),
    ".agents/skills/shared/SKILL.md": skill("shared"),
    ".codex/prompts/draft.md": "Draft $ARGUMENTS",
    ".gemini/commands/note.toml": 'prompt = "Note {{args}}"\n',
    ".claude/agents/helper.md": "---\nname: helper\ndescription: Helps\nmaxTurns: 3\n---\nYou help.",
  });
  const ws = folder({});
  const config = folder({});
  const before = process.env.AGENCY_AGENTS_HOME;
  try {
    process.env.AGENCY_AGENTS_HOME = home;
    const skills = discoverSkills(resolveSkillDirs(ws, config));
    expect(
      skills
        .filter((s) => s.tier === "user")
        .map((s) => s.name)
        .sort(),
    ).toEqual(["mine", "shared"]);
    const commands = loadCommands({ workspaceRoot: ws, configDirOverride: config });
    expect(commands.map((c) => `${c.name}:${c.source}`)).toEqual(["draft:user", "note:user"]);
    const roster = resolveFileRoster({
      workspaceRoot: ws,
      configDirOverride: config,
      configAgents: {},
      seed: false,
    });
    expect(roster.agents.get("helper")).toMatchObject({ source: "user", description: "Helps" });

    process.env.AGENCY_AGENTS_HOME = "off";
    expect(discoverSkills(resolveSkillDirs(ws, config))).toEqual([]);
    expect(loadCommands({ workspaceRoot: ws, configDirOverride: config })).toEqual([]);
  } finally {
    process.env.AGENCY_AGENTS_HOME = before;
  }
});

test("an output style comes from the project, the config folder or ~/.claude by its name, and a project one needs trust", () => {
  const ws = folder({
    ".claude/output-styles/terse.md":
      "---\nname: Terse\ndescription: Short\nkeep-coding-instructions: true\n---\nKeep it short.",
  });
  const config = folder({ "output-styles/pirate.md": "Talk like a pirate." });
  const home = folder({ ".claude/output-styles/poem.md": '---\nname: "Poem"\n---\nAnswer in verse.' });
  const before = process.env.AGENCY_AGENTS_HOME;
  process.env.AGENCY_AGENTS_HOME = home;
  try {
    const style = (name: string | undefined, projectTrusted = true) =>
      outputStyleInstructions({ name, workspaceRoot: ws, configDirOverride: config, projectTrusted });
    expect(style("terse")).toEqual(['Output style "Terse": write each reply in this style.\nKeep it short.']);
    expect(style("pirate")[0]).toContain("Talk like a pirate.");
    expect(style("Poem")[0]).toContain("Answer in verse.");
    expect(style("terse", false)).toEqual([]);
    expect(style("default")).toEqual([]);
    expect(style(undefined)).toEqual([]);
    const warnings: string[] = [];
    outputStyleInstructions({
      name: "nope",
      workspaceRoot: ws,
      projectTrusted: true,
      configDirOverride: config,
      warn: (w) => warnings.push(w),
    });
    expect(warnings[0]).toContain('no output style "nope"');
  } finally {
    process.env.AGENCY_AGENTS_HOME = before;
  }
});

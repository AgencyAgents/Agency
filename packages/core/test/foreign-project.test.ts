import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createFileTrustStore } from "@agency/guard";
import { resolveFileRoster } from "../src/agents/files.ts";
import { expandCommand, loadCommands } from "../src/commands/loader.ts";
import { discoverSkills, resolveSkillDirs } from "../src/plugins/skill.ts";
import {
  expandImports,
  loadInstructions,
  loadUserAgentInstructions,
  nestedInstructions,
} from "../src/prompt/instructions.ts";
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

test("the rules of Claude Code, Cursor, Windsurf, Cline, Copilot, Gemini, Roo, Kilo, Junie, Kiro, Augment, Zed and Trae join the instructions, once each", () => {
  const ws = folder({
    "AGENTS.md": "agents text",
    "CLAUDE.md": "agents text",
    "GEMINI.md": "gemini text",
    ".claude/CLAUDE.md": "dot claude text",
    "CLAUDE.local.md": "local claude text",
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
    ".windsurf/rules/a.md": "---\ntrigger: always_on\n---\nwindsurf always rule",
    ".windsurf/rules/b.md": '---\ntrigger: glob\nglobs: "*.py"\n---\nwindsurf py rule',
    ".windsurf/rules/c.md": "---\ntrigger: manual\n---\nwindsurf manual rule",
    ".kilocode/rules/k.md": "kilo rule",
    ".rules": "zed rule",
    ".trae/rules/project_rules.md": "trae rule",
    ".github/instructions/ts.instructions.md": '---\napplyTo: "**/*.ts"\n---\ncopilot ts rule',
    ".github/instructions/team/all.instructions.md": '---\napplyTo: "**"\n---\ncopilot all rule',
    ".github/instructions/manual.instructions.md": "copilot manual rule",
    ".claude/rules/api.md": '---\npaths:\n  - "src/api/**"\n  - "lib/**"\n---\nclaude api rule',
    ".claude/rules/docs/one.md": '---\npaths: "docs/**"\n---\nclaude docs rule',
    ".claude/rules/style.md": "claude style rule",
  });
  const trust = createFileTrustStore(join(folder({}), "trust.json"));
  trust.trust(ws);
  const text = loadInstructions(trust, ws, ws).join("\n---\n");
  expect(text).toContain("Files that match src/api/**, lib/**:\nclaude api rule");
  expect(text).toContain("Files that match docs/**:\nclaude docs rule");
  expect(text).toContain("---\nclaude style rule");
  // AGENTS.md and CLAUDE.md with the same text count once.
  expect(text.split("agents text")).toHaveLength(2);
  for (const part of [
    "gemini text",
    "dot claude text",
    "local claude text",
    "windsurf always rule",
    "Files that match *.py:\nwindsurf py rule",
    "kilo rule",
    "zed rule",
    "trae rule",
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
    "Files that match **/*.ts:\ncopilot ts rule",
    "copilot all rule",
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
    ".github/skills/gh/SKILL.md": skill("gh"),
  });
  const skills = discoverSkills(resolveSkillDirs(ws, folder({})));
  expect(skills.map((s) => s.name).sort()).toEqual([
    "cc",
    "cdx",
    "cur",
    "gem",
    "gh",
    "oc",
    "pi",
    "shared",
    "std",
  ]);
  expect(skills.find((s) => s.name === "shared")?.path).toContain(".agency");
});

test("commands of Claude Code, Cursor, OpenCode, Pi, Gemini and Copilot load; a Gemini TOML command is converted", () => {
  const ws = folder({
    ".claude/commands/review.md": "---\ndescription: Review\n---\nReview $ARGUMENTS",
    ".cursor/commands/fix.md": "Fix the bug",
    ".opencode/commands/test.md": "Run the tests of $1",
    ".pi/prompts/plan.md": "Plan $@",
    ".gemini/commands/gcs/sync.toml":
      'description = "Sync"\nprompt = """Sync {{args}}\n@{notes.md}\n!{echo hi}"""\n',
    ".gemini/commands/plain.toml": 'prompt = "Explain"\n',
    ".github/prompts/doc.prompt.md": "---\ndescription: Document\nmode: agent\n---\nDocument the code",
    ".agency/commands/review.md": "Agency review $ARGUMENTS",
    "notes.md": "the notes",
  });
  const commands = loadCommands({ workspaceRoot: ws, configDirOverride: folder({}) });
  expect(commands.map((c) => c.name)).toEqual(["doc", "fix", "gcs:sync", "plain", "plan", "review", "test"]);
  const byName = (name: string) => commands.find((c) => c.name === name)?.content ?? "";
  expect(commands.find((c) => c.name === "doc")?.description).toBe("Document");
  expect(expandCommand(byName("doc"), "of the loop", ws)).toBe("Document the code\n\nof the loop");
  expect(byName("review")).toBe("Agency review $ARGUMENTS");
  expect(commands.find((c) => c.name === "gcs:sync")?.description).toBe("Sync");
  expect(expandCommand(byName("gcs:sync"), "bucket", ws, { shell: true })).toBe("Sync bucket\nthe notes\nhi");
  expect(expandCommand(byName("plain"), "the loop", ws)).toBe("Explain\n\nthe loop");
  expect(loadCommands({ workspaceRoot: ws, configDirOverride: folder({}), projectTrusted: false })).toEqual(
    [],
  );
});

test("agent files of Claude Code, Cursor, OpenCode and Copilot load with their unknown keys left out", () => {
  const ws = folder({
    ".claude/agents/reviewer.md":
      "---\nname: reviewer\ndescription: Reviews code\ntools: Read, Grep\nmodel: sonnet\nmaxTurns: 5\n---\nYou review.",
    ".cursor/agents/scout.md":
      "---\nname: scout\ndescription: Looks around\nreadonly: true\nis_background: false\n---\nYou look.",
    ".opencode/agents/docs.md":
      "---\ndescription: Writes docs\nmode: subagent\nmodel: anthropic/claude-sonnet-5\npermission:\n  edit: deny\n---\nYou write docs.",
    ".claude/agents/Bad Name.md": "---\ndescription: x\n---\nx",
    ".github/agents/planner.agent.md":
      "---\ndescription: Plans work\ntools: ['search', 'fetch', 'github/*']\nmodel: Claude Sonnet 4.5 (copilot)\nhandoffs:\n  - label: Go\n---\nYou plan.",
    ".github/chatmodes/fixer.chatmode.md":
      "---\ndescription: Fixes bugs\ntools: ['edit/editFiles', 'runCommands']\n---\nYou fix.",
    ".github/agents/asker.agent.md": "---\ndescription: Asks GitHub\ntools: ['github/*']\n---\nYou ask.",
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
  // Copilot: its tool sets map to tools here, and its display name of a model is left out.
  expect(agents.get("planner")).toMatchObject({
    description: "Plans work",
    tools: ["fetch", "glob", "grep", "read"],
    systemPrompt: "You plan.",
  });
  expect(agents.get("planner")?.model).toBeUndefined();
  expect(agents.get("fixer")?.tools).toEqual(["bash", "edit", "notebook_edit", "write"]);
  expect(agents.get("asker")?.tools).toEqual(["glob", "grep", "read"]);
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

test("the user instructions of Claude Code, Codex, Gemini, OpenCode and Pi load; the override of Codex wins", () => {
  const home = folder({
    ".claude/CLAUDE.md": "claude user rule",
    ".codex/AGENTS.override.md": "codex override",
    ".codex/AGENTS.md": "codex plain",
    ".gemini/GEMINI.md": "claude user rule",
    ".config/opencode/AGENTS.md": "",
    ".pi/agent/AGENTS.md": "pi user rule",
    ".claude/rules/go.md": '---\npaths: "**/*.go"\n---\nclaude user go rule',
  });
  expect(loadUserAgentInstructions(home)).toEqual([
    "claude user rule",
    "codex override",
    "pi user rule",
    "Files that match **/*.go:\nclaude user go rule",
  ]);
});

test("the @path imports of CLAUDE.md load, inside the workspace only, and not in code", () => {
  const parent = folder({ "outside.md": "SECRET OUTSIDE" });
  const ws = join(parent, "ws");
  const files: Record<string, string> = {
    "AGENTS.md": "agents text",
    "CLAUDE.md": [
      "@AGENTS.md",
      "Read @docs/style.md.",
      "`@docs/style.md` stays",
      "```",
      "@docs/style.md",
      "```",
      "@../outside.md @missing.md me@docs.md @loop.md",
    ].join("\n"),
    "docs/style.md": "style rule @nested.md",
    "docs/nested.md": "nested rule",
    "loop.md": "x @loop.md",
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(ws, path)), { recursive: true });
    writeFileSync(join(ws, path), text);
  }
  const text = expandImports(files["CLAUDE.md"] ?? "", ws, ws, 1000);
  expect(text.split("\n").slice(0, 6)).toEqual([
    "agents text",
    "Read style rule nested rule.",
    "`@docs/style.md` stays",
    "```",
    "@docs/style.md",
    "```",
  ]);
  expect(text).toContain("@../outside.md @missing.md me@docs.md x x x x x @loop.md");
  expect(text).not.toContain("SECRET");
  // A CLAUDE.md that only imports AGENTS.md counts once.
  const plain = folder({ "AGENTS.md": "agents text", "CLAUDE.md": "@AGENTS.md\n" });
  const trust = createFileTrustStore(join(folder({}), "trust.json"));
  trust.trust(plain);
  expect(loadInstructions(trust, plain, plain)).toEqual(["agents text"]);
});

test("the AGENTS.md and CLAUDE.md of a subfolder come once, with the first file there", () => {
  const ws = folder({
    "AGENTS.md": "root text",
    "pkg/AGENTS.md": "pkg agents",
    "pkg/CLAUDE.md": "@AGENTS.md\n",
    "pkg/api/CLAUDE.md": "api claude",
    "pkg/api/x.ts": "",
    "other/y.ts": "",
  });
  const seen = new Set<string>();
  expect(nestedInstructions(ws, "pkg/api/x.ts", seen)).toBe(
    [
      `Instructions of ${join("pkg", "AGENTS.md")}, for the files of its folder:\npkg agents`,
      `Instructions of ${join("pkg", "api", "CLAUDE.md")}, for the files of its folder:\napi claude`,
    ].join("\n\n"),
  );
  expect(nestedInstructions(ws, join(ws, "pkg", "api", "z.ts"), seen)).toBeUndefined();
  expect(nestedInstructions(ws, "other/y.ts", seen)).toBeUndefined();
  expect(nestedInstructions(ws, "top.ts", seen)).toBeUndefined();
  expect(nestedInstructions(ws, "../outside/a.ts", seen)).toBeUndefined();
});

test("the instructions, commands and agents of opencode.json load, inside the workspace only", () => {
  const parent = folder({ "outside.md": "SECRET OUTSIDE" });
  const ws = join(parent, "ws");
  const files: Record<string, string> = {
    "opencode.jsonc": JSON.stringify({
      instructions: ["CONTRIBUTING.md", "docs/*.md", "../outside.md", "https://x.test/rules.md"],
      command: {
        test: { template: "Run the tests of $ARGUMENTS", description: "Run tests" },
        "bad name": { template: "x" },
      },
      agent: {
        review: {
          description: "Reviews code",
          prompt: "{file:./prompts/review.txt}",
          model: "anthropic/claude-sonnet-5",
          tools: { write: false, edit: false, bash: true },
        },
        build: { mode: "primary", prompt: "You build." },
        quiet: { description: "No prompt" },
        leak: { prompt: "{file:../outside.md}" },
      },
    }),
    "CONTRIBUTING.md": "contributing rule",
    "docs/style.md": "docs style rule",
    "prompts/review.txt": "You review code.",
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(ws, path)), { recursive: true });
    writeFileSync(join(ws, path), text);
  }
  const trust = createFileTrustStore(join(folder({}), "trust.json"));
  trust.trust(ws);
  const text = loadInstructions(trust, ws, ws).join("\n---\n");
  expect(text).toContain("contributing rule");
  expect(text).toContain("docs style rule");
  expect(text).not.toContain("SECRET");

  const commands = loadCommands({ workspaceRoot: ws, configDirOverride: folder({}) });
  expect(commands.map((c) => c.name)).toEqual(["test"]);
  expect(expandCommand(commands[0]?.content ?? "", "api", ws)).toBe("Run the tests of api");
  expect(commands[0]?.description).toBe("Run tests");

  const { agents } = resolveFileRoster({
    workspaceRoot: ws,
    configDirOverride: folder({}),
    configAgents: {},
    seed: false,
  });
  expect(agents.get("review")).toMatchObject({
    description: "Reviews code",
    systemPrompt: "You review code.",
    provider: "anthropic",
    model: "claude-sonnet-5",
    permissions: { write: "deny", edit: "deny", notebook_edit: "deny" },
  });
  expect(agents.has("build")).toBe(false);
  expect(agents.has("quiet")).toBe(false);
  expect(agents.get("leak")?.systemPrompt).toBe("{file:../outside.md}");
});

test("an AGENTS.override.md takes the place of AGENTS.md in its folder, as Codex reads it", () => {
  const ws = folder({
    "AGENTS.md": "plain agents",
    "AGENTS.override.md": "override agents",
    "pkg/AGENTS.md": "pkg agents",
  });
  const trust = createFileTrustStore(join(folder({}), "trust.json"));
  trust.trust(ws);
  expect(loadInstructions(trust, ws, ws)).toEqual(["override agents"]);
  expect(nestedInstructions(ws, "pkg/a.ts", new Set())).toContain("pkg agents");
});

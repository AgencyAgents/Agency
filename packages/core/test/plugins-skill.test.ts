import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/events.ts";
import { loadPlugins } from "../src/plugins/loader.ts";
import {
  discoverSkills,
  parseSkillFrontmatter,
  resolveSkillDirs,
  skillToPlugin,
} from "../src/plugins/skill.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWs(tag: string): string {
  const ws = join(tmpdir(), `agency-skill-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  return ws;
}

function writeSkill(ws: string, name: string, frontmatter: string, body: string): string {
  const dir = join(ws, "skills", name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  const content = frontmatter.length > 0 ? `---\n${frontmatter}\n---\n${body}` : body;
  writeFileSync(file, content, "utf8");
  return file;
}

// ---------------------------------------------------------------------------
// parseSkillFrontmatter
// ---------------------------------------------------------------------------

describe("parseSkillFrontmatter", () => {
  test("parses name and description from frontmatter", () => {
    const text = `---
name: demo
description: A demo skill
---

# Demo Skill

This is the body.`;
    const result = parseSkillFrontmatter(text);
    expect(result.name).toBe("demo");
    expect(result.description).toBe("A demo skill");
    expect(result.body).toContain("# Demo Skill");
    expect(result.body).toContain("This is the body.");
  });

  test("returns full text as body when no frontmatter", () => {
    const text = "# Just a heading\n\nNo frontmatter here.";
    const result = parseSkillFrontmatter(text);
    expect(result.name).toBeUndefined();
    expect(result.description).toBeUndefined();
    expect(result.body).toBe(text);
  });

  test("returns full text as body when only opening ---", () => {
    const text = "---\nname: broken\nno closing delimiter";
    const result = parseSkillFrontmatter(text);
    expect(result.name).toBeUndefined();
    expect(result.body).toBe(text);
  });

  test("handles empty frontmatter", () => {
    const text = "---\n---\nBody content";
    const result = parseSkillFrontmatter(text);
    expect(result.name).toBeUndefined();
    expect(result.description).toBeUndefined();
    expect(result.body.trim()).toBe("Body content");
  });

  test("handles description with colons in value", () => {
    const text = `---
name: my-skill
description: A skill with a colon: in the description
---

Body`;
    const result = parseSkillFrontmatter(text);
    expect(result.name).toBe("my-skill");
    expect(result.description).toBe("A skill with a colon: in the description");
  });

  test("ignores unknown frontmatter fields", () => {
    const text = `---
name: test
version: 1.0.0
author: me
---

Body`;
    const result = parseSkillFrontmatter(text);
    expect(result.name).toBe("test");
    expect(result.description).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// discoverSkills
// ---------------------------------------------------------------------------

describe("discoverSkills", () => {
  test("discovers a single skill from skills/ directory", () => {
    const ws = makeWs("single");
    try {
      writeSkill(ws, "demo", "name: demo\ndescription: A demo", "# Demo\n\nBody content");
      const dirs = [{ dir: join(ws, "skills"), tier: "project" as const }];
      const skills = discoverSkills(dirs);
      expect(skills.length).toBe(1);
      expect(skills[0]!.name).toBe("demo");
      expect(skills[0]!.description).toBe("A demo");
      expect(skills[0]!.body).toContain("Body content");
      expect(skills[0]!.tier).toBe("project");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("discovers skills from .agency/skills/ with project tier", () => {
    const ws = makeWs("agency");
    try {
      const dir = join(ws, ".agency", "skills", "alpha");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), "---\nname: alpha\n---\n# Alpha skill", "utf8");
      const dirs = [{ dir: join(ws, ".agency", "skills"), tier: "project" as const }];
      const skills = discoverSkills(dirs);
      expect(skills.length).toBe(1);
      expect(skills[0]!.name).toBe("alpha");
      expect(skills[0]!.tier).toBe("project");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("skips directories without SKILL.md", () => {
    const ws = makeWs("missing");
    try {
      mkdirSync(join(ws, "skills", "empty"), { recursive: true });
      writeSkill(ws, "real", "name: real", "Real skill");
      const dirs = [{ dir: join(ws, "skills"), tier: "project" as const }];
      const skills = discoverSkills(dirs);
      expect(skills.length).toBe(1);
      expect(skills[0]!.name).toBe("real");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("uses directory name as fallback when frontmatter has no name", () => {
    const ws = makeWs("fallback");
    try {
      writeSkill(ws, "my-fallback", "", "# No frontmatter name");
      const dirs = [{ dir: join(ws, "skills"), tier: "project" as const }];
      const skills = discoverSkills(dirs);
      expect(skills.length).toBe(1);
      expect(skills[0]!.name).toBe("my-fallback");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("deduplicates by name across dirs (first wins)", () => {
    const ws = makeWs("dedup");
    try {
      writeSkill(ws, "dup", "name: dup", "First");
      const agencyDir = join(ws, ".agency", "skills", "dup");
      mkdirSync(agencyDir, { recursive: true });
      writeFileSync(join(agencyDir, "SKILL.md"), "---\nname: dup\n---\nSecond", "utf8");
      const dirs = [
        { dir: join(ws, ".agency", "skills"), tier: "project" as const },
        { dir: join(ws, "skills"), tier: "project" as const },
      ];
      const skills = discoverSkills(dirs);
      // First dir wins: .agency/skills/dup comes first
      expect(skills.length).toBe(1);
      expect(skills[0]!.body).toContain("Second");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("returns empty array when no skills directories exist", () => {
    const ws = makeWs("nonexist");
    try {
      const skills = discoverSkills([{ dir: join(ws, "skills"), tier: "project" as const }]);
      expect(skills).toEqual([]);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// skillToPlugin
// ---------------------------------------------------------------------------

describe("skillToPlugin", () => {
  test("converts skill to PluginDefinition with agentsMd", () => {
    const skill = {
      name: "demo",
      path: "/fake/skills/demo/SKILL.md",
      description: "A demo",
      body: "# Demo\n\nBody content",
      tier: "project" as const,
    };
    const def = skillToPlugin(skill);
    expect(def.id).toBe("demo");
    expect(def.agentsMd).toBe("# Demo\n\nBody content");
    expect(def.hooks).toBeUndefined();
    expect(def.tools).toBeUndefined();
    expect(def.mcpServers).toBeUndefined();
  });

  test("omits agentsMd when body is empty", () => {
    const skill = {
      name: "empty",
      path: "/fake/skills/empty/SKILL.md",
      body: "",
      tier: "user" as const,
    };
    const def = skillToPlugin(skill);
    expect(def.id).toBe("empty");
    expect(def.agentsMd).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveSkillDirs
// ---------------------------------------------------------------------------

describe("resolveSkillDirs", () => {
  test("returns dirs in priority order with correct tiers", () => {
    const ws = "/tmp/test";
    const dirs = resolveSkillDirs(ws, "/custom/config");
    expect(dirs.length).toBe(3);
    expect(dirs[0]!.dir).toBe(join(ws, ".agency", "skills"));
    expect(dirs[0]!.tier).toBe("project");
    expect(dirs[1]!.dir).toBe(join(ws, "skills"));
    expect(dirs[1]!.tier).toBe("project");
    expect(dirs[2]!.dir).toContain("skills");
    expect(dirs[2]!.tier).toBe("user");
  });
});

// ---------------------------------------------------------------------------
// Loader integration
// ---------------------------------------------------------------------------

describe("loader integration with skills", () => {
  test("loads a skill from skills/ directory via loadPlugins", async () => {
    const ws = makeWs("integ");
    try {
      writeSkill(ws, "demo", "name: demo\ndescription: Demo skill", "# Demo\n\nThis is a demo skill body.");
      const bus = new EventBus();
      const result = await loadPlugins({ workspaceRoot: ws, bus });
      const demo = result.plugins.find((p) => p.id === "demo");
      expect(demo).toBeDefined();
      expect(demo!.definition.agentsMd).toContain("This is a demo skill body.");
      expect(demo!.tier).toBe("project");
      expect(result.errors).toEqual([]);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("loads a skill from .agency/skills/ directory", async () => {
    const ws = makeWs("agency-skill");
    try {
      const dir = join(ws, ".agency", "skills", "alpha");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), "---\nname: alpha\n---\n# Alpha skill body", "utf8");
      const bus = new EventBus();
      const result = await loadPlugins({ workspaceRoot: ws, bus });
      const alpha = result.plugins.find((p) => p.id === "alpha");
      expect(alpha).toBeDefined();
      expect(alpha!.definition.agentsMd).toContain("Alpha skill body");
      expect(alpha!.tier).toBe("project");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("skill with no frontmatter still loads (directory name as id)", async () => {
    const ws = makeWs("no-fm");
    try {
      writeSkill(ws, "no-fm-skill", "", "# No frontmatter\n\nJust body.");
      const bus = new EventBus();
      const result = await loadPlugins({ workspaceRoot: ws, bus });
      const skill = result.plugins.find((p) => p.id === "no-fm-skill");
      expect(skill).toBeDefined();
      expect(skill!.definition.agentsMd).toContain("No frontmatter");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("skill coexists with regular JS plugin", async () => {
    const ws = makeWs("coexist");
    try {
      // JS plugin
      mkdirSync(join(ws, ".agency", "plugins"), { recursive: true });
      writeFileSync(
        join(ws, ".agency", "plugins", "myplugin.js"),
        `export const hooks = { "session.created": async () => {} };`,
      );
      // Skill
      writeSkill(ws, "myskill", "name: myskill", "# My skill body");
      const bus = new EventBus();
      const result = await loadPlugins({ workspaceRoot: ws, bus });
      expect(result.plugins.length).toBe(2);
      expect(result.plugins.some((p) => p.id === "myplugin")).toBe(true);
      expect(result.plugins.some((p) => p.id === "myskill")).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("skill instructions appear in result.instructions", async () => {
    const ws = makeWs("instructions");
    try {
      writeSkill(ws, "instruct", "name: instruct", "# Instruction body");
      const bus = new EventBus();
      const result = await loadPlugins({ workspaceRoot: ws, bus });
      expect(result.instructions.some((i) => i.includes("Instruction body"))).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("duplicate skill id (same name as plugin) is skipped with error", async () => {
    const ws = makeWs("dup-id");
    try {
      // JS plugin with id "collide"
      mkdirSync(join(ws, ".agency", "plugins"), { recursive: true });
      writeFileSync(
        join(ws, ".agency", "plugins", "collide.js"),
        `export const hooks = { "session.created": async () => {} };`,
      );
      // Skill with same name
      writeSkill(ws, "collide", "name: collide", "# Colliding skill");
      const bus = new EventBus();
      const result = await loadPlugins({ workspaceRoot: ws, bus });
      // Plugin wins (loaded first), skill is skipped
      expect(result.plugins.some((p) => p.id === "collide")).toBe(true);
      expect(result.errors.some((e) => e.id === "collide" && e.error.includes("duplicate"))).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

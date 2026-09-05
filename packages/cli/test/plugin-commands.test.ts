import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEntrypoint } from "../src/entrypoint.ts";
import { pluginInstallCmd, pluginListCmd, pluginRemoveCmd } from "../src/plugin-commands.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function capture() {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    out: outLines,
    err: errLines,
    deps: {
      out: (line: string) => {
        outLines.push(line);
      },
      err: (line: string) => {
        errLines.push(line);
      },
    },
  };
}

const FIXTURE_DIR = join(import.meta.dir, "fixtures", "test-plugin");

// ---------------------------------------------------------------------------
// plugin install
// ---------------------------------------------------------------------------

describe("plugin install", () => {
  test("installs a plugin and writes a receipt", () => {
    const ws = tempDir("agency-plugin-install-");
    const c = capture();

    const result = pluginInstallCmd(FIXTURE_DIR, ws, false, c.deps.err);

    expect(result).toContain("Plugin: test-plugin v1.2.3");
    expect(result).toContain("Skills installed:");
    expect(result).toContain("my-skill");
    expect(result).toContain("Hooks mapped:");
    expect(result).toContain("SessionStart -> session.start");
    expect(result).toContain("Hooks skipped:");
    expect(result).toContain("UnknownEvent");
    expect(result).toContain("Commands installed:");
    expect(result).toContain("help.md");
    expect(result).toContain("Agents found");
    expect(result).toContain("custom-agent");
    expect(result).toContain("receipt.json");

    // Verify files on disk
    expect(existsSync(join(ws, ".agency", "skills", "my-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(ws, ".agency", "skills", "test-plugin", "receipt.json"))).toBe(true);
    expect(existsSync(join(ws, ".agency", "commands", "help.md"))).toBe(true);

    // Verify receipt contents
    const receiptText = require("node:fs").readFileSync(
      join(ws, ".agency", "skills", "test-plugin", "receipt.json"),
      "utf8",
    );
    const receipt = JSON.parse(receiptText);
    expect(receipt.pluginName).toBe("test-plugin");
    expect(receipt.pluginVersion).toBe("1.2.3");
    expect(receipt.skillsInstalled).toEqual(["my-skill"]);
    expect(receipt.commandsInstalled).toEqual(["help.md"]);
    expect(typeof receipt.installedAt).toBe("string");
  });

  test("overwrite flag allows re-installing", () => {
    const ws = tempDir("agency-plugin-overwrite-");
    // First install
    pluginInstallCmd(FIXTURE_DIR, ws, false, () => {});

    const skillPath = join(ws, ".agency", "skills", "my-skill", "SKILL.md");
    expect(existsSync(skillPath)).toBe(true);

    // Install again without overwrite -- no error
    const { deps } = capture();
    const result2 = pluginInstallCmd(FIXTURE_DIR, ws, false, deps.err);
    expect(result2).toContain("test-plugin");

    // Install again with overwrite
    const result3 = pluginInstallCmd(FIXTURE_DIR, ws, true, deps.err);
    expect(result3).toContain("test-plugin");
    // File should still exist (overwritten)
    expect(existsSync(skillPath)).toBe(true);
  });

  test("prints error for missing source dir", async () => {
    const c = capture();
    const ws = tempDir("agency-plugin-missing-");
    c.deps.cwd = ws;
    const code = await runEntrypoint(["plugin", "install", "/nonexistent/path"], c.deps);
    expect(code).toBe(1);
    expect(c.err.join("\n")).toContain("No valid plugin manifest");
  });

  test("prints usage when source dir is missing", async () => {
    const c = capture();
    const code = await runEntrypoint(["plugin", "install"], c.deps);
    expect(code).toBe(1);
    expect(c.err.join("\n")).toContain("needs a value");
  });
});

// ---------------------------------------------------------------------------
// plugin list
// ---------------------------------------------------------------------------

describe("plugin list", () => {
  test("lists installed skills and modules", () => {
    const ws = tempDir("agency-plugin-list-");

    // Empty workspace shows nothing
    expect(pluginListCmd(ws)).toBe("No plugins or skills installed.");

    // Install a plugin
    pluginInstallCmd(FIXTURE_DIR, ws, false, () => {});

    const list = pluginListCmd(ws);
    expect(list).toContain("my-skill  (skill)");
    expect(list).toContain("test-plugin  (skill)");
  });

  test("shows empty when nothing installed", () => {
    const ws = tempDir("agency-plugin-list-empty-");
    expect(pluginListCmd(ws)).toBe("No plugins or skills installed.");
  });

  test("runEntrypoint plugin list works", async () => {
    const ws = tempDir("agency-plugin-entry-list-");
    pluginInstallCmd(FIXTURE_DIR, ws, false, () => {});

    const c = capture();
    c.deps.cwd = ws;
    const code = await runEntrypoint(["plugin", "list"], c.deps);
    expect(code).toBe(0);
    const text = c.out.join("\n");
    expect(text).toContain("my-skill  (skill)");
  });
});

// ---------------------------------------------------------------------------
// plugin remove
// ---------------------------------------------------------------------------

describe("plugin remove", () => {
  test("removes an installed plugin", () => {
    const ws = tempDir("agency-plugin-remove-");

    // Install
    pluginInstallCmd(FIXTURE_DIR, ws, false, () => {});

    // Verify installed
    expect(existsSync(join(ws, ".agency", "skills", "my-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(ws, ".agency", "commands", "help.md"))).toBe(true);

    // Remove
    const result = pluginRemoveCmd("test-plugin", ws);
    expect(result).toContain("Removed");
    expect(result).toContain("test-plugin");

    // Verify files are gone
    expect(existsSync(join(ws, ".agency", "skills", "test-plugin"))).toBe(false);
    expect(existsSync(join(ws, ".agency", "skills", "my-skill"))).toBe(false);
    expect(existsSync(join(ws, ".agency", "commands", "help.md"))).toBe(false);
  });

  test("errors on unknown plugin name", () => {
    const ws = tempDir("agency-plugin-remove-unknown-");
    expect(() => pluginRemoveCmd("nope", ws)).toThrow("not installed");
  });

  test("remove via runEntrypoint works", async () => {
    const ws = tempDir("agency-plugin-entry-remove-");

    // Install via runEntrypoint
    const ic = capture();
    ic.deps.cwd = ws;
    const installCode = await runEntrypoint(["plugin", "install", FIXTURE_DIR], ic.deps);
    expect(installCode).toBe(0);

    // Verify installed
    expect(existsSync(join(ws, ".agency", "skills", "my-skill", "SKILL.md"))).toBe(true);

    // Remove via runEntrypoint
    const c = capture();
    c.deps.cwd = ws;
    const removeCode = await runEntrypoint(["plugin", "remove", "test-plugin"], c.deps);
    expect(removeCode).toBe(0);
    expect(c.out.join("\n")).toContain("Removed");

    // Verify gone
    expect(existsSync(join(ws, ".agency", "skills", "test-plugin"))).toBe(false);
  });

  test("remove with missing name prints usage", async () => {
    const c = capture();
    const code = await runEntrypoint(["plugin", "remove"], c.deps);
    expect(code).toBe(1);
    expect(c.err.join("\n")).toContain("Usage: agency plugin remove");
  });
});

// ---------------------------------------------------------------------------
// plugin --help
// ---------------------------------------------------------------------------

describe("plugin --help", () => {
  test("plugin --help prints subcommand list", async () => {
    const c = capture();
    const code = await runEntrypoint(["plugin", "--help"], c.deps);
    expect(code).toBe(0);
    const text = c.out.join("\n");
    expect(text).toContain("install");
    expect(text).toContain("list");
    expect(text).toContain("remove");
  });
});

// ---------------------------------------------------------------------------
// HELP text includes plugin commands
// ---------------------------------------------------------------------------

describe("top-level --help", () => {
  test("help text includes plugin commands", async () => {
    const c = capture();
    await runEntrypoint(["--help"], c.deps);
    const text = c.out.join("\n");
    expect(text).toContain("plugin install");
    expect(text).toContain("plugin list");
    expect(text).toContain("plugin remove");
  });
});

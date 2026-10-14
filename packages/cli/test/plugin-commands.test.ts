import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { dataDir } from "@agency/core";
import { createFileTrustStore } from "@agency/guard";
import { runEntrypoint } from "../src/entrypoint.ts";
import { gitSource, pluginInstallCmd, pluginListCmd, pluginRemoveCmd } from "../src/plugin-commands.ts";

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
      cwd: undefined as string | undefined,
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
    expect(result).toContain("Hooks installed (.agency/hooks/test-plugin.json");
    expect(result).toContain("- SessionStart");
    expect(result).toContain("Hooks skipped:");
    expect(result).toContain("UnknownEvent");
    expect(result).toContain("Commands installed:");
    expect(result).toContain("help.md");
    expect(result).toContain("Agents installed");
    expect(result).toContain("custom-agent");
    expect(result).toContain("receipt.json");

    // Verify files on disk
    expect(existsSync(join(ws, ".agency", "skills", "my-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(ws, ".agency", "skills", "test-plugin", "receipt.json"))).toBe(true);
    expect(existsSync(join(ws, ".agency", "commands", "help.md"))).toBe(true);
    expect(existsSync(join(ws, ".agency", "agents", "custom-agent.md"))).toBe(true);
    expect(existsSync(join(ws, ".agency", "hooks", "test-plugin.json"))).toBe(true);

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
    expect(receipt.agentsInstalled).toEqual(["custom-agent"]);
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

  test("a second install says in plain text that the files exist, and names the CLI flag", () => {
    const ws = tempDir("agency-plugin-reinstall-");
    pluginInstallCmd(FIXTURE_DIR, ws, false, () => {});
    const c = capture();
    pluginInstallCmd(FIXTURE_DIR, ws, false, c.deps.err);

    const text = c.err.join("\n");
    expect(text).toContain('skill "my-skill" already exists');
    expect(text).toContain("--overwrite");
    expect(text).not.toContain('{"time"');
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

  test("says that the installed files do not load when the workspace is not trusted", async () => {
    const install = async (trusted: boolean) => {
      const ws = tempDir("agency-plugin-trust-note-");
      if (trusted) createFileTrustStore(join(dataDir(), "trust.json")).trust(ws);
      const c = capture();
      c.deps.cwd = ws;
      const code = await runEntrypoint(["plugin", "install", FIXTURE_DIR], c.deps);
      return { code, note: c.err.join("\n").includes("agency trust") };
    };
    expect({ untrusted: await install(false), trusted: await install(true) }).toEqual({
      untrusted: { code: 0, note: true },
      trusted: { code: 0, note: false },
    });
  });
});

/** A git repository with `files`, committed: the remote of an install. */
function gitRepo(files: Record<string, string>, copyFixtureTo?: string): string {
  const repo = tempDir("agency-plugin-repo-");
  if (copyFixtureTo !== undefined) cpSync(FIXTURE_DIR, join(repo, copyFixtureTo), { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  const git = (...args: string[]) =>
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, stdio: "ignore" });
  git("init", "-q");
  git("add", ".");
  git("commit", "-q", "-m", "plugin");
  return pathToFileURL(repo).href;
}

describe("plugin install from git", () => {
  test("a git URL, owner/repo and #ref are sources; a folder that exists is not", () => {
    const here = tempDir("agency-plugin-local-");
    expect(gitSource(here)).toBeUndefined();
    expect(gitSource("anthropics/claude-plugins")).toEqual({
      url: "https://github.com/anthropics/claude-plugins.git",
    });
    expect(gitSource("https://gitlab.com/a/b.git#v2")).toEqual({
      url: "https://gitlab.com/a/b.git",
      ref: "v2",
    });
    expect(gitSource("git@github.com:a/b.git")).toEqual({ url: "git@github.com:a/b.git" });
    expect(gitSource("/nonexistent/path")).toBeUndefined();
  });

  test("installs the plugin at the root of a repository, and its files stay without .git", async () => {
    const url = gitRepo({}, ".");
    const ws = tempDir("agency-plugin-git-ws-");
    const c = capture();
    c.deps.cwd = ws;
    expect(await runEntrypoint(["plugin", "install", url], c.deps)).toBe(0);
    expect(c.out.join("\n")).toContain("Plugin: test-plugin v1.2.3");
    expect(existsSync(join(ws, ".agency", "skills", "my-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(ws, ".agency", "plugin-roots", "test-plugin", ".git"))).toBe(false);
  });

  test("a marketplace installs the named plugin, needs a name for more than one, and keeps a source inside it", async () => {
    const market = (plugins: unknown[]) =>
      JSON.stringify({ name: "m", owner: { name: "o" }, metadata: { pluginRoot: "./plugins" }, plugins });
    const url = gitRepo(
      {
        ".claude-plugin/marketplace.json": market([
          { name: "test-plugin", source: "./test-plugin" },
          { name: "other", source: "./other" },
          { name: "escape", source: "../../outside" },
        ]),
      },
      "plugins/test-plugin",
    );
    const install = async (...args: string[]) => {
      const ws = tempDir("agency-plugin-market-ws-");
      const c = capture();
      c.deps.cwd = ws;
      const code = await runEntrypoint(["plugin", "install", url, ...args], c.deps);
      return { code, out: c.out.join("\n"), err: c.err.join("\n") };
    };
    const named = await install("test-plugin");
    expect(named.code).toBe(0);
    expect(named.out).toContain("Plugin: test-plugin v1.2.3");

    const unnamed = await install();
    expect(unnamed.code).toBe(1);
    expect(unnamed.err).toContain("test-plugin, other, escape");

    const outside = await install("escape");
    expect(outside.code).toBe(1);
    expect(outside.err).toContain("outside the marketplace");
  });

  test("a Cursor marketplace installs a Cursor plugin with its rule, and remove deletes the rule", async () => {
    const url = gitRepo({
      ".cursor-plugin/marketplace.json": JSON.stringify({
        name: "m",
        plugins: [{ name: "kit", source: "./plugins/kit" }],
      }),
      "plugins/kit/.cursor-plugin/plugin.json": JSON.stringify({ name: "kit" }),
      "plugins/kit/rules/style.mdc": "---\nalwaysApply: true\n---\nUse tabs.",
    });
    const ws = tempDir("agency-plugin-cursor-ws-");
    const c = capture();
    c.deps.cwd = ws;
    expect(await runEntrypoint(["plugin", "install", url], c.deps)).toBe(0);
    expect(c.out.join("\n")).toContain("Rules installed");
    const rule = join(ws, ".agency", "rules", "kit-style.md");
    expect(existsSync(rule)).toBe(true);
    expect(await runEntrypoint(["plugin", "remove", "kit"], c.deps)).toBe(0);
    expect(existsSync(rule)).toBe(false);
  });

  test("a clone that fails says why", async () => {
    const c = capture();
    c.deps.cwd = tempDir("agency-plugin-badurl-ws-");
    const missing = pathToFileURL(join(tempDir("agency-plugin-none-"), "missing")).href;
    expect(await runEntrypoint(["plugin", "install", missing], c.deps)).toBe(1);
    expect(c.err.join("\n")).toContain("git clone of");
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
    expect(list).toContain("test-plugin  (plugin)");
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
    expect(existsSync(join(ws, ".agency", "agents", "custom-agent.md"))).toBe(true);
    expect(existsSync(join(ws, ".agency", "plugin-roots", "test-plugin", "hooks", "hooks.json"))).toBe(true);

    // Remove
    const result = pluginRemoveCmd("test-plugin", ws);
    expect(result).toContain("Removed");
    expect(result).toContain("test-plugin");

    // Verify files are gone
    expect(existsSync(join(ws, ".agency", "skills", "test-plugin"))).toBe(false);
    expect(existsSync(join(ws, ".agency", "skills", "my-skill"))).toBe(false);
    expect(existsSync(join(ws, ".agency", "commands", "help.md"))).toBe(false);
    expect(existsSync(join(ws, ".agency", "agents", "custom-agent.md"))).toBe(false);
    // Its hook commands and the copy of its files go too: a removed plugin must not run a command.
    expect(existsSync(join(ws, ".agency", "hooks", "test-plugin.json"))).toBe(false);
    expect(existsSync(join(ws, ".agency", "plugin-roots", "test-plugin"))).toBe(false);
  });

  test("refuses to remove one skill of a plugin, and names the plugin", () => {
    const ws = tempDir("agency-plugin-remove-skill-");
    pluginInstallCmd(FIXTURE_DIR, ws, false, () => {});

    expect(() => pluginRemoveCmd("my-skill", ws)).toThrow("agency plugin remove test-plugin");
    expect(existsSync(join(ws, ".agency", "skills", "my-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(ws, ".agency", "skills", "test-plugin", "receipt.json"))).toBe(true);
  });

  test("errors on unknown plugin name", () => {
    const ws = tempDir("agency-plugin-remove-unknown-");
    expect(() => pluginRemoveCmd("nope", ws)).toThrow("not installed");
  });

  test("a name that is a path deletes nothing, from the command line or from a receipt", () => {
    const ws = tempDir("agency-plugin-remove-path-");
    const receiptDir = join(ws, ".agency", "skills", "p");
    mkdirSync(receiptDir, { recursive: true });
    writeFileSync(join(ws, "keep.txt"), "keep");
    writeFileSync(join(ws, "keep.md"), "keep");
    writeFileSync(
      join(receiptDir, "receipt.json"),
      JSON.stringify({
        pluginName: "../..",
        skillsInstalled: ["../.."],
        commandsInstalled: ["../../keep.txt"],
        agentsInstalled: ["../../keep"],
        installedAt: "",
      }),
    );
    for (const name of ["..", "..\\..", "a/b", ""]) {
      expect(() => pluginRemoveCmd(name, ws)).toThrow("not a plugin name");
    }
    pluginRemoveCmd("p", ws);
    expect(existsSync(join(ws, "keep.txt"))).toBe(true);
    expect(existsSync(join(ws, "keep.md"))).toBe(true);
    expect(existsSync(receiptDir)).toBe(false);
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

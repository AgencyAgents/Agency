import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig, loadHookFiles } from "@agency/core";
import { harnessImportCmd } from "../src/import-commands.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "agency-import-"));
  dirs.push(dir);
  return dir;
};

const put = (file: string, value: unknown): void => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
};

test("agency import shows the sets of other agents and imports each that the user takes", async () => {
  const home = tempDir();
  const config = tempDir();
  put(join(home, ".claude", "settings.json"), {
    env: { CODE_GRAPH_QUIET_HOOKS: "1" },
    model: "opus",
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "rtk hook claude" }] }] },
  });
  put(join(home, ".claude", "CLAUDE.md"), "Be brief.");
  put(join(home, ".cursor", "mcp.json"), { mcpServers: { docs: { url: "https://d.test/mcp" } } });
  const env = { ...process.env, AGENCY_AGENTS_HOME: home };
  const run = async (opts: { yes?: boolean; dryRun?: boolean; answers?: boolean[] }) => {
    const out: string[] = [];
    const answers = opts.answers;
    await harnessImportCmd({
      configDir: config,
      env,
      yes: opts.yes ?? false,
      dryRun: opts.dryRun ?? false,
      confirm: answers === undefined ? undefined : async () => answers.shift() ?? false,
      out: (line) => out.push(line),
    });
    return out.join("\n");
  };

  const shown = await run({ dryRun: true });
  expect(shown).toContain("MCP servers of cursor");
  expect(shown).toContain("PreToolUse Bash: rtk hook claude");
  expect(shown).toContain('model "opus"');
  expect(existsSync(join(config, "mcp"))).toBe(false);

  // No to the MCP servers, yes to the hooks and the instructions.
  await run({ answers: [false, true, true] });
  expect(existsSync(join(config, "mcp", "cursor.json"))).toBe(false);
  const hooks = loadHookFiles(join(config, "plugin-store", ".agency", "hooks"));
  const entry = hooks.PreToolUse?.[0]?.hooks[0];
  expect(entry?.type === "command" && entry.command).toBe("rtk hook claude");
  expect(entry?.type === "command" && entry.env).toEqual({ CODE_GRAPH_QUIET_HOOKS: "1" });
  expect(loadConfig({ globalDir: config, env }).userAgentInstructions).toBe(true);

  // Only what was left is asked again; after it, nothing.
  const again = await run({ yes: true });
  expect(again).toContain("MCP servers of cursor");
  expect(again).not.toContain("Hooks of");
  expect(JSON.parse(readFileSync(join(config, "mcp", "cursor.json"), "utf8")).mcpServers.docs.url).toBe(
    "https://d.test/mcp",
  );
  expect(await run({ yes: true })).toContain("Nothing of another agent to import.");
});

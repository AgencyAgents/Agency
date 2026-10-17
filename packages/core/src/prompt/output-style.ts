import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { configDir, foreignHome, userPluginStore } from "../paths.ts";
import { splitFrontmatter } from "../plugins/skill.ts";

/**
 * The output style that `outputStyle` of the config names, as one instruction. A style is a Markdown file, as in
 * Claude Code: `.agency/output-styles/` and `.claude/output-styles/` of a trusted workspace, then those of the user.
 * ponytail: the style joins the instructions and never takes the place of the base prompt, also with
 * `keep-coding-instructions: false`.
 */
export function outputStyleInstructions(options: {
  name: string | undefined;
  workspaceRoot: string;
  configDirOverride?: string;
  projectTrusted: boolean;
  warn?: (message: string) => void;
}): string[] {
  const { name, workspaceRoot } = options;
  if (name === undefined || name.toLowerCase() === "default") return [];
  const home = foreignHome();
  const dirs = [
    ...(options.projectTrusted
      ? [join(workspaceRoot, ".agency", "output-styles"), join(workspaceRoot, ".claude", "output-styles")]
      : []),
    join(options.configDirOverride ?? configDir(), "output-styles"),
    join(userPluginStore(options.configDirOverride), ".agency", "output-styles"),
    ...(home === undefined ? [] : [join(home, ".claude", "output-styles")]),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir).sort()) {
      if (!entry.endsWith(".md")) continue;
      const { fields, body } = splitFrontmatter(readFileSync(join(dir, entry), "utf8"));
      const styleName = fields.name?.replace(/^["']|["']$/g, "") || basename(entry, ".md");
      if (styleName.toLowerCase() !== name.toLowerCase()) continue;
      return [`Output style "${styleName}": write each reply in this style.\n${body.trim()}`];
    }
  }
  options.warn?.(`no output style "${name}" in ${dirs.join(", ")}`);
  return [];
}

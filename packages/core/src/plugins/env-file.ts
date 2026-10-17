/**
 * The variables of a `CLAUDE_ENV_FILE`: its `export NAME=value`, `declare -x NAME="value"` and `NAME=value` lines, with
 * `$NAME` and `${NAME}` taken from `base` and the lines before. ponytail: Claude Code runs the file as shell code
 * before each command; a line that is not an assignment (`source`, `nvm use`) is skipped here.
 */
export function parseEnvFile(text: string, base: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  // Windows names a variable with any case: `PATH` is `Path` of the environment.
  const keyOf = (name: string): string =>
    process.platform !== "win32"
      ? name
      : (Object.keys({ ...base, ...out }).find((key) => key.toUpperCase() === name.toUpperCase()) ?? name);
  const lookup = (name: string): string => {
    const key = keyOf(name);
    return out[key] ?? base[key] ?? "";
  };
  const expand = (value: string): string =>
    value.replace(/\$(?:\{(\w+)\}|(\w+))/g, (_, braced?: string, bare?: string) =>
      lookup(braced ?? bare ?? ""),
    );
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+|declare\s+-x\s+)?([A-Za-z_]\w*)=(.*?)\s*$/.exec(line);
    if (!match) continue;
    const [, name = "", raw = ""] = match;
    let value: string;
    if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) value = raw.slice(1, -1);
    else if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
      // `\$` is a dollar sign, not a variable.
      const inner = raw.slice(1, -1).replaceAll("\\$", "\u0000");
      value = expand(inner)
        .replaceAll("\u0000", "$")
        .replace(/\\(["\\`])/g, "$1");
    } else value = expand(raw);
    out[keyOf(name)] = value;
  }
  return out;
}

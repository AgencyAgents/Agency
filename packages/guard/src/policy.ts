import { relative, resolve } from "node:path";
import { scopeMatchesPattern } from "./capabilities.ts";
import { fromMsysPath, PROTECTED_PATHS } from "./sandbox.ts";
import type { TrustStore } from "./trust.ts";

/**
 * One permission verdict. The `allow | ask | deny` triad:
 * `allow` runs without asking, `ask` routes through the approval callback
 * (once / always / reject), `deny` refuses, and, at the tool-list level, a
 * bare `deny` means the tool is never even offered to the model.
 */
export type Decision = "allow" | "ask" | "deny";

/** How risky a tool is by nature; drives default decisions and the trust gate. */
export type RiskTier = "safe" | "moderate" | "dangerous";

/** Non-interactive permission mode. `ask` is the default; the others are
 *  chosen only via the explicit `--permission-mode` flag, never silently.
 *  `auto` allows edits as `allow-edits` does, and a reviewer model answers the other asks of a default rule. */
export const PERMISSION_MODES = ["ask", "plan", "allow-edits", "auto", "allow-all", "deny"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** Tools `allow-edits` and `auto` auto-allow: file mutations, not command execution. */
const EDIT_TOOLS: ReadonlySet<string> = new Set(["write", "edit", "notebook_edit"]);
/** The ask source of a write to a file that runs outside the sandbox later: only the user answers it, never a reviewer. */
export const PROTECTED_SOURCE = "protected:";

export interface PolicyRequest {
  tool: string;
  /** Requested path (workspace-relative for rules built from permissions config). */
  path?: string;
  /** Raw command string as the model wrote it. */
  command?: string;
  /** Arity-normalized command (see `normalizeCommand`); rules match either form. */
  normalizedCommand?: string;
}

export interface PolicyRule {
  /** Tool name, or "*" to match any. */
  tool: string;
  /** Glob-ish match against the request's path, when present. */
  pathGlob?: string;
  /** Regex source matched against the request's command (and its normalized form). */
  commandPattern?: string;
  decision: Decision;
}

/** A single tool's permission entry: a bare decision or a pattern map. */
export type ToolPermissionValue = Decision | Record<string, Decision>;

/** Well-known key gating real git writes. Bare decisions only; maps fail closed. */
export const GIT_WRITE_PERMISSION_KEY = "git_write" as const;
/** Absent, mapped, or unknown entries deny, preserving no-git-write today. */
export const GIT_WRITE_DEFAULT: Decision = "deny";

/** Reads the git_write entry fail-closed: only a bare allow|ask|deny wins. */
export function gitWriteDecision(permissions?: Record<string, ToolPermissionValue>): Decision {
  const entry = permissions?.[GIT_WRITE_PERMISSION_KEY];
  if (entry === "allow" || entry === "ask" || entry === "deny") return entry;
  return GIT_WRITE_DEFAULT;
}

/** Everything one tool-call needs for a permission verdict. */
export interface ToolCallPolicyRequest {
  tool: string;
  riskTier?: RiskTier;
  /** Raw path argument as the model wrote it (relative or absolute). */
  path?: string;
  /** Raw command argument (bash). */
  command?: string;
  /** What an ask shows when the tool has no command and no path. No rule reads it. */
  title?: string;
}

/**
 * The seam the agent loop consults before running a tool. Implemented by
 * `PermissionsGate`; the loop accepts any structural implementation so tests
 * can substitute fakes.
 */
export interface ToolPolicy {
  check(
    request: ToolCallPolicyRequest,
    ask: ((request: ApprovalRequestLike) => Promise<"once" | "always" | "reject">) | undefined,
  ): Promise<"allow" | "deny">;
  /** The tool result for a refused call, when the refusal has a cause the model can act on. */
  denyReason?(request: ToolCallPolicyRequest): string | undefined;
}

/** Structural stand-in for the approval callback type (avoids an import cycle). */
export interface ApprovalRequestLike {
  tool: string;
  title: string;
  command?: string;
  path?: string;
  riskTier?: RiskTier;
  source?: string;
  /** Why a shell command is not read-only (`readOnlyRefusal`). */
  reason?: string;
  metadata?: Record<string, unknown>;
}

/** Tools whose pattern maps match path arguments (workspace-relative). */
const PATH_PATTERN_TOOLS = new Set(["write", "edit", "notebook_edit", "read", "execute_plan"]);
/** Tools whose pattern maps match command strings. */
const COMMAND_PATTERN_TOOLS = new Set(["bash"]);

/**
 * First-party orchestration tools. They spawn bounded subagent turns (budgets,
 *  depth bounds, and per-agent gates are the controls), so the gate allows them
 *  by default in workspaces where mutating tools may run. Explicit config
 *  entries still win (including `deny`), per-agent maps still filter unlisted
 *  tools, and the trust gate in `check` still denies them in untrusted
 *  workspaces; this allow is unreachable there.
 */
const ORCHESTRATION_TOOLS: ReadonlySet<string> = new Set(["dispatch", "spawn"]);

/** Moderate-tier tools that only read: plan mode keeps them, still asking as `ask` does. */
const PLAN_WEB_TOOLS: ReadonlySet<string> = new Set(["fetch", "websearch"]);

/** Safe-tier tools that write state a later session reads: plan mode refuses them with the writes. */
const PLAN_REFUSED_SAFE: ReadonlySet<string> = new Set(["memory"]);

const DECISION_RANK: Record<Decision, number> = { allow: 0, ask: 1, deny: 2 };

export function isPathPatternTool(tool: string): boolean {
  return PATH_PATTERN_TOOLS.has(tool);
}

export function isCommandPatternTool(tool: string): boolean {
  return COMMAND_PATTERN_TOOLS.has(tool);
}

/**
 * Command arity table: how many words of a command to keep when normalizing
 * (`git` → 2, so `git checkout main` normalizes to `git checkout`). This lets
 * exact patterns like `git checkout` match regardless of branch names, and is
 * deliberately textual (no tree-sitter, no shell parser). Regex against a raw
 * string is trivially bypassed by `eval`, `$(...)`, `;`; a full parser is
 * overkill. This is the right amount of machinery.
 */
export const COMMAND_ARITY: Readonly<Record<string, number>> = {
  git: 2,
  gh: 2,
  npm: 2,
  npx: 2,
  pnpm: 2,
  yarn: 2,
  bun: 2,
  bunx: 2,
  deno: 2,
  cargo: 2,
  go: 2,
  rustup: 2,
  pip: 2,
  pip3: 2,
  uv: 2,
  uvx: 2,
  docker: 2,
  kubectl: 2,
  helm: 2,
  terraform: 2,
  biome: 2,
  rm: 2,
  mv: 2,
  cp: 2,
  ln: 2,
  mkdir: 2,
  chmod: 2,
  chown: 2,
  rg: 2,
  grep: 2,
  find: 2,
  sed: 2,
  curl: 2,
  wget: 2,
  ssh: 2,
  scp: 2,
  rsync: 2,
  tar: 2,
  apt: 2,
  brew: 2,
};

/**
 * Keeps at most `arity` whitespace-separated words of `command` (the command
 * word itself counts: `git` → 2 keeps `git checkout` from `git checkout main`).
 * Commands whose first word isn't in the table are returned trimmed as-is.
 */
export function normalizeCommand(
  command: string,
  arity: Readonly<Record<string, number>> = COMMAND_ARITY,
): string {
  const words = command
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  const first = words[0];
  if (words.length === 0 || first === undefined) return "";
  const keep = arity[first];
  if (keep === undefined) return words.join(" ");
  return words.slice(0, keep).join(" ");
}

/**
 * The simple commands of a shell command line, split at `;`, `&`, `|` and line ends outside quotes.
 * `dynamic` is true when the line has a command substitution or a process substitution.
 */
export function splitCommand(command: string): { parts: string[]; dynamic: boolean } {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let dynamic = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string;
    const next = command[i + 1];
    if (ch === "\\" && quote !== "'") {
      current += ch + (next ?? "");
      i += 1;
      continue;
    }
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      // In double quotes the shell still runs a substitution.
      else if (quote === '"' && (ch === "`" || (ch === "$" && next === "("))) dynamic = true;
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "`" || ((ch === "$" || ch === "<" || ch === ">") && next === "(")) dynamic = true;
    // A here-document, a here-string and `$'..'` hold text that this splitter does not read as the shell does.
    else if ((ch === "<" && next === "<") || (ch === "$" && next === "'")) dynamic = true;
    // `2>&1` and `&>file` are redirections, not the end of a command.
    const redirection = ch === "&" && (command[i - 1] === ">" || next === ">");
    if ((ch === ";" || ch === "|" || ch === "\n" || ch === "&") && !redirection) {
      if (current.trim() !== "") parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim() !== "") parts.push(current.trim());
  // `$TOOL args`: the program is a variable, so no rule saw its name.
  if (parts.some((part) => part.startsWith("$"))) dynamic = true;
  return { parts, dynamic };
}

/**
 * True for a command that deletes work or history with no way back. A rule with a pattern (`git *`) does not allow
 * such a command: it asks. The list is small and fixed, after the dangerous-command check of Codex.
 */
export function isDestructiveCommand(command: string): boolean {
  const words = command.trim().split(/\s+/);
  const program = (words[0] ?? "").toLowerCase();
  const args = words.slice(1);
  const text = ` ${args.join(" ")} `;
  const short = (letter: string): boolean =>
    args.some((arg) => /^-[A-Za-z]+$/.test(arg) && arg.includes(letter));
  if (program === "rm") return short("r") || short("R") || args.includes("--recursive");
  if (program === "git") {
    if (/\sreset\s.*--hard\s/.test(text)) return true;
    if (/\sclean\s/.test(text) && (short("f") || args.includes("--force"))) return true;
    if (/\spush\s/.test(text))
      return short("f") || short("d") || /\s(--force\S*|--delete|\+\S+|:\S+)\s/.test(text);
    // These throw away changes that no commit holds: `git checkout <branch>` and `git restore --staged` do not.
    if (/\scheckout\s/.test(text)) return /\s(--|\.|-f|--force)\s/.test(text);
    if (/\srestore\s/.test(text)) return !/\s(--staged|-S)\s/.test(text) || /\s(--worktree|-W)\s/.test(text);
    if (/\sstash\s(drop|clear)\s/.test(text)) return true;
    return /\sbranch\s(.*\s)?-D\s/.test(text);
  }
  if (program === "find") return args.includes("-delete");
  if (["del", "erase", "rd", "rmdir"].includes(program)) return /\s\/s\s/i.test(text);
  if (["remove-item", "ri"].includes(program)) return /\s-r(ecurse)?\s/i.test(text);
  return ["dd", "shred", "mkfs", "format", "diskpart"].includes(program) || program.startsWith("mkfs.");
}

const WRAPPERS: ReadonlySet<string> = new Set([
  "sudo",
  "env",
  "command",
  "nohup",
  "time",
  "exec",
  "nice",
  "xargs",
  "builtin",
  "noglob",
]);
/** Options of a wrapper that take a value in the next word. */
const VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-n",
  "-P",
  "-I",
  "-L",
  "-s",
  "-d",
  "-E",
  "-a",
  "-u",
  "-g",
]);
/** What can stand before a command in a group, a subshell or a control structure. */
const SHELL_PREFIX = /^(?:[({!]|(?:if|then|else|elif|do|while|until)\b)\s*(\S[\s\S]*)$/;
/** `a) cmd` and `case x in a) cmd`: the command of a case arm. */
const CASE_ARM = /^(?:case\b[\s\S]*?\bin\s+)?[^\s()]*\)\s*(\S[\s\S]*)$/;
/** `f() { cmd` and `function f { cmd`: the first command of a function body. */
const FUNCTION_BODY = /^(?:function\s+)?[A-Za-z_][\w-]*\s*(?:\(\))?\s*\{\s*(\S[\s\S]*)$/;
const SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "cmd", "powershell", "pwsh"]);
const MAX_UNWRAP_DEPTH = 8;

/**
 * The forms of one simple command that the rules must see: itself, the command behind a wrapper
 * (`sudo`, `env A=1`), its program without a folder or `.exe`, and the commands of `sh -c "..."`.
 */
export function unwrapCommand(command: string, depth = 0): string[] {
  const forms = [command];
  if (depth > MAX_UNWRAP_DEPTH) return forms;
  for (const pattern of [SHELL_PREFIX, CASE_ARM, FUNCTION_BODY]) {
    const inner = pattern.exec(command.trim())?.[1];
    if (inner !== undefined) forms.push(...unwrapCommand(inner, depth + 1));
  }
  const words = command.trim().split(/\s+/);
  const program = (words[0] ?? "").replace(/^.*[\\/]/, "").replace(/\.(exe|cmd|bat|com)$/i, "");
  if (program === "") return forms;
  const rest = words.slice(1);
  if (program !== words[0]) forms.push(...unwrapCommand([program, ...rest].join(" "), depth + 1));
  // `A=1 cmd`: the assignment is not the command.
  else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(program)) forms.push(...unwrapCommand(rest.join(" "), depth + 1));
  else if (WRAPPERS.has(program)) {
    let i = 0;
    while (i < rest.length && (rest[i]?.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[i] ?? "")))
      i += VALUE_OPTIONS.has(rest[i] ?? "") ? 2 : 1;
    forms.push(...unwrapCommand(rest.slice(i).join(" "), depth + 1));
  } else if (program === "timeout" || program === "stdbuf") {
    // `timeout -k 2 30 cmd`, `stdbuf -o L cmd`: the command comes after the options, and after the duration of timeout.
    const valued = program === "timeout" ? ["-s", "-k", "--signal", "--kill-after"] : ["-i", "-o", "-e"];
    let i = 0;
    while (i < rest.length && rest[i]?.startsWith("-")) i += valued.includes(rest[i] ?? "") ? 2 : 1;
    if (program === "timeout") i += 1;
    forms.push(...unwrapCommand(rest.slice(i).join(" "), depth + 1));
  } else if (program === "find") {
    // `-exec cmd {} ;`: the words after the option are a command.
    rest.forEach((word, i) => {
      if (/^-(exec|execdir|ok|okdir)$/.test(word))
        forms.push(...unwrapCommand(rest.slice(i + 1).join(" "), depth + 1));
    });
  } else if (SHELLS.has(program.toLowerCase()) || program === "eval") {
    const flag = rest.findIndex((word) => /^(-[a-z]*c|\/c|\/r|-command)$/i.test(word));
    const script =
      program === "eval"
        ? rest.join(" ").trim()
        : flag === -1
          ? ""
          : rest
              .slice(flag + 1)
              .join(" ")
              .trim();
    const quoted = /^(["'])([\s\S]*)\1$/.exec(script);
    for (const part of splitCommand(quoted ? (quoted[2] ?? "") : script).parts) {
      forms.push(...unwrapCommand(part, depth + 1));
    }
  }
  return forms.filter((form) => form.trim() !== "");
}

/** Programs that read the files that their words name. */
const READ_COMMANDS: ReadonlySet<string> = new Set([
  "cat",
  "tac",
  "head",
  "tail",
  "less",
  "more",
  "nl",
  "wc",
  "sort",
  "uniq",
  "cut",
  "diff",
  "strings",
  "xxd",
  "od",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "sed",
  "awk",
  "type",
  "get-content",
  "gc",
]);
/** Of these, the first word that is no option is a pattern or a script, unless an option gave it. */
const PATTERN_FIRST: ReadonlySet<string> = new Set(["grep", "egrep", "fgrep", "rg", "sed", "awk"]);
const PATTERN_OPTIONS: ReadonlySet<string> = new Set(["-e", "-f", "--regexp", "--expression", "--file"]);
/** Options of a read program that take a value in the next word: the value is no file. */
const VALUE_OPTIONS_OF: Record<string, readonly string[]> = {
  head: ["-n", "-c"],
  tail: ["-n", "-c"],
  grep: ["-e", "-f", "-m", "-A", "-B", "-C", "--regexp", "--file"],
  egrep: ["-e", "-f", "-m", "-A", "-B", "-C"],
  fgrep: ["-e", "-f", "-m", "-A", "-B", "-C"],
  rg: ["-e", "-f", "-m", "-A", "-B", "-C", "-g", "-t", "--regexp", "--file"],
  sed: ["-e", "-f", "--expression", "--file"],
  awk: ["-f", "-v"],
  cut: ["-d", "-f", "-c", "-b"],
  sort: ["-k", "-t", "-o"],
};

/** The words of one simple command, with its quotes taken away. */
function shellWords(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let started = false;
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string;
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (ch === "\\" && i + 1 < command.length) {
      current += command[i + 1];
      started = true;
      i += 1;
    } else if (/\s/.test(ch)) {
      if (started) words.push(current);
      current = "";
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (started) words.push(current);
  return words;
}

/**
 * The files that a shell command line names to read or to write, best effort, so that Read and Edit deny rules hold
 * for them as in Claude Code: the files of `cat`, `head`, `grep`... and of `< file`; of `tee`, `sed -i`, `> file`.
 * A path is taken as the command wrote it: a `cd` earlier in the line is not followed.
 */
export function shellFileTargets(command: string): { reads: string[]; writes: string[] } {
  const reads: string[] = [];
  const writes: string[] = [];
  for (const part of splitCommand(command).parts) {
    for (const form of unwrapCommand(part)) {
      const words = shellWords(form);
      const argv: string[] = [];
      for (let i = 0; i < words.length; i++) {
        const redirect = /^(\d*|&)(>>?|<)(.*)$/.exec(words[i] as string);
        if (redirect === null) {
          argv.push(words[i] as string);
          continue;
        }
        const target = redirect[3] || words[++i] || "";
        if (target === "" || target.startsWith("&") || /^(\/dev\/null|nul)$/i.test(target)) continue;
        (redirect[2] === "<" ? reads : writes).push(target);
      }
      const program = (argv[0] ?? "")
        .replace(/^.*[\\/]/, "")
        .replace(/\.exe$/i, "")
        .toLowerCase();
      const files: string[] = [];
      let patternGiven = !PATTERN_FIRST.has(program);
      for (let i = 1; i < argv.length; i++) {
        const word = argv[i] as string;
        if (PATTERN_OPTIONS.has(word)) patternGiven = true;
        if (VALUE_OPTIONS_OF[program]?.includes(word)) i += 1;
        else if (word.startsWith("-")) continue;
        else if (!patternGiven) patternGiven = true;
        else files.push(word);
      }
      if (program === "tee") writes.push(...files);
      else if (READ_COMMANDS.has(program)) {
        reads.push(...files);
        if (program === "sed" && argv.some((word) => /^-i/.test(word) || word === "--in-place"))
          writes.push(...files);
      }
    }
  }
  return { reads: [...new Set(reads)], writes: [...new Set(writes)] };
}

/**
 * Programs that only read and print, after the read-only set of Claude Code. Each one with a way to write, run a
 * program or reach a hidden file has a rule below.
 */
const READ_ONLY_PROGRAMS: ReadonlySet<string> = new Set([
  ..."ls dir cat echo printf pwd head tail grep egrep fgrep rg find wc which diff stat du cd file tree sort".split(
    " ",
  ),
  ..."cut uniq tr nl tac basename dirname realpath strings od xxd true false test date whoami id uname".split(
    " ",
  ),
  ..."hostname sha1sum sha256sum sha512sum md5sum cksum jq git sed awk rev fold comm paste column expr seq".split(
    " ",
  ),
  ..."readlink df ps tasklist type".split(" "),
  // PowerShell's own read-only commands; `ls`, `cat` and `dir` are its aliases of the first two.
  ..."get-childitem gci get-content gc select-string sls get-location test-path resolve-path get-item".split(
    " ",
  ),
  ..."measure-object write-output".split(" "),
]);
/** Programs that are read-only only as `--version` and the like. */
const VERSION_ONLY: ReadonlySet<string> = new Set(
  "node bun deno python python3 py npm pnpm yarn npx cargo rustc go java dotnet tsc biome".split(" "),
);
/** Short options with which a program writes a file, runs a command, waits forever or reads hidden files. */
const UNSAFE_SHORT: Record<string, RegExp> = {
  find: /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/,
  sort: /^-[a-zA-Z]*o/,
  rg: /^-[a-zA-Z]*[uz.]/,
  grep: /^-[a-zA-Z]*[rRd]/,
  egrep: /^-[a-zA-Z]*[rRd]/,
  fgrep: /^-[a-zA-Z]*[rRd]/,
  diff: /^-[a-zA-Z]*r/,
  file: /^-[a-zA-Z]*[mfC]/,
  tree: /^-[a-zA-Z]*o/,
  git: /^-[a-zA-Z]*O/,
  sed: /^-[a-zA-Z]*[ifs]/,
  tail: /^-[a-zA-Z0-9]*[fF]/,
  xxd: /^-[a-zA-Z]*r/,
  date: /^-[a-zA-Z]*s/,
};
/** The same as long options. GNU programs take any unambiguous prefix (`--in` for `--in-place`), so a prefix counts. */
const UNSAFE_LONG: Record<string, string[]> = {
  sort: ["output", "compress-program"],
  rg: [
    "pre",
    "pre-glob",
    "hidden",
    "no-ignore",
    "no-ignore-vcs",
    "unrestricted",
    "search-zip",
    "hostname-bin",
  ],
  grep: ["recursive", "dereference-recursive", "directories"],
  egrep: ["recursive", "dereference-recursive", "directories"],
  fgrep: ["recursive", "dereference-recursive", "directories"],
  diff: ["recursive"],
  file: ["magic-file", "files-from", "compile"],
  git: ["output", "ext-diff", "open-files-in-pager", "textconv", "exec"],
  sed: ["in-place", "file", "separate"],
  tail: ["follow"],
  xxd: ["revert"],
  date: ["set"],
};
/** Files that hold keys or tokens: the read tool does not give them by default either. */
const SECRET_FILE =
  /(^|[/:\\])(\.env|\.npmrc|\.netrc|\.pypirc|\.git-credentials|\.aws[/\\]|\.ssh[/\\]|id_(rsa|dsa|ecdsa|ed25519))/i;
const SECRET_NAMES = [
  ".env",
  ".env.local",
  ".npmrc",
  ".netrc",
  ".pypirc",
  ".git-credentials",
  "id_rsa",
  "id_ed25519",
];
/** Options of grep and rg whose value is the next word, so that word is not the pattern. */
const VALUE_OPTION =
  /^-[gtTmABCMj]$|^--(glob|iglob|type|type-not|max-count|context|after-context|before-context)$/;
/** Programs whose first word is a pattern or a program text, not a file. */
const PATTERN_PROGRAMS: ReadonlySet<string> = new Set(["grep", "egrep", "fgrep", "rg", "sed", "awk", "jq"]);
/** Programs whose second file argument is an output file (`uniq in out`), with their options that take a value. */
const ONE_FILE: Record<string, string[]> = {
  uniq: ["-f", "-s", "-w"],
  xxd: ["-s", "-l", "-c", "-g", "-o", "-n"],
};
/** A sed command that only prints, deletes from the output or substitutes, after an optional address. The `w`, `e`, `r`
 *  and `R` commands of GNU sed write, run and read other files. */
const SED_COMMAND =
  /^(?:(?:\d+|\$|\/(?:\\.|[^/])*\/)(?:,(?:\d+|\$|\/(?:\\.|[^/])*\/))?)?\s*(?:[pdq=]|s(.)(?:\\.|(?!\1).)*\1(?:\\.|(?!\1).)*\1[gIip0-9]*|y(.)(?:\\.|(?!\2).)*\2(?:\\.|(?!\2).)*\2)$/;
const READ_ONLY_GIT: ReadonlySet<string> = new Set(
  "status diff log show rev-parse ls-files blame describe shortlog grep branch rev-list ls-tree cat-file merge-base".split(
    " ",
  ),
);
const GIT_BRANCH_LIST =
  /^(-a|-r|-v|-vv|--all|--remotes|--verbose|--list|--show-current|--merged|--no-merged|--sort=.+|--format=.+)$/;
/** git's own options before the subcommand that change nothing. */
const GIT_QUIET = /^(--no-pager|-P|--no-optional-locks)$/;

/** An absolute path of the workspace, in Windows or MSYS form (`/c/...`): the shell reads both. */
function inWorkspace(word: string, workspaceRoot: string | undefined): boolean {
  if (!workspaceRoot) return false;
  const norm = (path: string) =>
    path
      .replace(/^\/([a-zA-Z])(\/|$)/, "$1:/")
      .replace(/\\/g, "/")
      .replace(/\/+$/, "")
      .toLowerCase();
  const root = norm(workspaceRoot);
  const path = norm(word);
  return path === root || path.startsWith(`${root}/`);
}

/**
 * The first character the shell would not read as plain text, outside single quotes. Single quotes hold text only;
 * double quotes still expand `$`, a backquote and `\`. Unquoted, `~` expands only at the start of a word.
 */
function shellSyntax(command: string): string | undefined {
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string;
    if (quote === "'") {
      if (ch === "'") quote = undefined;
    } else if (quote === '"') {
      if (ch === '"') quote = undefined;
      else if ("$`\\".includes(ch)) return ch;
    } else if (ch === "'" || ch === '"') quote = ch;
    else if ("$`\\(){}!#@".includes(ch)) return ch;
    else if (ch === "~" && (i === 0 || /[\s=:]/.test(command[i - 1] as string))) return ch;
  }
  return undefined;
}

/** True when `arg` is a long option that names one of `options`, whole or as the prefix the program accepts. */
function longOption(arg: string, options: string[] | undefined): boolean {
  if (!options || !arg.startsWith("--")) return false;
  const name = arg.slice(2).split("=")[0] ?? "";
  // `--no-ignore-dot` is one of the `--no-ignore` family.
  return name !== "" && options.some((option) => option.startsWith(name) || name.startsWith(option));
}

/**
 * Why a command line is not read-only, or undefined when it only reads files of the workspace and can run without a
 * prompt as in Claude Code. Text this check cannot read for sure asks: `$`, a path out of `workspaceRoot`, `..`, a
 * `.env` file, a PowerShell drive such as `env:`.
 */
export function readOnlyRefusal(command: string, workspaceRoot?: string): string | undefined {
  if (command.length > 10_000) return "the command is too long to check";
  const syntax = shellSyntax(command);
  if (syntax !== undefined) return `it uses \`${syntax}\`, which the shell expands`;
  const { parts, dynamic } = splitCommand(command);
  if (dynamic || parts.length === 0) return "it runs a nested command";
  const programs = new Set<string>();
  for (const part of parts) {
    const argv: string[] = [];
    const words = shellWords(part);
    // A quoted `<` or `>` is text: only a part with an unquoted one has redirects.
    const redirects = /[<>]/.test(part.replace(/'[^']*'|"[^"]*"/g, ""));
    for (let i = 0; i < words.length; i++) {
      const word = words[i] as string;
      if (!redirects) {
        argv.push(word);
        continue;
      }
      // `<>file` opens the file for writing too.
      if (/^\d*<>/.test(word)) return "it opens a file for writing";
      const redirect = /^(\d*|&)(>>?|<)(.*)$/.exec(word);
      // A redirect inside a word (`echo x>a.txt`) writes as well: only the ones read above are known.
      if (redirect === null && /[<>]/.test(word)) return "it writes a file";
      if (redirect === null) argv.push(word);
      else {
        const target = redirect[3] || words[++i] || "";
        if (redirect[2] === "<") argv.push(target);
        else if (!/^(&\d|\/dev\/(null|stdout|stderr)|nul)$/i.test(target)) return "it writes a file";
      }
    }
    // `LC_ALL=C sort`, `time ls`, `timeout 5 ls`: the command after them runs. Other assignments (`PATH=.`) ask.
    while (argv.length > 1) {
      const head = argv[0] as string;
      if (/^(LC_\w+|LANG|TZ|NO_COLOR|COLUMNS|TERM)=/.test(head) || head === "time") argv.shift();
      else if (head === "timeout" && /^\d+(\.\d+)?[smhd]?$/.test(argv[1] as string)) argv.splice(0, 2);
      else break;
    }
    const program = (argv[0] ?? "").toLowerCase();
    const args = argv.slice(1);
    if (program === "command" && /^-[vV]$/.test(args[0] ?? "")) continue;
    if (VERSION_ONLY.has(program)) {
      if (args.length === 1 && /^(--version|-v|-V|version)$/.test(args[0] as string)) continue;
      return `\`${program}\` runs code`;
    }
    if (!READ_ONLY_PROGRAMS.has(program)) return `\`${program}\` is not on the read-only list`;
    programs.add(program);
    if (args.some((arg) => UNSAFE_SHORT[program]?.test(arg) || longOption(arg, UNSAFE_LONG[program])))
      return `this option of \`${program}\` can write, run a program or read hidden files`;
    if (program === "cd" && (args.length === 0 || args[0] === "-"))
      return "`cd` with no folder leaves the project";
    // A path out of the workspace, a secret file (also as `HEAD:.env`), or a PowerShell drive such as `env:`.
    const outside = (word: string): boolean =>
      (/^([/~]|[A-Za-z]:)/.test(word) && !inWorkspace(word, workspaceRoot)) ||
      /^(env|variable|function|alias|cert|wsman|hk[a-z]+):/i.test(word) ||
      // Windows devices: reading CON waits for the console.
      (program !== "ps" && /^(con|prn|aux|com\d|lpt\d)(\.|$)/i.test(word)) ||
      /(^|\/)\.\.(\/|$)/.test(word) ||
      SECRET_FILE.test(word);
    // The first word of grep, rg, sed, awk and jq is a pattern or a program, not a path: `sed -n '/foo/p'`.
    const patternAt =
      PATTERN_PROGRAMS.has(program) && !args.some((arg) => /^-[ef]$|^--(regexp|file)/.test(arg))
        ? args.findIndex((arg, i) => !arg.startsWith("-") && !VALUE_OPTION.test(args[i - 1] ?? ""))
        : -1;
    // The value of an option counts too: `--file=/etc/passwd`, `-f/etc/passwd`.
    const values = (arg: string) => [
      arg,
      arg.slice(arg.indexOf("=") + 1),
      /^-[^-]./.test(arg) ? arg.slice(2) : "",
    ];
    if (args.some((arg, i) => i !== patternAt && values(arg).some((word) => word !== "" && outside(word))))
      return "it names a path outside the project or a secret file";
    // An unquoted glob can expand to an option such as `-delete`.
    if (
      /[*?[]/.test(part.replace(/'[^']*'|"[^"]*"/g, "")) &&
      (UNSAFE_SHORT[program] || UNSAFE_LONG[program] || program === "cd")
    )
      return "an unquoted wildcard can expand to an option of this program";
    // A wildcard that can match a secret file, quoted too: PowerShell and `rg -g` expand quoted ones.
    // A `[...]` class matches one character, as `?` does.
    const matches = (glob: string) =>
      new RegExp(
        globToRegExpSource((glob.split(/[/\\]/).at(-1) ?? glob).replace(/\[[^\]]*\]/g, "?"), "path"),
      );
    // find only prints the names its patterns match.
    if (
      program !== "find" &&
      args.some((arg) => /[*?[]/.test(arg) && SECRET_NAMES.some((name) => matches(arg).test(name)))
    )
      return "a wildcard can match a secret file";
    if (program === "ps" && args.some((arg) => !arg.startsWith("-") && arg.includes("e")))
      return "`ps e` prints the environment of each process";
    const valued = ONE_FILE[program];
    if (valued) {
      const files = args.filter((arg, i) => !arg.startsWith("-") && !valued.includes(args[i - 1] ?? ""));
      if (files.length > 1) return `\`${program}\` writes its second file`;
    }
    if (program === "hostname" && args.some((arg) => !arg.startsWith("-")))
      return "`hostname NAME` renames the computer";
    if (program === "jq" && args.some((arg) => /\benv\b|\$ENV|--rawfile|--slurpfile/.test(arg)))
      return "this jq filter reads the environment or other files";
    // awk writes with `>` and `|`, runs programs with system() and getline, and reads the environment from ENVIRON.
    if (
      program === "awk" &&
      args.some((arg) => /system|getline|ENVIRON|PROCINFO|[|>@]|^-f|^--file/.test(arg))
    )
      return "this awk program can write, run a program or read the environment";
    if (program === "sed") {
      const scripts = args.flatMap((arg, i) => (args[i - 1] === "-e" ? [arg] : []));
      const script = scripts.length > 0 ? scripts : args.filter((arg) => !arg.startsWith("-")).slice(0, 1);
      if (!script.every((text) => text.split(";").every((cmd) => SED_COMMAND.test(cmd.trim()))))
        return "this sed script can write or run files";
    }
    if (program === "git") {
      const start = args.findIndex((arg) => !GIT_QUIET.test(arg));
      const rest = start === -1 ? [] : args.slice(start);
      const sub = rest[0] ?? "";
      const more = rest.slice(1);
      const listing =
        sub === "--version" ||
        READ_ONLY_GIT.has(sub) ||
        (sub === "remote" && more.every((arg) => arg === "-v")) ||
        (sub === "tag" && (more.length === 0 || more.some((arg) => arg === "-l" || arg === "--list"))) ||
        (sub === "stash" && (more[0] === "list" || more[0] === "show")) ||
        (sub === "reflog" &&
          (more.length === 0 || more[0] === "show" || more[0]?.startsWith("-") === true)) ||
        (sub === "config" &&
          more.some((arg) => /^(--get|--get-all|--get-regexp|--list|-l)$/.test(arg)) &&
          !more.some((arg) =>
            /^(--add|--unset|--unset-all|--replace-all|--edit|-e|--rename-section|--remove-section)$/.test(
              arg,
            ),
          ));
      if (!listing) return `\`git ${sub}\` can change the repository`;
      if (sub === "branch" && !more.every((arg) => GIT_BRANCH_LIST.test(arg)))
        return "`git branch NAME` makes a branch";
    }
  }
  // git in another folder can run the hooks of that folder.
  if (programs.has("cd") && programs.has("git")) return "git in another folder can run that folder's hooks";
  return undefined;
}

/** True for a command line that only reads files of the workspace (`readOnlyRefusal` finds no reason to ask). */
export function isReadOnlyCommand(command: string, workspaceRoot?: string): boolean {
  return readOnlyRefusal(command, workspaceRoot) === undefined;
}

/**
 * Compiles a glob into an anchored regex source. Path mode treats `*` as
 * within-segment (a slash-crossing wildcard is the double-star form), a
 * trailing double-star covers the directory itself and everything under it,
 * and a leading double-star-slash matches any depth. Command mode treats `*`
 * as crossing anything so `git *` matches whole command strings.
 */
export function globToRegExpSource(glob: string, mode: "path" | "command"): string {
  // The permission-map convention: a lone `*` means "everything" for any
  // subject kind (e.g. `{"write": {"*": "deny", ".agency/plans/**": "allow"}}`).
  if (glob === "*") return "^.*$";
  const source = glob.replace(/\\/g, "/");
  let re = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === undefined) break;
    if (ch === "*") {
      if (source[i + 1] === "*") {
        if (source[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
          continue;
        }
        if (re.endsWith("/")) {
          // A trailing `/**` covers the directory itself and everything under it.
          re = `${re.slice(0, -1)}(?:/.*)?`;
        } else {
          re += ".*";
        }
        i += 2;
        continue;
      }
      re += mode === "path" ? "[^/]*" : ".*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      re += mode === "path" ? "[^/]" : ".";
      i += 1;
      continue;
    }
    re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    i += 1;
  }
  return `^${re}$`;
}

const globCache = new Map<string, RegExp>();

function globRegExp(glob: string, mode: "path" | "command"): RegExp {
  const key = `${mode}\u0000${glob}`;
  let compiled = globCache.get(key);
  if (!compiled) {
    compiled = new RegExp(globToRegExpSource(glob, mode));
    globCache.set(key, compiled);
  }
  return compiled;
}

function globMatches(glob: string, value: string, mode: "path" | "command"): boolean {
  if (mode === "path" && process.platform === "win32") {
    // Windows paths are case-insensitive; a case mismatch must not defeat a rule.
    return globRegExp(glob.toLowerCase(), mode).test(value.toLowerCase());
  }
  return globRegExp(glob, mode).test(value);
}

function ruleMatches(rule: PolicyRule, request: PolicyRequest): boolean {
  if (rule.tool !== "*" && rule.tool !== request.tool) return false;
  if (rule.pathGlob && (!request.path || !globMatches(rule.pathGlob, request.path, "path"))) {
    return false;
  }
  if (rule.commandPattern) {
    const pattern = new RegExp(rule.commandPattern);
    const rawMatch = request.command !== undefined && pattern.test(request.command);
    const normalizedMatch =
      request.normalizedCommand !== undefined && pattern.test(request.normalizedCommand);
    if (!rawMatch && !normalizedMatch) return false;
  }
  return true;
}

/**
 * Converts a permissions-config entry set into precedence-ordered rules for the
 * `PolicyEngine`. Pattern maps are emitted in REVERSED entry and pattern order
 * so the engine's first-match-wins walk implements the config model's
 * last-match-wins semantics, with an `ask` catch-all per mapped tool so an
 * unmatched command/path fails safe instead of falling through to the engine
 * default. Bare decisions become single tool-level rules.
 *
 * Path patterns are matched against workspace-relative paths; command patterns
 * match both the raw and arity-normalized command.
 */
export function rulesFromPermissions(permissions: Record<string, ToolPermissionValue>): PolicyRule[] {
  const rules: PolicyRule[] = [];
  for (const [tool, value] of Object.entries(permissions).reverse()) {
    if (typeof value === "string") {
      rules.push({ tool, decision: value });
      continue;
    }
    const entries = Object.entries(value).reverse();
    for (const [pattern, decision] of entries) {
      if (isCommandPatternTool(tool)) {
        rules.push({ tool, commandPattern: globToRegExpSource(pattern, "command"), decision });
      } else if (isPathPatternTool(tool)) {
        rules.push({ tool, pathGlob: pattern, decision });
      } else if (pattern === "*") {
        rules.push({ tool, decision });
      }
      // Non-wildcard patterns on a tool with neither command nor path subjects
      // can never match meaningfully; skip them rather than silently matching.
    }
    // Nothing matched in the map: fail safe with an ask rather than the
    // engine-level default, so a partially-specified map never silently allows.
    rules.push({ tool, decision: "ask" });
  }
  return rules;
}

/**
 * First-match-wins over a precedence-ordered rule list (most specific /
 * highest-priority source first, the way callers assemble that order from layered
 * config the same way P0's config loader does). Falls back to `defaultDecision`
 * when nothing matches, so an unconfigured tool doesn't silently run.
 *
 * The permissions-config path (`rulesFromPermissions` + `PermissionsGate`)
 * layers last-match-wins permission maps on top of the same engine by reversing
 * rule order: one evaluator, both semantics.
 */
export class PolicyEngine {
  constructor(
    private readonly rules: readonly PolicyRule[],
    private readonly defaultDecision: Decision = "ask",
  ) {}

  evaluate(request: PolicyRequest): Decision {
    return this.evaluateWithMatch(request).decision;
  }

  /**
   * Same walk, also naming the first matching rule for ask-source labels. A compound shell command is
   * judged part by part and the strictest verdict wins: a rule for `git status` must not allow `git status; rm -rf ~`.
   */
  evaluateWithMatch(request: PolicyRequest): { decision: Decision; matched?: PolicyRule } {
    if (request.command === undefined) return this.evaluateOne(request);
    const { parts, dynamic } = splitCommand(request.command);
    let worst = this.evaluateOne(request);
    const forms = new Set<string>();
    for (const part of parts) for (const form of unwrapCommand(part)) forms.add(form);
    forms.delete(request.command);
    for (const form of forms) {
      const verdict = this.evaluateOne({ ...request, command: form, normalizedCommand: undefined });
      if (DECISION_RANK[verdict.decision] > DECISION_RANK[worst.decision]) worst = verdict;
    }
    // The shell builds a part of this command at run time: no rule saw the text that will run.
    if (dynamic && worst.decision === "allow") return { decision: "ask" };
    if (worst.decision === "allow" && [request.command, ...forms].some(isDestructiveCommand)) {
      return { decision: "ask" };
    }
    return worst;
  }

  private evaluateOne(request: PolicyRequest): { decision: Decision; matched?: PolicyRule } {
    const subject =
      request.command !== undefined && request.normalizedCommand === undefined
        ? { ...request, normalizedCommand: normalizeCommand(request.command) }
        : request;
    for (const rule of this.rules) {
      if (ruleMatches(rule, subject)) return { decision: rule.decision, matched: rule };
    }
    return { decision: this.defaultDecision };
  }
}

/** Workspace-relative, forward-slash form of `candidate` (absolute or relative). */
export function relativeWorkspacePath(root: string, candidate: string): string {
  const rel = relative(resolve(root), resolve(root, fromMsysPath(candidate))).replace(/\\/g, "/");
  return rel === "" ? "." : rel;
}

/**
 * The production permission gate: evaluates the `permissions` config through the
 * `PolicyEngine`, filters the tool list (two-level policy: a tool absent from a
 * per-agent map, or mapped to a bare `deny`, is not offered to the model at
 * all), gates on workspace trust for tools above the `safe` risk tier, and
 * resolves `ask` decisions through the approval callback. With no callback
 * available an `ask` fails closed (deny); a headless run must never silently
 * approve itself.
 */
/** `over` on top of `base`: the rules of `over` come after those of `base` for a tool, so they win on a call. */
export function mergePermissions(
  base: Record<string, ToolPermissionValue>,
  over: Record<string, ToolPermissionValue>,
): Record<string, ToolPermissionValue> {
  const merged = { ...base };
  for (const [tool, value] of Object.entries(over)) {
    const under = merged[tool];
    if (under === undefined || typeof value === "string") merged[tool] = value;
    else {
      const all = isPathPatternTool(tool) ? "**" : "*";
      const first: Record<string, Decision> = typeof under === "string" ? { [all]: under } : { ...under };
      for (const key of Object.keys(value)) delete first[key];
      merged[tool] = { ...first, ...value };
    }
  }
  return merged;
}

export class PermissionsGate implements ToolPolicy {
  private readonly engine: PolicyEngine;
  private readonly permissions: Record<string, ToolPermissionValue>;
  private itemScopes: readonly string[] | undefined;
  private ceiling: PermissionsGate | undefined;

  constructor(
    private options: {
      permissions?: Record<string, ToolPermissionValue>;
      workspaceRoot: string;
      /** Per-agent policy mode: tools absent from the map are filtered entirely. */
      absentToolsDenied?: boolean;
      /** Trust gate: tools above `safe` refuse to run in an untrusted workspace. */
      trust?: { store: TrustStore; root: string; required: boolean };
      /** Non-interactive mode override; `ask` (default) keeps config behavior. */
      permissionMode?: PermissionMode;
    },
  ) {
    this.permissions = options.permissions ?? {};
    this.engine = new PolicyEngine(rulesFromPermissions(this.permissions), "ask");
  }

  /** Switches this gate's mode in place: a turn whose plan the user approved goes on in the new mode. */
  setMode(mode: PermissionMode): void {
    this.options = { ...this.options, permissionMode: mode };
  }

  /** Derives a gate with `mode` applied over the same policy and trust inputs. */
  withMode(mode: PermissionMode): PermissionsGate {
    const next = new PermissionsGate({ ...this.options, permissionMode: mode });
    if (this.itemScopes !== undefined) next.itemScopes = [...this.itemScopes];
    next.ceiling = this.ceiling;
    return next;
  }

  /** Derives a gate whose rules for this run come after those of the config, so they win on a call. */
  withRules(rules: Record<string, ToolPermissionValue> | undefined): PermissionsGate {
    if (rules === undefined) return this;
    const next = new PermissionsGate({
      ...this.options,
      permissions: mergePermissions(this.permissions, rules),
    });
    if (this.itemScopes !== undefined) next.itemScopes = [...this.itemScopes];
    next.ceiling = this.ceiling;
    return next;
  }

  /** Layers an item path scope over this gate: path writes outside every scope deny (7.17). */
  withItemScope(scopes: readonly string[]): PermissionsGate {
    const next = new PermissionsGate({ ...this.options });
    if (this.itemScopes !== undefined) next.itemScopes = [...this.itemScopes, ...scopes];
    else next.itemScopes = [...scopes];
    next.ceiling = this.ceiling;
    return next;
  }

  /**
   * Caps an agent's own map by the gate of the run that started the agent: the stricter verdict wins, and
   * the run's mode answers the asks. Without it a roster entry could give an agent more than its run has.
   */
  withCeiling(run: PermissionsGate): PermissionsGate {
    const next = this.withMode(run.options.permissionMode ?? this.options.permissionMode ?? "ask");
    next.ceiling = run;
    return next;
  }

  /**
   * Two-level policy: should the tool be in the list offered to the model.
   * A bare `deny` never is; with `absentToolsDenied` (per-agent policies) an
   * unlisted tool isn't either; otherwise unlisted tools follow their risk
   * tier (`safe` offered, everything else offered but asking per call).
   */
  toolOffered(tool: string, riskTier?: RiskTier): boolean {
    if (this.options.permissionMode === "deny" && (riskTier ?? "dangerous") !== "safe") return false;
    const entry = this.permissions[tool];
    if (entry === "deny") return false;
    if (entry === undefined) {
      if (this.options.absentToolsDenied) return false;
      return this.defaultFor(riskTier) !== "deny";
    }
    return true;
  }

  /** The verdict without consulting approvals (the engine + defaults only). */
  decisionFor(request: ToolCallPolicyRequest): Decision {
    const own = this.ownDecisionFor(request);
    if (this.ceiling === undefined) return own;
    const cap = this.ceiling.decisionFor(request);
    return DECISION_RANK[cap] > DECISION_RANK[own] ? cap : own;
  }

  private ownDecisionFor(request: ToolCallPolicyRequest): Decision {
    if (this.outsideItemScope(request)) return "deny";
    if (
      request.command !== undefined &&
      isCommandPatternTool(request.tool) &&
      this.deniesShellFiles(request.command)
    )
      return "deny";
    const entry = this.permissions[request.tool];
    if (entry === undefined) {
      if (this.options.absentToolsDenied) return "deny";
      if (ORCHESTRATION_TOOLS.has(request.tool) && this.workspaceAllowsOrchestration()) return "allow";
      const decision = this.defaultFor(request.riskTier);
      if (decision === "allow" && this.isEnvRead(request)) return "deny";
      if (decision === "ask" && this.readOnlyShell(request)) return "allow";
      return decision;
    }
    if (typeof entry === "string") {
      if (entry === "allow" && this.isEnvRead(request)) return "deny";
      return entry;
    }

    const subject: PolicyRequest = { tool: request.tool };
    if (request.command !== undefined && isCommandPatternTool(request.tool)) {
      subject.command = request.command;
      subject.normalizedCommand = normalizeCommand(request.command);
    }
    if (request.path !== undefined && isPathPatternTool(request.tool)) {
      subject.path = relativeWorkspacePath(this.options.workspaceRoot, request.path);
    }
    const decision = this.engine.evaluate(subject);
    if (decision === "allow" && this.isEnvRead(request)) return "deny";
    if (decision === "ask" && this.readOnlyShell(request)) return "allow";
    return decision;
  }

  /** A read-only command (`isReadOnlyCommand`) with no part that an ask or deny pattern names, as in Claude Code. */
  private readOnlyShell(request: ToolCallPolicyRequest): boolean {
    if (request.command === undefined || !isCommandPatternTool(request.tool)) return false;
    if (!isReadOnlyCommand(request.command, this.options.workspaceRoot)) return false;
    return splitCommand(request.command).parts.every((part) => {
      const verdict = this.engine.evaluateWithMatch({ tool: request.tool, command: part });
      return verdict.decision === "allow" || verdict.matched?.commandPattern === undefined;
    });
  }

  private outsideItemScope(request: ToolCallPolicyRequest): boolean {
    if (this.itemScopes === undefined || request.path === undefined) return false;
    const rel = relativeWorkspacePath(this.options.workspaceRoot, request.path);
    return !this.itemScopes.some((scope) => scopeMatchesPattern(scope, rel));
  }

  /**
   * The `external_directory` permission governs access outside the workspace
   * root. Accepts a bare decision or a directory-glob map (matched against the
   * resolved absolute path, forward-slash form); defaults to `deny`, which is
   * the sandbox's historical behavior.
   */
  externalDirectoryDecision(absolutePath: string): Decision {
    const entry = (this.permissions as { external_directory?: ToolPermissionValue }).external_directory;
    if (entry === undefined) return "deny";
    if (typeof entry === "string") return entry;
    const normalized = absolutePath.replace(/\\/g, "/");
    let matched: Decision | undefined;
    for (const [glob, decision] of Object.entries(entry)) {
      if (globMatches(glob, normalized, "path")) matched = decision; // last match wins
    }
    return matched ?? "ask";
  }

  /** Names the rule that produced an ask: explicit entry, pattern, or default. */
  askSource(request: ToolCallPolicyRequest): string {
    if (this.ceiling !== undefined && this.ownDecisionFor(request) !== "ask") {
      return this.ceiling.askSource(request);
    }
    const entry = this.permissions[request.tool];
    if (entry === undefined) return `default:risk-tier=${request.riskTier ?? "missing"}`;
    if (typeof entry === "string") return `explicit:${request.tool}=${entry}`;
    for (const [pattern, decision] of Object.entries(entry).reverse()) {
      if (decision !== "ask") continue;
      if (request.command !== undefined && isCommandPatternTool(request.tool)) {
        const re = globRegExp(pattern, "command");
        if (re.test(request.command) || re.test(normalizeCommand(request.command)))
          return `permissions:${request.tool}:${pattern}=ask`;
      } else if (request.path !== undefined && isPathPatternTool(request.tool)) {
        if (globMatches(pattern, relativeWorkspacePath(this.options.workspaceRoot, request.path), "path"))
          return `permissions:${request.tool}:${pattern}=ask`;
      } else if (pattern === "*") {
        return `permissions:${request.tool}:*=ask`;
      }
    }
    return `permissions:${request.tool}:unmatched-map-ask`;
  }

  async check(
    request: ToolCallPolicyRequest,
    ask: ((request: ApprovalRequestLike) => Promise<"once" | "always" | "reject">) | undefined,
  ): Promise<"allow" | "deny"> {
    // Trust gate: mutating or executing tools require a trusted workspace.
    // Read-only (`safe`) tools still work; refusing trust leaves a usable,
    // read-only session instead of a dead one. Only an explicit "safe" tier
    // passes: a missing or unrecognized tier is untrusted input (a dynamically
    // loaded plugin tool is the obvious source: `riskTier` is an
    // interface-only guarantee, never runtime-validated), so it defaults to
    // unsafe and is denied here.
    const trust = this.options.trust;
    if (trust?.required && (request.riskTier ?? "dangerous") !== "safe") {
      if (!trust.store.isTrusted(trust.root)) return "deny";
    }
    if (this.options.permissionMode === "deny" && (request.riskTier ?? "dangerous") !== "safe") {
      return "deny";
    }
    if (this.planRefuses(request)) return "deny";

    const decision = this.decisionFor(request);
    if (decision === "deny") return "deny";
    const harness = this.harnessFileWritten(request);
    if (harness === undefined) {
      if (decision === "allow") return "allow";
      // Answers asks only: a config deny, an item scope, `.env` reads and the trust gate refuse above.
      if (this.options.permissionMode === "allow-all") return "allow";
      const mode = this.options.permissionMode;
      if ((mode === "allow-edits" || mode === "auto") && EDIT_TOOLS.has(request.tool)) return "allow";
    }
    if (!ask) return "deny"; // no approval surface: fail closed

    const source = harness === undefined ? this.askSource(request) : `${PROTECTED_SOURCE}${harness}`;
    const response = await ask({
      tool: request.tool,
      title: request.command ?? request.path ?? request.title ?? request.tool,
      command: request.command,
      path: request.path,
      riskTier: request.riskTier,
      source,
      ...(request.command !== undefined && isCommandPatternTool(request.tool)
        ? { reason: readOnlyRefusal(request.command, this.options.workspaceRoot) }
        : {}),
      metadata: { riskTier: request.riskTier, source },
    });
    return response === "reject" ? "deny" : "allow";
  }

  /**
   * A file of `PROTECTED_PATHS` that the request writes, as the workspace names it. Its hooks, MCP servers and plugins
   * run later outside the sandbox, so no mode or rule writes one without the user. Plans are files of the plan agent.
   */
  private harnessFileWritten(request: ToolCallPolicyRequest): string | undefined {
    const targets =
      EDIT_TOOLS.has(request.tool) && request.path !== undefined
        ? [request.path]
        : isCommandPatternTool(request.tool) && request.command !== undefined
          ? shellFileTargets(request.command).writes
          : [];
    for (const target of targets) {
      const rel = relativeWorkspacePath(this.options.workspaceRoot, target);
      const key = process.platform === "win32" ? rel.toLowerCase() : rel;
      const under = (dir: string) => key === dir || key.startsWith(`${dir}/`);
      if ([...PROTECTED_PATHS.writable, ".agency/plans"].some(under)) continue;
      if (PROTECTED_PATHS.readOnly.some(under)) return rel;
    }
    return undefined;
  }

  /** A read or edit deny rule that holds for a file that a shell command names. */
  private deniesShellFiles(command: string): boolean {
    const denied = (tool: string, path: string): boolean =>
      this.engine.evaluate({ tool, path: relativeWorkspacePath(this.options.workspaceRoot, path) }) ===
      "deny";
    const { reads, writes } = shellFileTargets(command);
    return (
      reads.some((path) => denied("read", path)) ||
      writes.some((path) => denied("edit", path) || denied("write", path))
    );
  }

  /** Plan mode is read-only: tools above `safe` and spawning agents are refused, except web reads and read-only shell commands. */
  private planRefuses(request: ToolCallPolicyRequest): boolean {
    if (this.options.permissionMode !== "plan") return false;
    if (ORCHESTRATION_TOOLS.has(request.tool) || PLAN_REFUSED_SAFE.has(request.tool)) return true;
    if ((request.riskTier ?? "dangerous") === "safe" || PLAN_WEB_TOOLS.has(request.tool)) return false;
    return !(
      isCommandPatternTool(request.tool) &&
      request.command !== undefined &&
      isReadOnlyCommand(request.command, this.options.workspaceRoot)
    );
  }

  denyReason(request: ToolCallPolicyRequest): string | undefined {
    if (!this.planRefuses(request)) return undefined;
    return `plan mode: ${request.tool} is refused. This session is in plan mode, which is read-only. Do not call it again. Explore with read-only tools, then present your plan: call plan_exit with the full plan in markdown so the user can approve it.`;
  }

  /**
   * Returns true when the request is a path-scoped read of a `.env` file that
   * has no explicit allow in the permissions config. This implements the
   * auto-deny policy: `.env` files are never readable by default, even when
   * the tool's riskTier is `safe` and no explicit permission is configured.
   */
  private isEnvRead(request: ToolCallPolicyRequest): boolean {
    if (!request.path) return false;
    if (!isPathPatternTool(request.tool)) return false;
    const relPath = relativeWorkspacePath(this.options.workspaceRoot, request.path);
    if (!globMatches("**/.env/**", relPath, "path") && !globMatches("**/.env*", relPath, "path")) {
      return false;
    }
    // If there's an explicit allow for this path, respect it.
    return !this.hasExplicitAllow(request.tool, relPath);
  }

  private hasExplicitAllow(tool: string, relPath: string): boolean {
    const entry = this.permissions[tool];
    if (entry === undefined) return false;
    if (typeof entry === "string") return entry === "allow";
    for (const [pattern, decision] of Object.entries(entry)) {
      if (decision === "allow" && globMatches(pattern, relPath, "path")) return true;
    }
    return false;
  }

  /**
   * Verdict for a tool with no configured permission: `safe` tools run,
   * everything else asks. A missing tier is untrusted input, so it fails safe
   * to `ask` rather than silently allowing.
   */
  private defaultFor(riskTier?: RiskTier): Decision {
    return riskTier === "safe" ? "allow" : "ask";
  }

  /**
   * True when the workspace may run mutating tools: trust gating is off, or
   * the trust store marks this root trusted. Absent trust options fail closed.
   * Mirrors the trust gate in `check`, so this allow never widens it.
   */
  private workspaceAllowsOrchestration(): boolean {
    const trust = this.options.trust;
    if (!trust) return false;
    if (!trust.required) return true;
    try {
      return trust.store.isTrusted(trust.root);
    } catch {
      return false;
    }
  }
}

/** User-facing one-line rendering of a skip reason. Keeps the reason token. */
export function formatSkipForDisplay(reason: string, detail: string, handle?: string): string {
  const who = handle ?? "request";
  return `${who}: [skip:${reason}] ${detail}`;
}

/** User-facing one-line rendering of a plan gate reason. Keeps the reason. */
export function formatGateForDisplay(reason: string, detail: string): string {
  const verdict = reason.startsWith("fail-") ? "blocked" : "passed";
  return `plan gate ${verdict} [${reason}]: ${detail}`;
}

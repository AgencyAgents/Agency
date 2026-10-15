#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  agencyToolName,
  CODE_COMMAND,
  type Config,
  cacheDir,
  dataDir,
  EventBus,
  getSessionTitle,
  loadConfig,
  OUTPUT_CUT_NOTE,
  ownerOnlyDirs,
  parseModelRef,
  permissionsFromRules,
  type RetentionPolicy,
  reportStorage,
  runCodeChild,
  SessionStore,
  storagePaths,
} from "@agency/core";
import {
  PERMISSION_MODES,
  type PermissionMode,
  runSandboxChild,
  SANDBOX_COMMAND,
  type ToolPermissionValue,
} from "@agency/guard";
import { t } from "@agency/i18n";
import {
  BUILTIN_MODELS,
  CHATGPT_PROVIDER,
  CHATGPT_USAGE_URL,
  createKeychain,
  defaultModelIDs,
  GATEWAY_BASE_URLS,
  getChatgptCredential,
  type KeychainBackend,
  listChatgptModels,
  OAUTH_PROVIDERS,
  oauthKey,
  resolveApiKey,
  runDeviceFlow,
  runOAuthFlow,
  signInChatgpt,
  signOutChatgpt,
  supportsDeviceFlow,
  ThinkingLevel,
} from "@agency/providers";
import { connectToDaemon, type DaemonClient, hashWorkspaceRoot, type InstanceInfo } from "@agency/rpc";
import type { Message } from "@agency/schema";
import { imageMimeFor, loadMcpConfigArg } from "@agency/tools";
import { DEFAULT_SYSTEM_PROMPT, type RunTurnRpcResult, STRUCTURED_OUTPUT_TOOL } from "./daemon.ts";
import { debugCommand } from "./debug.ts";
import { connectHeadlessClient, DAEMON_COMMAND, type RunHeadlessOptions, runHeadless } from "./headless.ts";
import { mcpCmd, mcpServe } from "./mcp-commands.ts";
import { createTerminalOnboardingPrompter, readSecretLine, runOnboarding } from "./onboarding.ts";
import {
  claudePluginSource,
  pluginInstallSource,
  pluginListCmd,
  pluginRemoveCmd,
  pluginSyncCmd,
  pluginUpdateCmd,
} from "./plugin-commands.ts";
import { runSessionTurn } from "./session-runner.ts";
import {
  pruneCommand,
  storageCommand,
  type UsageGroup,
  usageCommand,
  usageReport,
  whereCommand,
  wherePaths,
} from "./storage-commands.ts";
import { runParallel, runWorkflow, type WorkflowAgentResult } from "./workflow.ts";

/**
 * Inlined at compile time by scripts/build.ts (--define); running from source
 * falls back to the package version.
 */
const VERSION = process.env.AGENCY_VERSION ?? "0.1.0";

const HELP = `Agency - production coding harness (backend)

Usage: agency [command] [options]
       agency -p <prompt> [options]

Commands:
  where                    Show every path Agency reads or writes
  storage                  Report storage sizes by category
  storage prune            Clear the cache; with retention flags, prune old sessions
  usage [--by day|month|model] [--since YYYY-MM-DD] [--json]
                           Tokens and cost of the model calls of all workspaces
  session list [query]     List sessions for this workspace (id, title, created, entries);
                           optional query filters by title (id fallback), case-insensitive
  session show <id>        Show session details (show, export and fork take a session's
                           title too)
  session export <id> [-o <file>]
                           The conversation of a session as Markdown, to stdout or a file
  session rename <id> <title>  Rename a session
  session fork <id>        Fork (clone) a session under a new id
  session clone <id> [newId]  Clone a session file under a new id (or the given one)
  session delete <id>      Delete a session by id
  daemon status            Show daemon status for this workspace, with the turns that run
  daemon cancel <turn>     Stop a turn that runs
  auth login <provider>    Store an API key for a provider in the OS keychain
  auth login chatgpt       Continue with ChatGPT: use the models of your ChatGPT plan
  auth login <provider> --oauth
                           OAuth browser flow for google, github-copilot
                           (needs provider.<id>.oauth.clientId in config)
  auth login <provider> --device
                           RFC 8628 device flow where supported (github-copilot)
  auth list                Show which providers have a resolvable key
  auth logout <provider>   Remove the key or sign-in of a provider (a ChatGPT sign-in is revoked)
  mcp add <name> -- <command> [args]
                           Add an MCP server that runs as a command (--env KEY=value);
                           --scope project writes the .mcp.json of the workspace
  mcp add <name> <url>     Add an MCP server over HTTP (--header "Name: value")
  mcp add-json <name> <json>  Add an MCP server from its entry of .mcp.json
  mcp list                 Show the MCP servers and the origin of each
  mcp get <name>           Show one MCP server, with the values of env and headers hidden
  mcp remove <name>        Remove an MCP server that mcp add added
  mcp login <server>       Sign in to an MCP server over HTTP in the browser (OAuth)
  mcp import <client>      Copy the MCP servers of Claude Code, Cursor, Codex, Gemini,
                           OpenCode, Pi, VS Code, Windsurf, Zed, Claude Desktop, Copilot
                           CLI, Amp, Crush, Goose, Qwen Code, Cline, Roo Code or Kilo Code
  mcp logout <server>      Remove the sign-in of an MCP server
  mcp serve                Serve Agency as an MCP server on stdio: its tool "agency" runs
                           a turn. --permission-mode and --model of the server apply
  plugin install <source> [plugin] [--overwrite]
                           Install a Claude Code / Codex plugin from a folder, a git URL
                           or owner/repo (#ref: a branch or tag)
  plugin list              Show installed skills and plugin modules
  plugin sync              Install the enabledPlugins of .claude/settings.json from their
                           marketplaces (extraKnownMarketplaces, or those Claude Code added)
  plugin update <name>     Install a plugin again from the source of its install
  plugin remove <name>     Remove an installed plugin
  review [<ref>]           Review the changes of the workspace and change no file:
                           the uncommitted changes, or the changes since <ref>
  workflow run <file> [--arg key=value]
                           Run a script that starts agent turns, in sequence or in parallel
  onboard                  First-run setup: connect, model, trust
  trust                    Trust this workspace: load its AGENTS.md, CLAUDE.md and rules
  debug                    Write a redacted debug bundle for issue reports
  update [--rollback]      Update binary from GitHub Releases (ed25519 + SHA-256 verified)
  serve                    Run daemon in foreground (logging to stdout)

Options:
  -p, --print <prompt>     Run a single turn headlessly and print the result
                           (use - to read the prompt from stdin)
  --workspace <path>       Workspace root (default: current directory)
  --model <provider/model> Model to use; overrides config.model
  --provider <id>          Provider for the model; overrides config.model's provider
  --continue               With -p: resume the most recent session
  --session <id>           With -p: run in (creating if needed) this session
  --permission-mode <mode> With -p: ask (default), allow-edits, auto, allow-all, or deny
  --allowed-tools <rules>  With -p: these tools run with no ask, as rules of Claude Code
                           (Bash(git *),Read,Edit(src/**)); --disallowed-tools denies them
  --mcp-config <file|json>  With -p: MCP servers for this run, as .mcp.json has them
                           (repeatable); --strict-mcp-config uses only these servers
  --thinking <level>       With -p: the reasoning effort of the model: off, minimal, low,
                           medium, high, xhigh or max
  --tools <names>          With -p: only these built-in tools (Bash,Read,Edit); "" is none,
                           default is all. MCP tools stay
  --fallback-model <provider/model>
                           With -p: the model of the turn when its model is overloaded
  -o, --output-last-message <file>
                           With -p: also write the answer to this file
  -w, --worktree <name>    With -p: run in the git worktree .agency/worktrees/<name>
                           on branch agency/<name> (made when missing)
  --max-steps <n>          With -p: tool steps one turn may take (default: maxSteps
                           of the config, or 100)
  --max-cost <usd>         With -p: stop the turn when its cost reaches this amount
  --max-total-cost <usd>   With workflow run: no turn starts after the turns cost this much
  --system-prompt <text>   With -p: use this text in place of the built-in base prompt
  --append-system-prompt <text>
                           With -p: add this text after the base prompt
  --json-schema <file>     With -p: the answer is JSON that matches this JSON Schema
                           (a file, or the schema itself)
  --goal <condition>       With -p and a session: the turn goes on until the model
                           judges the condition met, or the step limit
  --image <path>           With -p: send an image file with the prompt (repeat for more)
  --format <text|json|stream-json>
                           Output format (default: text). json is one result for a
                           script. stream-json with -p is one JSON line for each
                           event, then the result as the last line
  --max-age-days <days>    With storage prune: delete sessions older than this
  --max-total-mb <mb>      With storage prune: delete oldest sessions until under this size
  --help, -h               Show this help
  --version, -v            Show version

Flags of Claude Code, codex exec and Pi work too: -p with the prompt after the flags,
--output-format, --max-turns, -c, -r/--resume, --session-id, --dangerously-skip-permissions,
--settings (its permissions, model, fallbackModel and effortLevel), -n/--name, --resume <name>, --fork-session, --system-prompt-file, --append-system-prompt-file, codex exec [resume|fork],
--json, -m, -i, --yolo (the sandbox stays), --mode json, --fork, --exclude-tools, --max-budget-usd, --effort, the permission
modes of Claude Code, -C/--cd, --output-schema and --no-tools. --verbose, --input-format text,
--include-partial-messages, --no-session-persistence, --ephemeral, --no-session and
--skip-git-repo-check change nothing.

No interactive client in this build. Use \`agency -p "<prompt>"\` for headless or \`agency --help\` for commands.
`;

/** The base of the system prompt of a headless turn. The daemon adds the environment, the instructions and the skills. */
function basePrompt(parsed: ParsedArgv): string {
  const base = parsed.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  return parsed.appendSystemPrompt === undefined ? base : `${base}\n\n${parsed.appendSystemPrompt}`;
}

export interface ParsedArgv {
  command: string | undefined;
  subcommand: string | undefined;
  args: string[];
  workspace: string | undefined;
  model: string | undefined;
  provider: string | undefined;
  print: string | undefined;
  oauth: boolean;
  device: boolean;
  overwrite: boolean;
  rollback: boolean;
  images: string[];
  /** The `--arg key=value` pairs of `workflow run`, as written. */
  workflowArgs: string[];
  continueLast: boolean;
  session: string | undefined;
  permissionMode: PermissionMode;
  /** Permission rules of Claude Code for this run: `--allowed-tools` allows, `--disallowed-tools` denies. */
  allowedTools: string[];
  disallowedTools: string[];
  /** The `ask` rules of `--settings`: in a run with no person to ask, such a call is refused. */
  askTools: string[];
  /** The keys of `--settings` that a run here does not use: a warning names them. */
  ignoredSettings: string[];
  /** Tool steps one turn may take; undefined keeps the loop's default. */
  maxSteps: number | undefined;
  goal: string | undefined;
  systemPrompt: string | undefined;
  jsonSchema: string | undefined;
  appendSystemPrompt: string | undefined;
  maxCost: number | undefined;
  maxTotalCost: number | undefined;
  /** `--mcp-config <file|json>` of `-p`: MCP servers of this run; `--strict-mcp-config` drops the others. */
  mcpConfig: string[];
  strictMcpConfig: boolean;
  /** `-o, --output-last-message <file>` of `-p`: the file gets the answer too, as in `codex exec`. */
  outputLastMessage: string | undefined;
  /** `-n, --name <name>` of `-p` with a session: the title of that session, as Claude Code and Pi name one. */
  name: string | undefined;
  /** `--fork-session` of `-p` with `--continue` or `--session`: the turn runs in a copy of the session. */
  forkSession: boolean;
  /** `--thinking <level>` of `-p`, as in Pi: the reasoning effort of the model. */
  thinking: ThinkingLevel | undefined;
  /** `--tools <names>` of `-p`: the built-in tools of the run, as Claude Code names them; `default` is all. */
  tools: string | undefined;
  /** `--fallback-model <provider/model>` of `-p`: the model of the turn when the model is overloaded. */
  fallbackModel: string | undefined;
  /** `-w, --worktree <name>` of `-p`: the turn runs in a git worktree of this name. */
  worktree: string | undefined;
  /** The flags of `mcp add`: `--env KEY=value`, `--header "Name: value"`, `--transport`, `--scope`. */
  serverEnv: string[];
  headers: string[];
  transport: string | undefined;
  scope: string | undefined;
  /** `--format stream-json`: `format` is then json, so every other command prints JSON. */
  streamJson: boolean;
  format: "text" | "json";
  retention: RetentionPolicy | undefined;
  /** `agency usage --by`: day, month or model. */
  usageBy: UsageGroup | undefined;
  /** `agency usage --since YYYY-MM-DD`. */
  since: string | undefined;
  help: boolean;
  version: boolean;
}

export interface EntrypointDeps {
  env?: NodeJS.ProcessEnv;
  /** Overrides the global config dir (tests). */
  configDir?: string;
  /** Overrides where session JSONL lives (tests); defaults to the workspace's sessions dir. */
  sessionsDir?: string;
  /** Overrides where daemon instance files live (tests). */
  instanceDir?: string;
  /** Overrides the keychain backend (tests). */
  keychain?: KeychainBackend;
  /** Opens the sign-in page of `mcp login` (tests); default: the browser. */
  openUrl?: (url: string) => Promise<void> | void;
  /** Reads the API key for `auth login`; default reads a hidden TTY line or piped stdin. */
  keyReader?: (prompt: string) => Promise<string>;
  /** Overrides the stdin that `-p -` reads the prompt from (tests). */
  stdin?: () => Promise<string>;
  /** Overrides runHeadless for one-shot -p turns (tests). */
  runHeadless?: (options: RunHeadlessOptions) => Promise<RunTurnRpcResult>;
  /** Overrides the daemon connection for session-backed -p turns (tests). */
  ensureClient?: (options: { workspaceRoot: string; instanceDir?: string }) => Promise<DaemonClient>;
  /** Overrides the workspace the command runs in (tests). */
  cwd?: string;
  /** The fetch of the ChatGPT sign-in, its model list and its sign-out (tests). */
  chatgptFetch?: typeof fetch;
  /** Overrides the OAuth browser flow for `auth login --oauth` (tests). */
  oauthFlow?: (provider: string, keychain: KeychainBackend) => Promise<unknown>;
  /** Overrides the device flow for `auth login --device` (tests). */
  deviceFlow?: (provider: string, keychain: KeychainBackend) => Promise<unknown>;
  /** Event bus wired into the session-backed store, so compaction of a real
   *  interactive session emits session.compacted instead of firing into the
   *  void. Defaults to a fresh bus per invocation. */
  bus?: EventBus;
  /** The request lines of `mcp serve` (tests); default: stdin. */
  mcpInput?: AsyncIterable<string>;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

function splitFlag(arg: string): [string, string | undefined] {
  const eq = arg.indexOf("=");
  if (eq === -1) return [arg, undefined];
  return [arg.slice(0, eq), arg.slice(eq + 1)];
}

function numberValue(flag: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(t("cli.error.invalid_number", { flag }));
  return value;
}

export function parseArgv(argv: string[]): ParsedArgv {
  const parsed: ParsedArgv = {
    command: undefined,
    subcommand: undefined,
    args: [],
    workspace: undefined,
    model: undefined,
    provider: undefined,
    print: undefined,
    oauth: false,
    device: false,
    images: [],
    workflowArgs: [],
    mcpConfig: [],
    strictMcpConfig: false,
    worktree: undefined,
    fallbackModel: undefined,
    tools: undefined,
    thinking: undefined,
    forkSession: false,
    name: undefined,
    outputLastMessage: undefined,
    serverEnv: [],
    headers: [],
    transport: undefined,
    scope: undefined,
    overwrite: false,
    rollback: false,
    continueLast: false,
    session: undefined,
    permissionMode: "ask",
    allowedTools: [],
    disallowedTools: [],
    askTools: [],
    ignoredSettings: [],
    maxSteps: undefined,
    goal: undefined,
    systemPrompt: undefined,
    jsonSchema: undefined,
    appendSystemPrompt: undefined,
    maxCost: undefined,
    maxTotalCost: undefined,
    streamJson: false,
    format: "text",
    retention: undefined,
    usageBy: undefined,
    since: undefined,
    help: false,
    version: false,
  };
  const positionals: string[] = [];
  // `claude -p --output-format json "query"`: the `-p` of Claude Code takes no value, and the prompt comes later.
  let promptLater = false;
  let settingsArg: string | undefined;
  let modeSet = false;
  let appendFileText: string | undefined;
  const fileText = (flag: string, path: string): string => {
    try {
      return readFileSync(path, "utf8");
    } catch (error) {
      throw new Error(t("cli.error.read_file", { flag, path, detail: (error as Error).message }));
    }
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) break;
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      positionals.push(arg);
      continue;
    }
    const [name, inline] = splitFlag(arg);
    const value = (): string => {
      if (inline !== undefined) return inline;
      i++;
      const next = argv[i];
      if (next === undefined) throw new Error(t("cli.error.missing_value", { flag: name }));
      return next;
    };
    switch (name) {
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      case "--version":
      case "-v":
        parsed.version = true;
        break;
      case "--continue":
      case "-c":
        parsed.continueLast = true;
        break;
      case "--oauth":
        parsed.oauth = true;
        break;
      case "--device":
        parsed.device = true;
        break;
      case "--workspace":
      case "-C":
      case "--cd":
        parsed.workspace = value();
        break;
      case "--model":
      case "-m":
        parsed.model = value();
        break;
      case "--provider":
        parsed.provider = value();
        break;
      case "--session":
      case "--session-id":
      case "--resume":
      case "-r":
        parsed.session = value();
        break;
      case "-p":
      case "--print": {
        const next = argv[i + 1];
        if (inline === undefined && (next === undefined || (next.startsWith("-") && next !== "-")))
          promptLater = true;
        else parsed.print = value();
        break;
      }
      // Claude Code asks for `--verbose` with stream-json, and `codex exec` for a git check flag outside a repository.
      case "--verbose":
      case "--include-partial-messages":
      case "--skip-git-repo-check":
      case "--no-session-persistence":
      case "--ephemeral":
      case "--no-session":
        break;
      // `codex exec resume --last`.
      case "--last":
        parsed.continueLast = true;
        break;
      // The JSON lines of `codex exec --json` and `pi --mode json` are the events of the turn: here, those of Agency.
      case "--json":
        parsed.streamJson = true;
        parsed.format = "json";
        break;
      case "--mode": {
        const mode = value();
        if (mode !== "text" && mode !== "json") throw new Error(t("cli.error.invalid_format"));
        parsed.streamJson = mode === "json";
        parsed.format = mode;
        break;
      }
      // The sandbox stays: Agency runs no command outside it.
      case "--yolo":
      case "--dangerously-bypass-approvals-and-sandbox":
        parsed.permissionMode = "allow-all";
        break;
      // `pi --fork <id>`.
      case "--fork":
        parsed.session = value();
        parsed.forkSession = true;
        break;
      case "--exclude-tools":
      case "-xt":
        parsed.disallowedTools.push(
          ...value()
            .split(",")
            .map((rule) => rule.trim())
            .filter(Boolean),
        );
        break;
      case "--input-format":
        if (value() !== "text") throw new Error(t("cli.error.input_format"));
        break;
      case "--dangerously-skip-permissions":
        modeSet = true;
        parsed.permissionMode = "allow-all";
        break;
      case "-n":
      case "--name":
        parsed.name = value();
        break;
      case "--fork-session":
        parsed.forkSession = true;
        break;
      // Pi's `--no-tools` turns off the MCP tools too, those of `--mcp-config` with them: a deny of `*`.
      case "--no-tools":
      case "-nt":
        parsed.disallowedTools.push("*");
        break;
      case "--format":
      case "--output-format": {
        const format = value();
        if (format !== "text" && format !== "json" && format !== "stream-json") {
          throw new Error(t("cli.error.invalid_format"));
        }
        parsed.streamJson = format === "stream-json";
        parsed.format = format === "text" ? "text" : "json";
        break;
      }
      case "--settings":
        settingsArg = value();
        break;
      case "--permission-mode": {
        modeSet = true;
        const raw = value();
        const mode = CLAUDE_PERMISSION_MODES[raw] ?? raw;
        if (!PERMISSION_MODES.includes(mode as PermissionMode)) {
          throw new Error(t("cli.error.invalid_permission_mode"));
        }
        parsed.permissionMode = mode as PermissionMode;
        break;
      }
      // Claude Code spells them `--allowedTools` and `--disallowedTools`. A value holds rules split by commas.
      case "--allowed-tools":
      case "--allowedTools":
      case "--disallowed-tools":
      case "--disallowedTools": {
        const rules = value()
          .split(/,(?![^(]*\))/)
          .map((rule) => rule.trim())
          .filter(Boolean);
        (name.toLowerCase().startsWith("--allowed") ? parsed.allowedTools : parsed.disallowedTools).push(
          ...rules,
        );
        break;
      }
      case "--max-steps":
      case "--max-turns": {
        const steps = Number(value());
        if (!Number.isInteger(steps) || steps < 1) throw new Error(t("cli.error.invalid_max_steps"));
        parsed.maxSteps = steps;
        break;
      }
      case "--goal":
        parsed.goal = value();
        break;
      case "--json-schema":
      case "--output-schema":
        parsed.jsonSchema = value();
        break;
      case "--system-prompt":
        parsed.systemPrompt = value();
        break;
      case "--system-prompt-file":
        parsed.systemPrompt = fileText(name, value());
        break;
      case "--append-system-prompt":
        parsed.appendSystemPrompt = value();
        break;
      case "--append-system-prompt-file":
        appendFileText = fileText(name, value());
        break;
      case "--max-cost":
      case "--max-budget-usd":
      case "--max-total-cost": {
        const cost = Number(value());
        if (!(cost > 0)) throw new Error(t("cli.error.invalid_max_cost"));
        if (name !== "--max-total-cost") parsed.maxCost = cost;
        else parsed.maxTotalCost = cost;
        break;
      }
      case "--by": {
        const by = value();
        if (by !== "day" && by !== "month" && by !== "model")
          throw new Error(t("cli.error.invalid_usage_by"));
        parsed.usageBy = by;
        break;
      }
      case "--since": {
        const since = value();
        if (!/^\d{4}-\d{2}(-\d{2})?$/.test(since)) throw new Error(t("cli.error.invalid_since"));
        parsed.since = since;
        break;
      }
      case "--max-age-days":
        parsed.retention ??= {};
        parsed.retention.maxAgeDays = numberValue(name, value());
        break;
      case "--max-total-mb":
        parsed.retention ??= {};
        parsed.retention.maxTotalBytes = numberValue(name, value()) * 1024 * 1024;
        break;
      case "--image":
      case "-i":
        parsed.images.push(value());
        break;
      case "--arg":
        parsed.workflowArgs.push(value());
        break;
      case "--mcp-config":
        parsed.mcpConfig.push(value());
        break;
      case "--strict-mcp-config":
        parsed.strictMcpConfig = true;
        break;
      case "-o":
      case "--output-last-message":
        parsed.outputLastMessage = value();
        break;
      case "--thinking":
      case "--effort": {
        const raw = value();
        // `ultracode` of Claude Code is `xhigh` with its workflows on: here, `xhigh`.
        const level = raw === "ultracode" ? "xhigh" : raw;
        if (!(ThinkingLevel as readonly string[]).includes(level))
          throw new Error(t("cli.error.invalid_thinking", { levels: ThinkingLevel.join(", ") }));
        parsed.thinking = level as ThinkingLevel;
        break;
      }
      case "--tools":
        parsed.tools = value();
        break;
      // ponytail: Claude Code tries a comma list in order; here the first model only, as `fallback_model` has one.
      case "--fallback-model":
        parsed.fallbackModel = value().split(",")[0]?.trim();
        break;
      case "-w":
      case "--worktree":
        parsed.worktree = value();
        break;
      // The flags of `mcp add`, as `claude mcp add` spells them.
      case "-e":
      case "--env":
        parsed.serverEnv.push(value());
        break;
      case "-H":
      case "--header":
        parsed.headers.push(value());
        break;
      case "-t":
      case "--transport":
        parsed.transport = value();
        break;
      case "-s":
      case "--scope":
        parsed.scope = value();
        break;
      case "--overwrite":
        parsed.overwrite = true;
        break;
      case "--rollback":
        parsed.rollback = true;
        break;
      default:
        throw new Error(t("cli.error.unknown_option", { flag: name }));
    }
  }

  // `codex exec [resume <id> | resume --last | fork <id>] <prompt>` runs as `-p`.
  if (positionals[0] === "exec" && parsed.print === undefined && !promptLater) {
    const next = positionals[1];
    const verb = next === "resume" || next === "fork" ? next : undefined;
    positionals.splice(0, verb === undefined ? 1 : 2);
    if (verb === "fork" || (verb === "resume" && !parsed.continueLast)) {
      parsed.session = positionals.shift();
      if (parsed.session === undefined) throw new Error(t("cli.error.exec_session", { verb }));
      parsed.forkSession ||= verb === "fork";
    }
    promptLater = true;
  }
  if (promptLater) parsed.print = positionals.shift() ?? "-";
  if (settingsArg !== undefined) applyClaudeSettings(parsed, settingsArg, modeSet);
  // Claude Code puts the file before the text of `--append-system-prompt`, whatever the order of the flags.
  if (appendFileText !== undefined)
    parsed.appendSystemPrompt = [appendFileText, parsed.appendSystemPrompt]
      .filter((part) => part !== undefined)
      .join("\n\n");
  parsed.command = positionals[0];
  parsed.subcommand = positionals[1];
  parsed.args = positionals.slice(2);
  return parsed;
}

type LineSink = (line: string) => void;

/** `--settings <file|json>` of Claude Code: the keys that a run here has a flag for. A flag of the command wins. */
function applyClaudeSettings(parsed: ParsedArgv, raw: string, modeSet: boolean): void {
  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(raw.trimStart().startsWith("{") ? raw : readFileSync(raw, "utf8"));
  } catch (error) {
    throw new Error(t("cli.error.invalid_settings", { detail: (error as Error).message }));
  }
  const strings = (list: unknown): string[] =>
    Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : [];
  const permissions = (typeof settings.permissions === "object" ? settings.permissions : {}) as Record<
    string,
    unknown
  >;
  parsed.allowedTools.push(...strings(permissions.allow));
  parsed.disallowedTools.push(...strings(permissions.deny));
  parsed.askTools.push(...strings(permissions.ask));
  const mode = String(permissions.defaultMode);
  const agencyMode = Object.hasOwn(CLAUDE_PERMISSION_MODES, mode) ? CLAUDE_PERMISSION_MODES[mode] : mode;
  if (!modeSet && PERMISSION_MODES.includes(agencyMode as PermissionMode))
    parsed.permissionMode = agencyMode as PermissionMode;
  if (typeof settings.model === "string") parsed.model ??= settings.model;
  const fallback = Array.isArray(settings.fallbackModel) ? settings.fallbackModel[0] : settings.fallbackModel;
  if (typeof fallback === "string") parsed.fallbackModel ??= fallback;
  const effort = settings.effortLevel === "ultracode" ? "xhigh" : String(settings.effortLevel);
  if ((ThinkingLevel as readonly string[]).includes(effort)) parsed.thinking ??= effort as ThinkingLevel;
  const used = ["$schema", "permissions", "model", "fallbackModel", "effortLevel"];
  parsed.ignoredSettings = [
    ...Object.keys(settings).filter((key) => !used.includes(key)),
    ...Object.keys(permissions)
      .filter((key) => !["allow", "deny", "ask", "defaultMode"].includes(key))
      .map((key) => `permissions.${key}`),
  ];
}

/** The modes of `claude --permission-mode`; `plan` changes no file, as `deny` refuses each tool above `safe`. */
const CLAUDE_PERMISSION_MODES: Record<string, PermissionMode> = {
  default: "ask",
  manual: "ask",
  dontAsk: "ask",
  acceptEdits: "allow-edits",
  plan: "deny",
  bypassPermissions: "allow-all",
};

function workspaceRootOf(parsed: ParsedArgv, deps: EntrypointDeps): string {
  return resolve(deps.cwd ?? process.cwd(), parsed.workspace ?? ".");
}

function envOf(deps: EntrypointDeps): NodeJS.ProcessEnv {
  return deps.env ?? process.env;
}

/**
 * The flags layer for loadConfig: `--model` is taken as the config model ref,
 * with `--provider` overriding its provider part. `--provider` alone can't
 * form a ref without a model id, so it's applied after load instead (see
 * resolveModelRef).
 */
function flagsFor(parsed: ParsedArgv): Partial<Record<keyof Config, unknown>> {
  if (parsed.model === undefined) return {};
  if (parsed.provider === undefined) return { model: parsed.model };
  const slash = parsed.model.indexOf("/");
  const modelId = slash === -1 ? parsed.model : parsed.model.slice(slash + 1);
  return { model: `${parsed.provider}/${modelId}` };
}

/** provider+model for a turn: argv wins over config.model (which already
 *  contains the flags layer). A bare --model id (no slash) is only usable
 *  together with --provider. A bare --provider reuses the model id from
 *  config.model, falling back to that provider's catalog default. */
function resolveModelRef(
  config: Config,
  parsed: ParsedArgv,
  defaults: Record<string, string> = defaultModelIDs(BUILTIN_MODELS),
): { provider: string; model: string } {
  if (parsed.provider !== undefined && parsed.model === undefined) {
    const fromConfig = parseModelRef(config.model ?? "");
    if (fromConfig) {
      return { provider: parsed.provider, model: fromConfig.model };
    }
    const fallback = defaults[parsed.provider];
    if (fallback) {
      return { provider: parsed.provider, model: fallback };
    }
    throw new Error(t("cli.error.provider_without_model", { provider: parsed.provider }));
  }
  const ref = parseModelRef(config.model ?? "");
  if (!ref) throw new Error(t("cli.error.no_model"));
  return ref;
}

/** Pre-flight credential check: declared provider env names first, then
 *  flag -> env -> keychain -> config via resolveApiKey. Since A3 the key is
 *  NOT sent to the daemon (it resolves the same layers itself) — this exists
 *  only to fail fast with a clear message before any daemon work. */
async function validateTurnKey(provider: string, config: Config, deps: EntrypointDeps): Promise<void> {
  const env = envOf(deps);
  const keychain = deps.keychain ?? (await createKeychain(process.platform, join(dataDir(env), "keys")));
  const providerConfig = config.provider[provider];
  const key = await resolveApiKey({
    provider,
    env,
    keychain,
    declaredEnv: providerConfig?.env,
    config: providerConfig?.apiKey,
    oauthClientId: providerConfig?.oauth?.clientId,
    oauthBaseUrl: providerConfig?.oauth?.baseUrl,
  });
  if (key === undefined) throw new Error(t("cli.error.no_key", { provider }));
}

/** One row per known provider. `auth list` and the bare-run summary share it so they cannot disagree. */
async function providerConnections(
  config: Config,
  env: NodeJS.ProcessEnv,
  keychain: KeychainBackend,
): Promise<Array<{ provider: string; connected: boolean }>> {
  const builtin = ["anthropic", "chatgpt", "google", "openai", ...Object.keys(GATEWAY_BASE_URLS)];
  const ids = [...new Set([...builtin, ...Object.keys(config.provider)])].sort();
  const rows: Array<{ provider: string; connected: boolean }> = [];
  for (const id of ids) {
    const providerConfig = config.provider[id];
    const key = await resolveApiKey({
      provider: id,
      env,
      keychain,
      declaredEnv: providerConfig?.env,
      config: providerConfig?.apiKey,
      oauthClientId: providerConfig?.oauth?.clientId,
      oauthBaseUrl: providerConfig?.oauth?.baseUrl,
      // A sign-in whose refresh fails is not connected: the list does not fail for it.
    }).catch(() => undefined);
    rows.push({ provider: id, connected: key !== undefined });
  }
  return rows;
}

/** The error of a command group for a subcommand that is wrong or missing. */
function subcommandError(group: string, subcommand: string | undefined): Error {
  return new Error(
    subcommand === undefined
      ? t("cli.error.missing_subcommand", { command: group })
      : t("cli.error.unknown_command", { command: `${group} ${subcommand}` }),
  );
}

/** What `-p` prints in text mode: the reply to the prompt this run sent.
 *  A session turn returns the earlier turns too, and those are not output. */
function assistantText(messages: Message[]): string {
  const isCutNote = (message: Message) =>
    message.role === "user" &&
    message.content.some((block) => block.type === "text" && block.text === OUTPUT_CUT_NOTE);
  // The answer is the last assistant message and the parts that a cut note joins to it. A sentence that the
  // model wrote before a tool call is progress on stderr, not output: a script reads stdout as the answer.
  let start = messages.length;
  while (start > 0) {
    const message = messages[start - 1] as Message;
    if (message.role !== "assistant" && !isCutNote(message)) break;
    start -= 1;
  }
  const answer = messages
    .slice(start)
    .flatMap((message) => (message.role === "assistant" ? message.content : []))
    .flatMap((block) => (block.type === "text" ? [block.text] : []));
  if (answer.length > 0) return answer.join("\n");

  // No answer (a turn that stopped early): show every text of this run, so partial work is not lost.
  // The note after a cut reply is not a prompt: the parts before it are output too. A real model drops the
  // space at the cut ("22" then "23"), so the parts keep a line break between them and never merge.
  const prompt = messages.findLastIndex(
    (message) =>
      message.role === "user" &&
      message.content.some((block) => block.type === "text" && block.text !== OUTPUT_CUT_NOTE),
  );
  const parts: string[] = [];
  for (const message of messages.slice(prompt + 1)) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type === "text") parts.push(block.text);
    }
  }
  return parts.join("\n");
}

function printJsonOrText(out: LineSink, format: "text" | "json", payload: unknown, text: string): void {
  if (format === "json") out(JSON.stringify(payload, null, 2));
  else if (text.length > 0) out(text);
}

/** Prints a headless turn and returns its exit code; a salvaged turn names its cause on stderr. */
function reportTurn<T extends RunTurnRpcResult>(
  out: LineSink,
  err: LineSink,
  parsed: Pick<ParsedArgv, "format" | "streamJson" | "outputLastMessage">,
  result: T,
): number {
  if (parsed.outputLastMessage !== undefined) {
    const answer =
      "structuredOutput" in result ? JSON.stringify(result.structuredOutput) : assistantText(result.messages);
    writeFileSync(resolve(parsed.outputLastMessage), `${answer}\n`);
  }
  // A run that the cost limit cut is not finished: a script must not read it as success.
  const failed = result.stopReason === "error" || result.error !== undefined || result.budgetExceeded;
  const text = assistantText(result.messages);
  // The fields of `claude -p --output-format json` come first: a script for Claude Code reads `.result`.
  const payload = {
    type: "result",
    subtype: !failed
      ? "success"
      : result.error?.code === "iteration_limit"
        ? "error_max_turns"
        : "error_during_execution",
    is_error: failed,
    result: text,
    num_turns: result.messages.filter((message) => message.role === "assistant").length,
    ...("sessionId" in result ? { session_id: result.sessionId } : {}),
    ...(result.usage?.costUsd === undefined ? {} : { total_cost_usd: result.usage.costUsd }),
    ...result,
  };
  // The last line of a stream: one line, like each event before it.
  if (parsed.streamJson) out(JSON.stringify(payload));
  else printJsonOrText(out, parsed.format, payload, text);
  if (result.error && parsed.format === "text") err(`${result.error.code}: ${result.error.message}`);
  if (result.budgetExceeded && parsed.format === "text") err(t("cli.error.budget_exceeded"));
  return failed ? 1 : 0;
}

/** A session as Markdown, as `/export` of Claude Code writes one: the text, each tool call and its result. */
function sessionMarkdown(title: string, messages: Message[]): string {
  // A fence longer than any run of backticks in the text, so the text cannot close it.
  const fenced = (text: string, lang = ""): string => {
    const fence = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((run) => run[0].length + 1)));
    return `${fence}${lang}\n${text}\n${fence}`;
  };
  const parts = [`# ${title}`];
  for (const message of messages) {
    const lines: string[] = [];
    for (const block of message.content) {
      if (block.type === "text" && block.text.trim() !== "") lines.push(block.text);
      else if (block.type === "image") lines.push(`[${block.mimeType}]`);
      else if (block.type === "tool_call")
        lines.push(`Tool call \`${block.name}\`:\n\n${fenced(JSON.stringify(block.input, null, 2), "json")}`);
      else if (block.type === "tool_result")
        lines.push(`Result${block.isError ? " (error)" : ""}:\n\n${fenced(block.content)}`);
    }
    if (lines.length === 0) continue;
    const role = message.content.every((block) => block.type === "tool_result")
      ? "Tool results"
      : message.role === "user"
        ? "User"
        : "Assistant";
    parts.push(`## ${role}\n\n${lines.join("\n\n")}`);
  }
  return parts.join("\n\n");
}

/** `--resume <name>`, as in Claude Code: a value that is no session id is the title of one. */
function sessionIdOrName(store: SessionStore, value: string): string {
  const ids = store.list();
  if (ids.includes(value)) return value;
  return ids.find((id) => getSessionTitle(store.load(id)) === value) ?? value;
}

/** Copies a session to a new id and returns the id: `session fork`, and `-p --fork-session`. */
async function forkSession(store: SessionStore, id: string): Promise<string> {
  const forkId = `${id}-fork-${Date.now()}`;
  store.create(forkId);
  for (const entry of store.load(id)) await store.append(forkId, entry);
  return forkId;
}

/** Most recently appended session: the one `--continue` resumes. Ties break
 *  by readdir order; an empty session file sorts oldest. */
function latestSessionId(store: SessionStore): string | undefined {
  let latest: { id: string; createdAt: string } | undefined;
  for (const id of store.list()) {
    const entries = store.load(id);
    const createdAt = entries[entries.length - 1]?.createdAt ?? "";
    if (latest === undefined || createdAt > latest.createdAt) latest = { id, createdAt };
  }
  return latest?.id;
}

function loadImageBlocks(paths: string[]): import("@agency/schema").ImageBlock[] {
  const blocks: import("@agency/schema").ImageBlock[] = [];
  for (const p of paths) {
    let data: Buffer;
    try {
      data = readFileSync(p);
    } catch {
      // A prompt that goes out with no image gets an answer about some other thing.
      throw new Error(t("cli.error.image_unreadable", { path: p }));
    }
    // A PDF goes as a document, as the `read` tool attaches one.
    blocks.push({ type: "image", mimeType: imageMimeFor(p) ?? "image/png", data: data.toString("base64") });
  }
  return blocks;
}

/** `-p` headless mode. Without --continue/--session the turn is one-shot
 *  (runHeadless, nothing persisted); with them, the turn runs against a
 *  persisted session via runSessionTurn. Either way the process exits once
 *  the turn completes. */
async function runPrintMode(
  parsed: ParsedArgv,
  prompt: string,
  deps: EntrypointDeps,
  out: LineSink,
  err: LineSink,
): Promise<number> {
  if (parsed.continueLast && parsed.session !== undefined) {
    throw new Error(t("cli.error.session_conflict"));
  }

  const workspaceRoot =
    parsed.worktree === undefined
      ? workspaceRootOf(parsed, deps)
      : worktreeRoot(parsed.worktree, workspaceRootOf(parsed, deps), err);
  const env = envOf(deps);
  const config = loadConfig({ globalDir: deps.configDir, env, flags: flagsFor(parsed) });
  const { provider, model } = resolveModelRef(config, parsed);
  await validateTurnKey(provider, config, deps);
  // Each rule of a run must hold: a rule that maps to nothing here would let through a call that the user denied.
  let permissions: Record<string, ToolPermissionValue> | undefined;
  // As in Claude Code, a deny of `*` takes every tool away, and of `mcp__*` every MCP tool.
  const denyAll = parsed.disallowedTools.includes("*");
  const denyMcp = denyAll || parsed.disallowedTools.includes("mcp__*");
  const denyRules = parsed.disallowedTools.filter((rule) => rule !== "*" && rule !== "mcp__*");
  if (parsed.ignoredSettings.length > 0)
    err(t("cli.progress.settings_ignored", { keys: parsed.ignoredSettings.join(", ") }));
  if (parsed.allowedTools.length > 0 || parsed.askTools.length > 0 || denyRules.length > 0) {
    const rules = permissionsFromRules({ allow: parsed.allowedTools, ask: parsed.askTools, deny: denyRules });
    if (rules.skipped.length > 0)
      throw new Error(t("cli.error.unknown_rules", { rules: rules.skipped.join(", ") }));
    permissions = rules.permissions;
  }
  let tools: string[] | undefined;
  if (parsed.tools !== undefined && parsed.tools.trim() !== "default") {
    const names = parsed.tools.split(/[\s,]+/).filter(Boolean);
    const unknown = names.filter((name) => agencyToolName(name) === undefined);
    if (unknown.length > 0) throw new Error(t("cli.error.unknown_rules", { rules: unknown.join(", ") }));
    tools = names.map((name) => agencyToolName(name) as string);
  }
  if (denyAll) tools = [];
  let mcp: { servers: Record<string, unknown>; strict: boolean } | undefined;
  if (parsed.mcpConfig.length > 0 || parsed.strictMcpConfig) {
    const servers: Record<string, unknown> = {};
    for (const value of parsed.mcpConfig) {
      try {
        Object.assign(servers, loadMcpConfigArg(value, deps.cwd ?? process.cwd(), env));
      } catch (error) {
        throw new Error(
          t("cli.error.invalid_mcp_config", {
            detail: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
    mcp = { servers, strict: parsed.strictMcpConfig };
  }
  if (denyMcp) mcp = { servers: {}, strict: true };
  // OpenAI asks an app to show while the plan pays.
  if (provider === CHATGPT_PROVIDER && parsed.format !== "json" && !parsed.streamJson) {
    err(t("cli.progress.chatgpt_plan", { url: CHATGPT_USAGE_URL }));
  }

  let outputSchema: Record<string, unknown> | undefined;
  if (parsed.jsonSchema !== undefined) {
    if (parsed.continueLast || parsed.session !== undefined) throw new Error(t("cli.error.schema_session"));
    try {
      const raw = parsed.jsonSchema.trimStart().startsWith("{")
        ? parsed.jsonSchema
        : readFileSync(resolve(deps.cwd ?? process.cwd(), parsed.jsonSchema), "utf8");
      outputSchema = JSON.parse(raw) as Record<string, unknown>;
    } catch (error) {
      throw new Error(
        t("cli.error.invalid_schema", { detail: error instanceof Error ? error.message : String(error) }),
      );
    }
  }
  // Progress events: printed to stderr in text mode, silent in JSON mode.
  // A model sends text in small parts: they collect into whole lines, and a part line ends before any other line.
  let partLine = "";
  const line = (text: string) => {
    if (partLine) err(t("cli.progress.text", { text: partLine }));
    partLine = "";
    err(text);
  };
  const onEvent = parsed.streamJson
    ? (event: unknown) => out(JSON.stringify(event))
    : parsed.format === "json"
      ? undefined
      : (event: unknown) => {
          const ev = event as Record<string, unknown>;
          switch (ev.type) {
            case "tool_start":
              line(t("cli.progress.tool", { name: String(ev.name ?? ev.id ?? "?") }));
              break;
            case "text_delta": {
              const lines = (partLine + String(ev.text ?? "")).split("\n");
              partLine = lines.pop() ?? "";
              for (const whole of lines) err(t("cli.progress.text", { text: whole }));
              break;
            }
            case "heartbeat":
              line(t("cli.progress.heartbeat"));
              break;
            case "retry":
              line(
                t("cli.progress.retry", {
                  attempt: String(ev.attempt ?? "?"),
                  message: String(ev.message ?? ""),
                }),
              );
              break;
            case "turn_complete":
              line(t("cli.progress.turn_complete", { reason: String(ev.stopReason ?? "?") }));
              break;
          }
        };

  if (parsed.goal !== undefined && !parsed.continueLast && parsed.session === undefined) {
    throw new Error(t("cli.error.goal_needs_session"));
  }
  if (parsed.forkSession && !parsed.continueLast && parsed.session === undefined) {
    throw new Error(t("cli.error.fork_needs_session"));
  }
  if (parsed.continueLast || parsed.session !== undefined) {
    const store = new SessionStore(deps.sessionsDir ?? storagePaths(workspaceRoot, env).sessionsDir, {
      bus: deps.bus ?? new EventBus(),
    });
    let sessionId = parsed.session;
    if (sessionId === undefined) {
      sessionId = latestSessionId(store);
      if (sessionId === undefined) throw new Error(t("cli.error.no_sessions"));
    }
    sessionId = sessionIdOrName(store, sessionId);
    const ids = store.list();
    if (parsed.forkSession) {
      if (!ids.includes(sessionId)) throw new Error(t("cli.error.unknown_session", { id: sessionId }));
      sessionId = await forkSession(store, sessionId);
    }
    if (parsed.name !== undefined && parsed.name.trim() !== "") {
      const tip = store.latestTip(store.load(sessionId)) ?? null;
      await store.append(sessionId, { type: "session_title", parentId: tip, title: parsed.name.trim() });
    }

    const client = deps.ensureClient
      ? await deps.ensureClient({ workspaceRoot, instanceDir: deps.instanceDir })
      : (await connectHeadlessClient({ workspaceRoot, instanceDir: deps.instanceDir, log: err })).client;
    try {
      const images = parsed.images.length ? loadImageBlocks(parsed.images) : undefined;
      const { result, tipId } = await runSessionTurn(client, {
        sessionId,
        provider,
        model,
        systemPrompt: basePrompt(parsed),
        userText: prompt,
        images,
        onEvent,
        permissionMode: parsed.permissionMode,
        ...(permissions === undefined ? {} : { permissions }),
        ...(mcp === undefined ? {} : { mcp }),
        ...(parsed.fallbackModel === undefined ? {} : { fallbackModel: parsed.fallbackModel }),
        ...(tools === undefined ? {} : { tools }),
        maxToolIterations: parsed.maxSteps,
        ...(parsed.thinking === undefined ? {} : { thinkingLevel: parsed.thinking }),
        ...(parsed.goal === undefined ? {} : { goal: parsed.goal }),
        ...(parsed.maxCost === undefined ? {} : { budget: { maxCostUsd: parsed.maxCost } }),
        nonInteractive: true,
      });
      return reportTurn(out, err, parsed, { sessionId, tipId, ...result });
    } finally {
      await client.close();
    }
  }

  const images = parsed.images.length ? loadImageBlocks(parsed.images) : undefined;
  const result = await (deps.runHeadless ?? runHeadless)({
    workspaceRoot,
    instanceDir: deps.instanceDir,
    provider,
    model,
    systemPrompt: basePrompt(parsed),
    prompt: outputSchema === undefined ? prompt : `${prompt}\n\n${STRUCTURED_OUTPUT_NOTE}`,
    ...(outputSchema === undefined ? {} : { outputSchema }),
    images,
    onEvent,
    permissionMode: parsed.permissionMode,
    ...(permissions === undefined ? {} : { permissions }),
    ...(mcp === undefined ? {} : { mcp }),
    ...(parsed.fallbackModel === undefined ? {} : { fallbackModel: parsed.fallbackModel }),
    ...(tools === undefined ? {} : { tools }),
    maxToolIterations: parsed.maxSteps,
    ...(parsed.thinking === undefined ? {} : { thinkingLevel: parsed.thinking }),
    ...(parsed.maxCost === undefined ? {} : { budget: { maxCostUsd: parsed.maxCost } }),
  });
  if (outputSchema === undefined) return reportTurn(out, err, parsed, result);
  const answer = result.messages
    .flatMap((m) => m.content)
    .findLast((b) => b.type === "tool_call" && b.name === STRUCTURED_OUTPUT_TOOL);
  if (answer?.type !== "tool_call") {
    reportTurn(out, err, parsed, result);
    err(t("cli.error.no_structured_output"));
    return 1;
  }
  if (parsed.format === "text" && !parsed.streamJson) {
    out(JSON.stringify(answer.input));
    return reportTurn(() => {}, err, parsed, { ...result, structuredOutput: answer.input });
  }
  return reportTurn(out, err, parsed, { ...result, structuredOutput: answer.input });
}

/** `-p --worktree <name>`: the turn runs in `.agency/worktrees/<name>` of the repository, on the branch `agency/<name>`,
 *  as `claude --worktree` does. A later run with the same name uses the same worktree. */
function worktreeRoot(name: string, workspaceRoot: string, err: LineSink): string {
  if (!/^\w[\w.-]*$/.test(name)) throw new Error(t("cli.error.worktree_name", { name }));
  const git = (...args: string[]): Bun.SyncSubprocess<"pipe", "pipe"> =>
    Bun.spawnSync(["git", ...args], { cwd: workspaceRoot });
  const top = git("rev-parse", "--show-toplevel");
  if (top.exitCode !== 0)
    throw new Error(t("cli.error.worktree_git", { detail: top.stderr.toString().trim() }));
  const dir = join(top.stdout.toString().trim(), ".agency", "worktrees", name);
  if (existsSync(dir)) return dir;
  mkdirSync(dirname(dir), { recursive: true });
  writeFileSync(join(dirname(dir), ".gitignore"), "*\n");
  const branch = `agency/${name}`;
  const known = git("rev-parse", "--verify", "--quiet", `refs/heads/${branch}`).exitCode === 0;
  const add = known ? git("worktree", "add", dir, branch) : git("worktree", "add", "-b", branch, dir, "HEAD");
  if (add.exitCode !== 0)
    throw new Error(t("cli.error.worktree_git", { detail: add.stderr.toString().trim() }));
  err(t("cli.progress.worktree", { path: dir, branch }));
  return dir;
}

/** `mcp serve`: each call of the `agency` tool is a `-p --session` turn. The permission mode comes from the flags of
 *  the server only: the caller is a model, and must not choose its own permissions. */
function mcpServeCmd(
  parsed: ParsedArgv,
  deps: EntrypointDeps,
  out: LineSink,
  err: LineSink,
): Promise<number> {
  if (deps.mcpInput === undefined) {
    // ponytail: the protocol owns stdout, so a stray console.log goes to stderr. Process-wide, as a real server is.
    console.log = console.error;
  }
  return mcpServe({
    version: VERSION,
    input: deps.mcpInput ?? createInterface({ input: process.stdin }),
    out,
    turn: async (call) => {
      let payload = "";
      const run: ParsedArgv = {
        ...parsed,
        format: "json",
        streamJson: false,
        session: call.session,
        ...(call.cwd === undefined ? {} : { workspace: call.cwd }),
        ...(call.model === undefined ? {} : { model: call.model, provider: undefined }),
      };
      try {
        await runPrintMode(run, call.prompt, deps, (line) => (payload = line), err);
        const result = JSON.parse(payload) as RunTurnRpcResult;
        const text = assistantText(result.messages);
        const failure =
          result.error?.message ?? (result.budgetExceeded ? t("cli.error.budget_exceeded") : undefined);
        return failure === undefined
          ? { text, isError: false }
          : { text: [text, failure].filter(Boolean).join("\n"), isError: true };
      } catch (error) {
        return { text: error instanceof Error ? error.message : String(error), isError: true };
      }
    },
  });
}

const STRUCTURED_OUTPUT_NOTE = `When the work is done, call the ${STRUCTURED_OUTPUT_TOOL} tool one time with the final answer.`;
const REVIEW_MAX_DIFF_CHARS = 200_000;

/** `review [<ref>]`: one turn over the diff. The mode is `ask` with no person to ask, so an edit or a command is refused. */
async function reviewCmd(
  parsed: ParsedArgv,
  deps: EntrypointDeps,
  out: LineSink,
  err: LineSink,
): Promise<number> {
  const cwd = workspaceRootOf(parsed, deps);
  const ref = parsed.subcommand;
  const git = (...args: string[]): string => {
    const done = Bun.spawnSync(["git", ...args], { cwd });
    if (done.exitCode !== 0)
      throw new Error(t("cli.error.review_git", { detail: done.stderr.toString().trim() }));
    return done.stdout.toString();
  };
  const diff = ref === undefined ? git("diff", "HEAD") : git("diff", `${ref}...HEAD`);
  const untracked = ref === undefined ? git("ls-files", "--others", "--exclude-standard").trim() : "";
  if (diff.trim() === "" && untracked === "") {
    out(t("cli.review.no_changes"));
    return 0;
  }
  const prompt = [
    "Review these changes as a careful senior engineer. Read the files around a change when the diff alone does not show if it is correct.",
    "Report only real problems: bugs, security faults, broken behaviour, missing tests for changed logic. No style notes.",
    "For each finding give the file and line, what is wrong, and a concrete case that fails. Put the most severe first. If you find nothing, say so in one line.",
    "Do not change any file.",
    untracked === "" ? "" : `New files that are not in the diff, read them:\n${untracked}`,
    diff.length > REVIEW_MAX_DIFF_CHARS
      ? `The diff is too large to show in full. Its first part:\n${diff.slice(0, REVIEW_MAX_DIFF_CHARS)}`
      : `The diff:\n${diff}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return runPrintMode({ ...parsed, permissionMode: "ask" }, prompt, deps, out, err);
}

/** `workflow run <file>`: each `agent()` of the script is one headless turn with a new context, as `-p` runs it. */
async function workflowCmd(
  parsed: ParsedArgv,
  deps: EntrypointDeps,
  out: LineSink,
  err: LineSink,
): Promise<number> {
  if (parsed.subcommand !== "run") throw subcommandError("workflow", parsed.subcommand);
  const file = parsed.args[0];
  if (file === undefined) throw new Error(t("cli.error.missing_value", { flag: "workflow run <file>" }));
  const args: Record<string, string> = {};
  for (const pair of parsed.workflowArgs) {
    const at = pair.indexOf("=");
    if (at < 1) throw new Error(t("cli.error.workflow_arg", { value: pair }));
    args[pair.slice(0, at)] = pair.slice(at + 1);
  }

  const workspaceRoot = workspaceRootOf(parsed, deps);
  const config = loadConfig({ globalDir: deps.configDir, env: envOf(deps), flags: flagsFor(parsed) });
  let started = 0;
  // Turns in parallel each get what is left at their start, so they can go over the total together.
  let spent = 0;
  const result = await runWorkflow(file, {
    args,
    log: err,
    parallel: runParallel,
    agent: async (prompt, options = {}): Promise<WorkflowAgentResult> => {
      const ref =
        options.model === undefined ? resolveModelRef(config, parsed) : parseModelRef(options.model);
      if (!ref) throw new Error(t("cli.error.no_model"));
      await validateTurnKey(ref.provider, config, deps);
      const n = ++started;
      err(t("cli.workflow.agent_start", { n: String(n), prompt: prompt.replace(/\s+/g, " ").slice(0, 80) }));
      const left = parsed.maxTotalCost === undefined ? undefined : parsed.maxTotalCost - spent;
      if (left !== undefined && left <= 0) {
        err(t("cli.workflow.agent_end", { n: String(n), reason: "total_cost_limit" }));
        return {
          text: "",
          stopReason: "total_cost_limit",
          usage: { inputTokens: 0, outputTokens: 0 },
          ok: false,
        };
      }
      const turnCost = options.maxCost ?? parsed.maxCost;
      const maxCost = left === undefined ? turnCost : Math.min(turnCost ?? left, left);
      const turn = await (deps.runHeadless ?? runHeadless)({
        workspaceRoot,
        instanceDir: deps.instanceDir,
        provider: ref.provider,
        model: ref.model,
        systemPrompt: basePrompt(parsed),
        prompt,
        permissionMode: options.permissionMode ?? parsed.permissionMode,
        maxToolIterations: options.maxSteps ?? parsed.maxSteps,
        ...(maxCost === undefined ? {} : { budget: { maxCostUsd: maxCost } }),
      });
      spent += turn.usage.costUsd ?? 0;
      err(t("cli.workflow.agent_end", { n: String(n), reason: turn.error?.code ?? turn.stopReason }));
      return {
        text: assistantText(turn.messages),
        stopReason: turn.stopReason,
        usage: turn.usage,
        ok: turn.stopReason !== "error" && !turn.error && !turn.budgetExceeded,
      };
    },
  });
  if (typeof result === "string") out(result);
  else if (result !== undefined) out(JSON.stringify(result, null, 2));
  return 0;
}

function whereCmd(parsed: ParsedArgv, deps: EntrypointDeps, out: LineSink): number {
  if (parsed.format === "json") {
    out(
      JSON.stringify(
        { ...storagePaths(workspaceRootOf(parsed, deps), envOf(deps)), ...wherePaths(envOf(deps)) },
        null,
        2,
      ),
    );
  } else {
    out(whereCommand(envOf(deps)));
  }
  return 0;
}

async function storageCmd(parsed: ParsedArgv, deps: EntrypointDeps, out: LineSink): Promise<number> {
  const env = envOf(deps);
  if (parsed.subcommand === "prune") {
    const output = await pruneCommand(parsed.retention, env);
    if (parsed.format === "json") out(JSON.stringify({ result: output }, null, 2));
    else out(output);
    return 0;
  }
  if (parsed.subcommand !== undefined) {
    throw new Error(t("cli.error.unknown_command", { command: `storage ${parsed.subcommand}` }));
  }
  if (parsed.format === "json") out(JSON.stringify(await reportStorage(env), null, 2));
  else out(await storageCommand(env));
  return 0;
}

function sessionCmd(parsed: ParsedArgv, deps: EntrypointDeps, out: LineSink, err: LineSink): Promise<number> {
  return runSessionCmd(parsed, deps, out, err);
}

async function runSessionCmd(
  parsed: ParsedArgv,
  deps: EntrypointDeps,
  out: LineSink,
  err: LineSink,
): Promise<number> {
  const store = new SessionStore(
    deps.sessionsDir ?? storagePaths(workspaceRootOf(parsed, deps), envOf(deps)).sessionsDir,
  );

  if (parsed.subcommand === "list") {
    const query = parsed.args[0]?.toLowerCase();
    const rows = store
      .list()
      .map((id) => {
        const entries = store.load(id);
        const title = getSessionTitle(entries);
        return { id, title: title ?? null, createdAt: entries[0]?.createdAt ?? "", entries: entries.length };
      })
      .filter(
        (row) =>
          query === undefined ||
          row.id.toLowerCase().includes(query) ||
          (row.title?.toLowerCase().includes(query) ?? false),
      )
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    if (parsed.format === "json") out(JSON.stringify(rows, null, 2));
    else if (rows.length === 0) out(t("tui.browser.empty"));
    else
      for (const row of rows) out(`${row.id}\t${row.title ?? "-"}\t${row.createdAt || "-"}\t${row.entries}`);
    return 0;
  }

  if (parsed.subcommand === "show") {
    const id = parsed.args[0] === undefined ? undefined : sessionIdOrName(store, parsed.args[0]);
    if (id === undefined) {
      err(t("cli.session.show_usage"));
      return 1;
    }
    if (!store.list().includes(id)) {
      err(t("cli.error.unknown_session", { id }));
      return 1;
    }
    const entries = store.load(id);
    const title = getSessionTitle(entries);
    const createdAt = entries[0]?.createdAt ?? "-";
    if (parsed.format === "json") {
      out(JSON.stringify({ id, title: title ?? null, createdAt, entries: entries.length }, null, 2));
    } else {
      out(t("cli.session.shown", { id, entries: String(entries.length), createdAt }));
      if (title) out(`  title: ${title}`);
    }
    return 0;
  }

  if (parsed.subcommand === "export") {
    const id = parsed.args[0] === undefined ? undefined : sessionIdOrName(store, parsed.args[0]);
    if (id === undefined) {
      err(t("cli.session.export_usage"));
      return 1;
    }
    if (!store.list().includes(id)) {
      err(t("cli.error.unknown_session", { id }));
      return 1;
    }
    const entries = store.load(id);
    const tip = store.latestTip(entries);
    const markdown = sessionMarkdown(
      getSessionTitle(entries) ?? id,
      tip === undefined ? [] : store.messagesFor(entries, tip),
    );
    if (parsed.outputLastMessage === undefined) out(markdown);
    else {
      writeFileSync(resolve(deps.cwd ?? process.cwd(), parsed.outputLastMessage), `${markdown}\n`);
      out(t("cli.session.exported", { id, path: parsed.outputLastMessage }));
    }
    return 0;
  }

  if (parsed.subcommand === "rename") {
    const id = parsed.args[0];
    const newTitle = parsed.args[1];
    if (id === undefined || newTitle === undefined) {
      err(t("cli.session.rename_usage"));
      return 1;
    }
    if (newTitle.trim().length === 0) {
      err(t("cli.session.rename_empty"));
      return 1;
    }
    if (!store.list().includes(id)) {
      err(t("cli.error.unknown_session", { id }));
      return 1;
    }
    const entries = store.load(id);
    const tipId = store.latestTip(entries) ?? null;
    await store.append(id, { type: "session_title", parentId: tipId, title: newTitle.trim() });
    out(
      parsed.format === "json"
        ? JSON.stringify({ renamed: id, title: newTitle.trim() }, null, 2)
        : t("cli.session.renamed", { id, title: newTitle.trim() }),
    );
    return 0;
  }

  if (parsed.subcommand === "fork") {
    const id = parsed.args[0] === undefined ? undefined : sessionIdOrName(store, parsed.args[0]);
    if (id === undefined) {
      err(t("cli.session.fork_usage"));
      return 1;
    }
    if (!store.list().includes(id)) {
      err(t("cli.error.unknown_session", { id }));
      return 1;
    }
    const forkId = await forkSession(store, id);
    out(
      parsed.format === "json"
        ? JSON.stringify({ forkId, sourceId: id }, null, 2)
        : t("cli.session.forked", { id, forkId }),
    );
    return 0;
  }

  if (parsed.subcommand === "clone") {
    const id = parsed.args[0];
    if (id === undefined) {
      err(t("cli.session.clone_usage"));
      return 1;
    }
    if (!store.list().includes(id)) {
      err(t("cli.error.unknown_session", { id }));
      return 1;
    }
    const meta = store.clone(id, parsed.args[1]);
    out(
      parsed.format === "json"
        ? JSON.stringify({ cloneId: meta.id, sourceId: id }, null, 2)
        : t("cli.session.cloned", { id, cloneId: meta.id }),
    );
    return 0;
  }

  if (parsed.subcommand === "delete") {
    const id = parsed.args[0];
    if (id === undefined) {
      err(t("cli.error.session_delete_usage"));
      return 1;
    }
    if (!store.list().includes(id)) {
      err(t("cli.error.unknown_session", { id }));
      return 1;
    }
    store.delete(id);
    out(
      parsed.format === "json" ? JSON.stringify({ deleted: id }, null, 2) : t("cli.session.deleted", { id }),
    );
    return 0;
  }

  // Subcommand --help
  if (parsed.subcommand === "--help" || parsed.subcommand === "-h") {
    out(`Usage: agency session <subcommand> [args]

Subcommands:
  list                   List sessions (id, title, created, entries)
  show <id>              Show session details
  rename <id> <title>    Rename a session
  fork <id>              Fork (clone) a session under a new id
  clone <id> [newId]      Clone a session file under a new (or given) id
  delete <id>            Delete a session by id`);
    return 0;
  }

  throw subcommandError("session", parsed.subcommand);
}

function defaultKeyReader(prompt: string): Promise<string> {
  if (process.stdin.isTTY) return readSecretLine(prompt);
  return new Promise((resolvePiped, rejectPiped) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.once("end", () => resolvePiped(Buffer.concat(chunks).toString("utf8").trim()));
    process.stdin.once("error", rejectPiped);
  });
}

async function authCmd(
  parsed: ParsedArgv,
  deps: EntrypointDeps,
  out: LineSink,
  err: LineSink,
): Promise<number> {
  const env = envOf(deps);
  const keychain = deps.keychain ?? (await createKeychain(process.platform, join(dataDir(env), "keys")));

  if (parsed.subcommand === "login") {
    const provider = parsed.args[0];
    if (provider === undefined) {
      err(t("cli.error.auth_login_usage"));
      return 1;
    }
    if (provider === CHATGPT_PROVIDER) return chatgptLogin(keychain, deps, out, err);
    // Anthropic's terms do not permit a Claude sign-in in another app: there is no flow to offer.
    if (parsed.oauth && provider === "anthropic") {
      err(t("cli.error.auth_anthropic_subscription"));
      return 1;
    }
    if (parsed.oauth && provider === "openai") {
      err(t("cli.error.auth_openai_oauth"));
      return 1;
    }
    if (parsed.device) {
      if (!OAUTH_PROVIDERS[provider]) {
        err(t("cli.error.auth_oauth_unsupported", { provider }));
        return 1;
      }
      if (!supportsDeviceFlow(provider)) {
        err(t("cli.error.auth_oauth_unsupported", { provider }));
        return 1;
      }
      const config = loadConfig({ globalDir: deps.configDir, env });
      const oauth = config.provider[provider]?.oauth;
      try {
        if (deps.deviceFlow) await deps.deviceFlow(provider, keychain);
        else
          await runDeviceFlow(provider, keychain, {
            clientId: oauth?.clientId,
            baseUrl: oauth?.baseUrl,
            onUserCode: (info) => out(`${info.userCode} ${info.verificationUri}`),
          });
      } catch (error) {
        err(error instanceof Error ? error.message : String(error));
        return 1;
      }
      out(t("cli.auth.oauth_stored", { provider, backend: keychain.name }));
      return 0;
    }
    if (parsed.oauth) {
      if (!OAUTH_PROVIDERS[provider]) {
        err(t("cli.error.auth_oauth_unsupported", { provider }));
        return 1;
      }
      const config = loadConfig({ globalDir: deps.configDir, env });
      const oauth = config.provider[provider]?.oauth;
      try {
        if (deps.oauthFlow) await deps.oauthFlow(provider, keychain);
        else await runOAuthFlow(provider, keychain, { clientId: oauth?.clientId, baseUrl: oauth?.baseUrl });
      } catch (error) {
        err(error instanceof Error ? error.message : String(error));
        return 1;
      }
      out(t("cli.auth.oauth_stored", { provider, backend: keychain.name }));
      return 0;
    }
    const key = await (deps.keyReader ?? defaultKeyReader)(t("cli.auth.key_prompt", { provider }));
    if (key.length === 0) {
      err(t("tui.connect.no_key"));
      return 1;
    }
    await keychain.set(provider, key);
    out(t("tui.connect.stored", { provider, backend: keychain.name }));
    return 0;
  }

  if (parsed.subcommand === "logout") {
    const provider = parsed.args[0];
    if (provider === undefined) {
      err(t("cli.error.auth_logout_usage"));
      return 1;
    }
    if (provider === CHATGPT_PROVIDER) {
      const revoked = await signOutChatgpt(keychain, deps.chatgptFetch);
      out(t(revoked ? "cli.auth.chatgpt_signed_out" : "cli.auth.chatgpt_revoke_unconfirmed"));
      return 0;
    }
    await keychain.delete(provider);
    await keychain.delete(oauthKey(provider));
    out(t("cli.auth.removed", { provider, backend: keychain.name }));
    return 0;
  }

  if (parsed.subcommand === "list") {
    const rows = await providerConnections(loadConfig({ globalDir: deps.configDir, env }), env, keychain);
    if (parsed.format === "json") {
      out(JSON.stringify(Object.fromEntries(rows.map((r) => [r.provider, r.connected])), null, 2));
    } else {
      for (const row of rows) {
        out(
          row.connected
            ? t("cli.auth.connected", { provider: row.provider })
            : t("cli.auth.disconnected", { provider: row.provider }),
        );
      }
    }
    return 0;
  }

  throw subcommandError("auth", parsed.subcommand);
}

/** `auth login chatgpt`: Sign in with ChatGPT, in the words that OpenAI asks a CLI to use. */
async function chatgptLogin(
  keychain: KeychainBackend,
  deps: EntrypointDeps,
  out: LineSink,
  err: LineSink,
): Promise<number> {
  const first = (await getChatgptCredential(keychain)) === undefined;
  out(t("cli.auth.chatgpt_continue"));
  try {
    const credential = await signInChatgpt(keychain, {
      ...(deps.openUrl ? { openUrl: deps.openUrl } : {}),
      ...(deps.chatgptFetch ? { fetchFn: deps.chatgptFetch } : {}),
    });
    if (first) out(t("cli.auth.chatgpt_plan_notice", { url: CHATGPT_USAGE_URL }));
    out(t("cli.auth.chatgpt_signed_in", { account: credential.email ?? credential.subject }));
    const models = await listChatgptModels(credential.accessToken, deps.chatgptFetch).catch(() => []);
    if (models.length > 0) {
      out(t("cli.auth.chatgpt_models", { models: models.map((m) => `chatgpt/${m.slug}`).join(", ") }));
    }
    return 0;
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

/** One row of `turns_list`: a turn that runs in the daemon. */
interface ActiveTurn {
  turnId: string;
  sessionId: string;
  provider: string;
  model: string;
  startedAt: string;
}

/** `daemon cancel <turn>`: stops a turn that another terminal started. `daemon status` gives the id. */
async function daemonCancelCmd(parsed: ParsedArgv, deps: EntrypointDeps, out: LineSink): Promise<number> {
  const turnId = parsed.args[0];
  if (turnId === undefined) throw new Error(t("cli.error.missing_value", { flag: "daemon cancel <turn>" }));
  const { defaultInstanceDir } = await import("./headless.ts");
  const instanceDir = deps.instanceDir ?? defaultInstanceDir(envOf(deps));
  const instanceFile = join(instanceDir, `${hashWorkspaceRoot(workspaceRootOf(parsed, deps))}.json`);
  let client: DaemonClient | undefined;
  try {
    const info = JSON.parse(readFileSync(instanceFile, "utf8")) as InstanceInfo;
    client = await connectToDaemon(info.port, "127.0.0.1", { token: info.token });
  } catch {
    throw new Error(t("cli.daemon.not_running"));
  }
  try {
    const { cancelled } = (await client.call("cancel_turn", { turnId })) as { cancelled: boolean };
    if (!cancelled) throw new Error(t("cli.daemon.no_such_turn", { turnId }));
    out(t("cli.daemon.cancelled", { turnId }));
    return 0;
  } finally {
    await client.close();
  }
}

async function daemonStatusCmd(
  parsed: ParsedArgv,
  deps: EntrypointDeps,
  out: LineSink,
  _err: LineSink,
): Promise<number> {
  const workspaceRoot = workspaceRootOf(parsed, deps);
  const env = envOf(deps);
  const { defaultInstanceDir } = await import("./headless.ts");
  const instanceDir = deps.instanceDir ?? defaultInstanceDir(env);
  const instanceFile = join(instanceDir, `${hashWorkspaceRoot(workspaceRoot)}.json`);
  let info: InstanceInfo | undefined;
  try {
    info = JSON.parse(readFileSync(instanceFile, "utf8")) as InstanceInfo;
  } catch {
    info = undefined;
  }
  if (info !== undefined) {
    let client: DaemonClient | undefined;
    try {
      client = await connectToDaemon(info.port, "127.0.0.1", { token: info.token });
      const { turns } = (await client.call("turns_list", {})) as { turns: ActiveTurn[] };
      if (parsed.format === "json") {
        out(JSON.stringify({ status: "running", port: info.port, pid: info.pid ?? null, turns }, null, 2));
      } else {
        out(
          t("cli.daemon.status", {
            status: "running",
            port: String(info.port),
            pid: String(info.pid ?? "?"),
          }),
        );
        for (const turn of turns) {
          out(t("cli.daemon.turn", { ...turn, model: `${turn.provider}/${turn.model}` }));
        }
      }
      return 0;
    } catch {
    } finally {
      await client?.close();
    }
  }
  if (parsed.format === "json") {
    out(JSON.stringify({ status: "not_running" }, null, 2));
  } else {
    out(t("cli.daemon.not_running"));
  }
  return 0;
}

async function pluginCmd(
  parsed: ParsedArgv,
  deps: EntrypointDeps,
  out: LineSink,
  err: LineSink,
): Promise<number> {
  const workspaceRoot = workspaceRootOf(parsed, deps);

  // Subcommand help
  if (parsed.subcommand === "--help" || parsed.subcommand === "-h") {
    out(`Usage: agency plugin <subcommand> [args]

Subcommands:
  install <source> [plugin] [--overwrite]
                               Install a Claude Code / Codex plugin from a folder, a git URL or
                               owner/repo (#ref for a branch or tag). [plugin] picks one of a marketplace
  list                         Show installed skills and plugin modules
  install <plugin>@<marketplace>
                               Install a plugin of a marketplace that the Claude Code settings name
  sync [--overwrite]           Install the enabledPlugins of .claude/settings.json
  update <name>                Install a plugin again from the source of its install
  remove <name>                Remove an installed plugin`);
    return 0;
  }

  if (parsed.subcommand === "install") {
    const sourceDir = parsed.args[0];
    if (sourceDir === undefined) {
      err(t("cli.error.missing_value", { flag: "sourceDir" }));
      return 1;
    }
    try {
      // `plugin@marketplace`, as Claude Code names a plugin: the marketplace comes from its settings.
      const byId =
        parsed.args[1] === undefined && /^[\w.-]+@[\w.-]+$/.test(sourceDir) && !existsSync(sourceDir)
          ? claudePluginSource(sourceDir, workspaceRoot)
          : undefined;
      const report = pluginInstallSource(
        byId?.source ?? sourceDir,
        byId?.plugin ?? parsed.args[1],
        workspaceRoot,
        parsed.overwrite,
        err,
      );
      out(report);
      const { createFileTrustStore } = await import("@agency/guard");
      const trustStore = createFileTrustStore(join(dataDir(envOf(deps)), "trust.json"));
      if (!trustStore.isTrusted(workspaceRoot)) err(t("cli.plugin.untrusted"));
      return 0;
    } catch (error) {
      err(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  if (parsed.subcommand === "list") {
    out(pluginListCmd(workspaceRoot));
    return 0;
  }

  if (parsed.subcommand === "sync") {
    const { text, failed } = pluginSyncCmd(workspaceRoot, parsed.overwrite, err);
    out(text);
    return failed ? 1 : 0;
  }

  if (parsed.subcommand === "update") {
    const name = parsed.args[0];
    if (name === undefined) {
      err("Usage: agency plugin update <name>");
      return 1;
    }
    try {
      out(pluginUpdateCmd(name, workspaceRoot, err));
      return 0;
    } catch (error) {
      err(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  if (parsed.subcommand === "remove") {
    const name = parsed.args[0];
    if (name === undefined) {
      err("Usage: agency plugin remove <name>");
      return 1;
    }
    try {
      const msg = pluginRemoveCmd(name, workspaceRoot);
      out(msg);
      return 0;
    } catch (error) {
      err(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  throw subcommandError("plugin", parsed.subcommand);
}

async function dispatch(
  parsed: ParsedArgv,
  deps: EntrypointDeps,
  out: LineSink,
  err: LineSink,
): Promise<number> {
  if (parsed.help) {
    out(HELP);
    return 0;
  }
  if (parsed.version) {
    out(VERSION);
    return 0;
  }

  if (parsed.print !== undefined) {
    if (parsed.command !== undefined) throw new Error(t("cli.error.print_with_command"));
    if (parsed.print !== "-") return runPrintMode(parsed, parsed.print, deps, out, err);
    // `-p -`: a long prompt does not fit the command-line length limit, and a pipe needs no quoting.
    const prompt = (await (deps.stdin ?? (() => Bun.stdin.text()))()).trim();
    if (prompt.length === 0) throw new Error(t("cli.error.empty_stdin_prompt"));
    return runPrintMode(parsed, prompt, deps, out, err);
  }
  if (parsed.continueLast || parsed.session !== undefined) {
    throw new Error(t("cli.error.continue_requires_print"));
  }

  switch (parsed.command) {
    case undefined: {
      // Bare `agency`: health summary, exit 0.
      const env = envOf(deps);
      const config = loadConfig({ globalDir: deps.configDir, env });
      const ref = parseModelRef(config.model ?? "");
      const modelStr = ref ? `${ref.provider}/${ref.model}` : t("cli.error.no_model");
      const providerCount = Object.keys(config.provider).length;
      const keychain = deps.keychain ?? (await createKeychain(process.platform, join(dataDir(env), "keys")));
      const connectedCount = (await providerConnections(config, env, keychain)).filter(
        (row) => row.connected,
      ).length;
      const store = new SessionStore(
        deps.sessionsDir ?? storagePaths(workspaceRootOf(parsed, deps), env).sessionsDir,
      );
      const sessionCount = store.list().length;
      out(t("cli.health.title", { version: VERSION }));
      out(t("cli.health.model", { model: modelStr }));
      out(t("cli.health.providers", { connected: String(connectedCount), total: String(providerCount) }));
      out(t("cli.health.sessions", { count: String(sessionCount) }));
      out(t("cli.health.hint"));
      return 0;
    }
    case "where":
      return whereCmd(parsed, deps, out);
    case "usage": {
      const by = parsed.usageBy ?? "day";
      const report = usageReport(envOf(deps), by, parsed.since);
      out(parsed.format === "json" ? JSON.stringify(report, null, 2) : usageCommand(report, by));
      return 0;
    }
    case "storage":
      if (parsed.subcommand === "--help" || parsed.subcommand === "-h") {
        out(`Usage: agency storage [subcommand]

Subcommands:
  (none)               Report storage sizes by category
  prune                Clear the cache; with --max-age-days or --max-total-mb, prune old sessions

Options:
  --max-age-days <days>    With prune: delete sessions older than this
  --max-total-mb <mb>      With prune: delete oldest sessions until under this size`);
        return 0;
      }
      return storageCmd(parsed, deps, out);
    case "session":
      return sessionCmd(parsed, deps, out, err);
    case "auth":
      if (parsed.subcommand === "--help" || parsed.subcommand === "-h") {
        out(`Usage: agency auth <subcommand> [args]

Subcommands:
  login <provider>     Store an API key for a provider in the OS keychain
  login chatgpt        Continue with ChatGPT: use the models of your ChatGPT plan
  list                 Show which providers have a resolvable key
  logout <provider>    Remove the key or sign-in of a provider`);
        return 0;
      }
      return authCmd(parsed, deps, out, err);
    case "daemon":
      if (parsed.subcommand === "status" || parsed.subcommand === undefined) {
        return daemonStatusCmd(parsed, deps, out, err);
      }
      if (parsed.subcommand === "cancel") return daemonCancelCmd(parsed, deps, out);
      if (parsed.subcommand === "--help" || parsed.subcommand === "-h") {
        out(`Usage: agency daemon <subcommand>

Subcommands:
  status               Show daemon status for this workspace, with the turns that run
  cancel <turn>        Stop a turn that runs`);
        return 0;
      }
      throw subcommandError("daemon", parsed.subcommand);
    case "update": {
      const { runUpdate } = await import("./update.ts");
      const msg = await runUpdate({ currentVersion: VERSION, rollback: parsed.rollback });
      out(msg);
      return 0;
    }
    case "serve": {
      const { runServe } = await import("./serve.ts");
      const { defaultInstanceDir } = await import("./headless.ts");
      const workspaceRoot = workspaceRootOf(parsed, deps);
      const instanceDir = deps.instanceDir ?? defaultInstanceDir(envOf(deps));
      const { join } = await import("node:path");
      const { workspaceId } = await import("@agency/core");
      const instanceFile = join(instanceDir, `${workspaceId(workspaceRoot)}.json`);
      await runServe({ workspaceRoot, instanceFile });
      return 0;
    }
    case "trust": {
      const root = workspaceRootOf(parsed, deps);
      const { createFileTrustStore } = await import("@agency/guard");
      createFileTrustStore(join(dataDir(envOf(deps)), "trust.json")).trust(root);
      out(t("cli.trust.accepted", { path: root }));
      return 0;
    }
    case "onboard": {
      const result = await runOnboarding({
        workspaceRoot: workspaceRootOf(parsed, deps),
        prompter: createTerminalOnboardingPrompter(),
        out,
      });
      return result.completed ? 0 : 1;
    }
    case "debug": {
      const { path } = debugCommand({ workspaceRoot: workspaceRootOf(parsed, deps), version: VERSION });
      out(t("debug.written", { path }));
      return 0;
    }
    case "plugin":
      return pluginCmd(parsed, deps, out, err);
    case "mcp":
      if (parsed.subcommand === "serve") return mcpServeCmd(parsed, deps, out, err);
      return mcpCmd({
        action: parsed.subcommand,
        name: parsed.args[0],
        rest: parsed.args.slice(1),
        serverEnv: parsed.serverEnv,
        headers: parsed.headers,
        transport: parsed.transport,
        scope: parsed.scope,
        overwrite: parsed.overwrite,
        json: parsed.format === "json",
        workspaceRoot: workspaceRootOf(parsed, deps),
        ...(deps.configDir ? { configDir: deps.configDir } : {}),
        env: envOf(deps),
        ...(deps.keychain ? { keychain: deps.keychain } : {}),
        ...(deps.openUrl ? { openUrl: deps.openUrl } : {}),
        out,
        err,
      });
    case "workflow":
      return workflowCmd(parsed, deps, out, err);
    case "review":
      return reviewCmd(parsed, deps, out, err);
    default:
      throw new Error(t("cli.error.unknown_command", { command: String(parsed.command) }));
  }
}

export async function runEntrypoint(
  argv: string[] = process.argv.slice(2),
  deps: EntrypointDeps = {},
): Promise<number> {
  const out = deps.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = deps.err ?? ((line: string) => process.stderr.write(`${line}\n`));
  try {
    return await dispatch(parseArgv(argv), deps, out, err);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    err(message);
    // A script that parses stdout gets the failure there too, in the `error` shape of a turn result.
    const format = argv.flatMap((arg, i) =>
      arg === "--format" || arg === "--output-format"
        ? [argv[i + 1]]
        : /^--(output-)?format=/.test(arg)
          ? [arg.slice(arg.indexOf("=") + 1)]
          : [],
    );
    const stream = format.includes("stream-json") || argv.includes("--json");
    if (stream || format.includes("json")) {
      const code = (error as { code?: unknown } | null)?.code;
      const failure = {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: message,
        error: { code: typeof code === "string" ? code : "internal", message },
      };
      out(stream ? JSON.stringify(failure) : JSON.stringify(failure, null, 2));
    }
    return 1;
  }
}

/** Real CLI process only: tests call runEntrypoint and must reach neither the network nor the user's cache. */
async function noteAvailableUpdate(argv: string[]): Promise<void> {
  if (
    process.env.AGENCY_NO_UPDATE_CHECK ||
    argv.some((arg) => ["--help", "-h", "--version", "-v"].includes(arg))
  ) {
    return;
  }
  const { checkStale } = await import("./update.ts");
  const latest = checkStale(VERSION, join(cacheDir(), "update-check.json"));
  // stderr: a notice on stdout would corrupt `--format json` output.
  if (latest)
    process.stderr.write(`Update available: ${VERSION} -> ${latest} (run agency update)
`);
}

if (import.meta.main) {
  if (process.argv[2] === DAEMON_COMMAND) {
    await (await import("./daemon-entry.ts")).runDaemonEntry(process.argv.slice(3));
  }
  if (process.argv[2] === CODE_COMMAND) await runCodeChild();
  if (process.argv[2] === SANDBOX_COMMAND) runSandboxChild();
  ownerOnlyDirs();
  await noteAvailableUpdate(process.argv.slice(2));
  // Awaited: a bare promise does not hold the process open, and an empty stdin read then exits 0 with no output.
  process.exit(await runEntrypoint());
}

/**
 * The single source of user-facing English strings. No package outside @agency/i18n
 * writes a string literal a user will see: everything routes through a key here.
 * `{placeholder}` tokens are filled by `t()`.
 */
export const en = {
  "error.auth": "Authentication failed for {source}. Run `agency auth login` to reconnect.",
  "error.rate_limit": "{source} is rate-limiting requests. Retrying automatically.",
  "error.overload": "{source} is temporarily overloaded. Retrying automatically.",
  "error.context_overflow": "This conversation is too long for the current model. Compacting and retrying.",
  "error.network": "Couldn't reach {source}. Check your connection and try again.",
  "error.proxy": "Couldn't reach {source} through the configured proxy. Check your proxy settings.",
  "error.transient": "{source} had a temporary problem. Retrying automatically.",
  "error.refusal": "{source} declined to complete this request.",
  "error.tool_error": "The {source} tool failed: {detail}",
  "error.permission_denied": "{source} isn't allowed to do that: {detail}",
  "error.internal": "Something went wrong inside Agency. Run `agency debug` to file a report.",

  "config.invalid": "Config at {path} is invalid: {detail}",
  "config.unknown_provider": 'Provider "{name}" is not configured. Run `agency auth login`.',

  "trust.prompt": "Agency hasn't run in {path} before. Trust this directory and load its instructions?",
  "trust.denied": "This directory isn't trusted, so its AGENTS.md and config were not loaded.",

  "tui.thinking.label": "Thinking",
  "tui.thinking.collapsed": "Thinking ({chars} chars, collapsed)",
  "tui.tool.call": "Tool: {name}",
  "tui.tool.result": "Tool {name} finished",
  "tui.tool.error": "Tool {name} failed",
  "tui.turn.complete": "Turn complete ({reason}, {tokens} tokens)",
  "tui.budget.exceeded": "Budget exceeded: {tokens} tokens, {cost} USD spent",
  "tui.error.message": "[{code}] {message}",
  "tui.retry.message": "retry {attempt}: {message}",
  "tui.retry.next": " — retrying at {next}",
  "tui.cue.accent": "note",
  "tui.cue.dim": "detail",
  "tui.cue.error": "error",
  "tui.cue.success": "ok",
  "tui.cue.warning": "warn",

  "tui.picker.results": "Results",
  "tui.picker.favorites": "Favorites",
  "tui.picker.recent": "Recent",
  "tui.picker.free": "Free",
  "tui.picker.empty": 'No models match "{query}"',
  "tui.picker.gated_hidden": "{count} experimental or deprecated models hidden",
  "tui.picker.connect_hint": "Press {key} to connect a provider",

  "tui.connect.provider_prompt": "Provider to connect{suggestions}:",
  "tui.connect.key_prompt": "API key for {provider}:",
  "tui.connect.invalid_id":
    '"{id}" isn\'t a valid provider id (lowercase letters, digits, dash, underscore).',
  "tui.connect.no_key": "No key entered; nothing was stored.",
  "tui.connect.rejected": "{provider} rejected that key.",
  "tui.connect.aborted": "Connect cancelled; nothing was stored.",
  "tui.connect.stored": "Key for {provider} stored in the {backend}.",
  "tui.connect.unverified": "Couldn't reach {provider} to verify the key; stored it anyway.",

  "tui.catalog.refreshed": "Model catalog refreshed: {count} models from {source}.",

  "tui.diff.summary": "+{added} -{removed} {path}",
  "tui.browser.empty": "(no sessions)",
  "tui.palette.empty": "(no commands)",
  "tui.help.empty": "(no help)",
  "tui.status.model": "Model: {model}",
  "tui.status.thinking": "Thinking: {level}",
  "tui.status.context": "Context: {used}/{total}",
  "tui.status.cost": "Cost: {cost}",
  "tui.empty.first_run": "Welcome to Agency. Run /connect to add a provider.",
  "tui.empty.no_credentials": "No credentials found. Press Ctrl+L to connect.",
  "tui.error.offline": "Offline. Check your connection.",
  "tui.error.rate_limited": "Rate limited. Retrying automatically.",
  "tui.error.cancelled": "Cancelled.",

  "lsp.server.start_failed": "Language server for {language} failed to start: {detail}",
  "lsp.diagnostics.warning": "Language server reports {count} error(s) in {path}: {summary}",
  "lsp.request.timeout": "Language server request {method} timed out after {ms}ms.",

  "image.read.attached": "Attached image {path} ({mime}, {bytes} bytes).",
  "image.unsupported": "{path} is not a readable image (supported: {formats}).",

  "onboarding.no_credentials": "No provider credentials found. Let's connect one.",
  "onboarding.connect_done": "Connected {provider}.",
  "onboarding.already_connected": "Already connected to {provider}.",
  "onboarding.model_prompt": "Default model as provider/model [{suggested}]:",
  "onboarding.model_stored": "Default model set to {model}.",
  "onboarding.trust_prompt": "Trust {path} and load its instructions?",
  "onboarding.trust_denied": "Not trusted: AGENTS.md and project config won't load here.",
  "onboarding.ready": "Ready. Run `agency` to start a session.",
  "onboarding.aborted": "Onboarding cancelled; nothing was stored.",

  "telemetry.consent.prompt":
    "Enable anonymous usage metrics and crash reports? Counts and error codes only — no prompt or code content, secrets redacted, off by default.",
  "telemetry.consent.enabled": "Telemetry enabled. Thank you.",
  "telemetry.consent.disabled": "Telemetry stays off.",

  "cli.tui.hint": "Agency TUI: run in a terminal with a TTY. Use --help for commands.",
  "cli.error.unknown_command": 'Unknown command "{command}". Run `agency --help`.',
  "cli.error.unknown_option": 'Unknown option "{flag}". Run `agency --help`.',
  "cli.error.missing_value": "Option {flag} needs a value.",
  "cli.error.invalid_format": '--format must be "text" or "json".',
  "cli.error.invalid_number": "{flag} must be a non-negative number.",
  "cli.error.print_with_command": "Choose either a command or -p/--print, not both.",
  "cli.error.continue_requires_print": "--continue and --session need -p/--print to run a turn.",
  "cli.error.session_conflict": "Use either --continue or --session, not both.",
  "cli.error.no_model": "No model configured. Run `agency onboard` or pass --model provider/model.",
  "cli.error.provider_without_model":
    "No default model id to pair with {provider}. Pass --model provider/model.",
  "cli.error.no_key": "No API key for {provider}. Run `agency auth login {provider}`.",
  "cli.error.no_sessions": "No sessions to continue.",
  "cli.error.unknown_session": 'Unknown session "{id}".',
  "cli.error.session_delete_usage": "usage: agency session delete <id>",
  "cli.error.auth_login_usage": "usage: agency auth login <provider>",
  "cli.auth.key_prompt": "API key for {provider}:",
  "cli.auth.connected": "{provider}: connected",
  "cli.auth.disconnected": "{provider}: not connected",
  "cli.session.deleted": "Deleted session {id}.",

  "debug.written": "Debug bundle written to {path}. It contains no secrets; review before attaching.",
} as const;

export type MessageKey = keyof typeof en;

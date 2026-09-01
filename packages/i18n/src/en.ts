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
} as const;

export type MessageKey = keyof typeof en;

import { type CommandTemplate, expandCommand, parseSlashInput } from "@agency/core";
import type { MethodHandler } from "@agency/rpc";
import type { Message } from "@agency/schema";
import { AgencyError, ErrorCode } from "@agency/schema";
import type { McpManager, ShellConfig } from "@agency/tools";
import { listProviders } from "../../providers-list.ts";
import type { DaemonContext } from "../types.ts";

/** `shell` runs the `!` blocks of the command, as Claude Code does for a command that the user types. */
export function applySlashCommand(
  commands: CommandTemplate[],
  workspaceRoot: string,
  session: Message[],
  shell?: { command: ShellConfig; env: Record<string, string> },
): void {
  if (session.length > 0) {
    const lastMsg = session[session.length - 1];
    const lastText = lastMsg?.content?.find((b: { type: string }) => b.type === "text") as
      | { text?: string }
      | undefined;
    const text = typeof lastText?.text === "string" ? lastText.text.trim() : "";
    const parsed = parseSlashInput(text);
    if (parsed) {
      const tmpl = commands.find((c) => c.name === parsed.name);
      if (tmpl) {
        const expanded = expandCommand(
          tmpl.content,
          parsed.args,
          workspaceRoot,
          shell === undefined ? undefined : { shell: true, shellCommand: shell.command, env: shell.env },
        );
        const userMsg = session[session.length - 1] as unknown as {
          role: string;
          content: { text: string }[];
        };
        if (userMsg.content[0]) userMsg.content[0].text = expanded;
        session[session.length - 1] = {
          ...userMsg,
        } as unknown as (typeof session)[number];
      }
    }
  }
}

/** `/mcp__<server>__<prompt> words` in the last user message becomes the text of that prompt of an MCP server. */
export async function applyMcpPrompt(mcp: McpManager | undefined, session: Message[]): Promise<void> {
  const last = session[session.length - 1];
  const block = last?.role === "user" ? last.content.find((b) => b.type === "text") : undefined;
  if (!mcp || block?.type !== "text") return;
  const parsed = parseSlashInput(block.text);
  const text = parsed ? await mcp.promptText(parsed.name, parsed.args) : undefined;
  if (text !== undefined) block.text = text;
}

export function registerCommandHandlers(handlers: Record<string, MethodHandler>, ctx: DaemonContext): void {
  const { builtinsMode, commands, config, getKeychain, http, options, sessionScopes } = ctx;
  handlers.providers_list = async (rawParams) => {
    const { models } = (rawParams ?? {}) as { models?: unknown };
    if (models !== undefined && models !== "all" && models !== "connected") {
      throw new AgencyError(ErrorCode.INVALID_REQUEST, 'models must be "all" or "connected"', {
        source: "providers_list",
      });
    }
    const keychain = await getKeychain().catch(() => undefined);
    const base = await listProviders({
      config,
      http,
      catalog: options.catalog,
      ...(keychain === undefined ? {} : { keychain }),
      ...(models === undefined ? {} : { models }),
    });
    let mcpFailures: Record<string, string> = {};
    let lspStatuses: Record<string, string> = {};
    if (builtinsMode) {
      const first = sessionScopes.get("default") ?? [...sessionScopes.values()][0];
      if (first?.mcpFailures) mcpFailures = Object.fromEntries(first.mcpFailures);
      if (first?.lspRegistry) lspStatuses = first.lspRegistry.statuses();
    }
    return { ...base, mcpFailures, lspStatuses };
  };
  handlers.mcp_status = async (rawParams?: unknown) => {
    const p = rawParams as { sessionId?: string } | undefined;
    if (builtinsMode && p?.sessionId) {
      const s = sessionScopes.get(p.sessionId);
      return {
        failures: s ? Object.fromEntries(s.mcpFailures) : {},
        prompts: (s?.mcp?.prompts ?? []).map((prompt) => ({
          command: `/mcp__${prompt.server}__${prompt.name}`,
          description: prompt.description,
          arguments: (prompt.arguments ?? []).map((a) => a.name),
        })),
      };
    }
    return { failures: {} as Record<string, string>, prompts: [] };
  };
  handlers.lsp_status = async (rawParams?: unknown) => {
    const p = rawParams as { sessionId?: string } | undefined;
    if (builtinsMode && p?.sessionId) {
      const s = sessionScopes.get(p.sessionId);
      return { statuses: s?.lspRegistry?.statuses() ?? {} };
    }
    return { statuses: {} as Record<string, string> };
  };
  handlers.commands_list = async () => {
    return {
      commands: commands.map((c) => ({
        name: c.name,
        description: c.description,
        source: c.source,
        path: c.path,
      })),
    };
  };
  handlers.commands_expand = async (rawParams) => {
    const { name, args } = rawParams as { name: string; args?: string };
    const tmpl = commands.find((c) => c.name === name);
    if (!tmpl)
      throw new AgencyError(ErrorCode.INVALID_REQUEST, `unknown command: ${name}`, { source: "commands" });
    const expanded = expandCommand(tmpl.content, args ?? "", options.workspaceRoot);
    return { expanded, name };
  };
}

import { type CommandTemplate, expandCommand, parseSlashInput } from "@agency/core";
import type { MethodHandler } from "@agency/rpc";
import type { Message } from "@agency/schema";
import { AgencyError, ErrorCode } from "@agency/schema";
import { listProviders } from "../../providers-list.ts";
import type { DaemonContext } from "../types.ts";

export function applySlashCommand(
  commands: CommandTemplate[],
  workspaceRoot: string,
  session: Message[],
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
        const expanded = expandCommand(tmpl.content, parsed.args, workspaceRoot);
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

export function registerCommandHandlers(handlers: Record<string, MethodHandler>, ctx: DaemonContext): void {
  const { builtinsMode, commands, config, http, options, sessionScopes } = ctx;
  handlers.providers_list = async () => {
    const base = await listProviders({ config, http, catalog: options.catalog });
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
      return { failures: s ? Object.fromEntries(s.mcpFailures) : {} };
    }
    return { failures: {} as Record<string, string> };
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
    if (!tmpl) throw new AgencyError(ErrorCode.INTERNAL, `unknown command: ${name}`, { source: "commands" });
    const expanded = expandCommand(tmpl.content, args ?? "", options.workspaceRoot);
    return { expanded, name };
  };
}

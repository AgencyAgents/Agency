import { readFileSync } from "node:fs";
import { requirePathScope } from "@agency/guard";
import { t } from "@agency/i18n";
import type { ToolContext, ToolDeps, ToolSpec } from "../contract.ts";
import { lineCount, str, summarize } from "../render.ts";
import type { LspClient } from "./client.ts";
import type { LspRegistry } from "./registry.ts";

export interface LspToolsOptions {
  deps: ToolDeps;
  registry: LspRegistry;
}

interface RoutedClient {
  resolved: string;
  client: LspClient;
}

function positiveIntOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : fallback;
}

async function routeForPath(
  options: LspToolsOptions,
  rawPath: unknown,
  ctx: ToolContext,
  tool: string,
): Promise<RoutedClient | { error: string }> {
  const resolved = await options.deps.sandbox.resolvePathGated(str(rawPath), {
    tool,
    ask: ctx.requestApproval,
  });
  requirePathScope(options.deps.identity, options.deps.capabilities, resolved);
  const client = options.registry.clientFor(resolved);
  if (!client) return { error: t("tool.lsp.no_server", { path: str(rawPath) }) };
  return { resolved, client };
}

async function ensureOpen(
  registry: LspRegistry,
  client: LspClient,
  resolved: string,
): Promise<{ started: boolean; detail?: string }> {
  let text: string;
  try {
    text = readFileSync(resolved, "utf8");
  } catch {
    return { started: false };
  }
  try {
    await client.ready;
  } catch (error) {
    return { started: false, detail: error instanceof Error ? error.message : String(error) };
  }
  try {
    client.open(resolved, text, registry.languageIdFor(resolved) ?? "plaintext");
  } catch {
    // didOpen is a notification; a throw here must never fail the query.
  }
  return { started: true };
}

function formatLocation(path: string, line: number, character: number, extra?: string): string {
  const position = `${path}:${line + 1}:${character + 1}`;
  return extra ? `${position} ${extra}` : position;
}

function renderSingle(label: string, inputPath: unknown) {
  return {
    renderCall: (input: Record<string, unknown>) => `${label} ${str(input.path ?? inputPath)}`,
    renderResult: (result: { content: string; isError?: boolean; input?: Record<string, unknown> }) => {
      const at = result.input?.path !== undefined ? ` ${str(result.input.path)}` : "";
      if (result.isError) return `${label}${at} failed: ${summarize(result.content)}`;
      return `${label}${at}: ${summarize(result.content)}`;
    },
  };
}

export function createLspGotoDefinitionTool(options: LspToolsOptions): ToolSpec {
  const rendering = renderSingle("goto_definition", "");
  const spec: ToolSpec<{ path: string; line?: number; character?: number }> = {
    name: "lsp_goto_definition",
    description:
      "Jumps to the definition of the symbol at the given 1-based line/character. " +
      "Routes to the session's language server for the file type.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File containing the symbol reference." },
        line: { type: "integer", description: "1-based line of the symbol. Default 1." },
        character: { type: "integer", description: "1-based character of the symbol. Default 1." },
      },
      required: ["path"],
    },
    riskTier: "safe",
    renderCall: rendering.renderCall,
    renderResult: rendering.renderResult,
    async handler(input, ctx) {
      const routed = await routeForPath(options, input.path, ctx, "lsp_goto_definition");
      if ("error" in routed) return { content: routed.error, isError: true };
      const line = positiveIntOr(input.line, 1) - 1;
      const character = positiveIntOr(input.character, 1) - 1;
      const opened = await ensureOpen(options.registry, routed.client, routed.resolved);
      if (opened.detail) {
        return {
          content: t("lsp.server.start_failed", { language: input.path, detail: opened.detail }),
          isError: true,
        };
      }
      const locations = await routed.client.definition(routed.resolved, line, character);
      if (locations.length === 0) {
        return {
          content: t("tool.lsp.no_definition", {
            path: input.path,
            line: line + 1,
            character: character + 1,
          }),
        };
      }
      return { content: locations.map((l) => formatLocation(l.path, l.line, l.character)).join("\n") };
    },
  };
  return spec;
}

export function createLspFindReferencesTool(options: LspToolsOptions): ToolSpec {
  const rendering = renderSingle("find_references", "");
  const spec: ToolSpec<{ path: string; line?: number; character?: number }> = {
    name: "lsp_find_references",
    description:
      "Lists all references to the symbol at the given 1-based line/character, " +
      "including the declaration. Routes to the session's language server for the file type.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File containing the symbol." },
        line: { type: "integer", description: "1-based line of the symbol. Default 1." },
        character: { type: "integer", description: "1-based character of the symbol. Default 1." },
      },
      required: ["path"],
    },
    riskTier: "safe",
    renderCall: rendering.renderCall,
    renderResult: rendering.renderResult,
    async handler(input, ctx) {
      const routed = await routeForPath(options, input.path, ctx, "lsp_find_references");
      if ("error" in routed) return { content: routed.error, isError: true };
      const line = positiveIntOr(input.line, 1) - 1;
      const character = positiveIntOr(input.character, 1) - 1;
      const opened = await ensureOpen(options.registry, routed.client, routed.resolved);
      if (opened.detail) {
        return {
          content: t("lsp.server.start_failed", { language: input.path, detail: opened.detail }),
          isError: true,
        };
      }
      const locations = await routed.client.references(routed.resolved, line, character);
      if (locations.length === 0) {
        return {
          content: t("tool.lsp.no_references", {
            path: input.path,
            line: line + 1,
            character: character + 1,
          }),
        };
      }
      return { content: locations.map((l) => formatLocation(l.path, l.line, l.character)).join("\n") };
    },
  };
  return spec;
}

export function createLspSymbolsTool(options: LspToolsOptions): ToolSpec {
  const spec: ToolSpec<{ path?: string; query?: string }> = {
    name: "lsp_symbols",
    description:
      "Lists symbols: pass path for the document symbols of one file, or query " +
      "for a workspace-wide symbol search. Routes to the session's language servers.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File whose document symbols to list." },
        query: { type: "string", description: "Workspace symbol search string." },
      },
    },
    riskTier: "safe",
    renderCall: (input) => `symbols ${str(input.path ?? input.query)}`,
    renderResult: (result) => {
      if (result.isError) return `symbols failed: ${summarize(result.content)}`;
      return `symbols: ${lineCount(result.content)} found`;
    },
    async handler(input, ctx) {
      if (typeof input.path === "string" && input.path.length > 0) {
        const routed = await routeForPath(options, input.path, ctx, "lsp_symbols");
        if ("error" in routed) return { content: routed.error, isError: true };
        const opened = await ensureOpen(options.registry, routed.client, routed.resolved);
        if (opened.detail) {
          return {
            content: t("lsp.server.start_failed", { language: input.path, detail: opened.detail }),
            isError: true,
          };
        }
        const symbols = await routed.client.documentSymbols(routed.resolved);
        if (symbols.length === 0) return { content: t("tool.lsp.no_symbols") };
        return {
          content: symbols
            .map((s) =>
              formatLocation(
                s.path,
                s.line,
                s.character,
                s.containerName ? `${s.name} (${s.containerName})` : s.name,
              ),
            )
            .join("\n"),
        };
      }
      if (typeof input.query === "string" && input.query.length > 0) {
        const clients = options.registry.all();
        if (clients.length === 0) return { content: t("tool.lsp.no_symbols") };
        const seen = new Set<string>();
        const lines: string[] = [];
        for (const client of clients) {
          try {
            await client.ready;
          } catch {
            continue;
          }
          const symbols = await client.workspaceSymbols(input.query);
          for (const s of symbols) {
            const key = `${s.path}:${s.line}:${s.character}:${s.name}`;
            if (seen.has(key)) continue;
            seen.add(key);
            lines.push(formatLocation(s.path || "?", s.line, s.character, s.name));
          }
        }
        if (lines.length === 0) return { content: t("tool.lsp.no_symbols") };
        return { content: lines.join("\n") };
      }
      return { content: t("tool.lsp.no_symbols"), isError: true };
    },
  };
  return spec;
}

export function createLspPrepareRenameTool(options: LspToolsOptions): ToolSpec {
  const rendering = renderSingle("prepare_rename", "");
  const spec: ToolSpec<{ path: string; line?: number; character?: number }> = {
    name: "lsp_prepare_rename",
    description:
      "Checks whether the symbol at the given 1-based line/character can be renamed " +
      "and reports the placeholder range. Routes to the session's language server.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File containing the symbol." },
        line: { type: "integer", description: "1-based line of the symbol. Default 1." },
        character: { type: "integer", description: "1-based character of the symbol. Default 1." },
      },
      required: ["path"],
    },
    riskTier: "safe",
    renderCall: rendering.renderCall,
    renderResult: rendering.renderResult,
    async handler(input, ctx) {
      const routed = await routeForPath(options, input.path, ctx, "lsp_prepare_rename");
      if ("error" in routed) return { content: routed.error, isError: true };
      const line = positiveIntOr(input.line, 1) - 1;
      const character = positiveIntOr(input.character, 1) - 1;
      const opened = await ensureOpen(options.registry, routed.client, routed.resolved);
      if (opened.detail) {
        return {
          content: t("lsp.server.start_failed", { language: input.path, detail: opened.detail }),
          isError: true,
        };
      }
      const prepared = await routed.client.prepareRename(routed.resolved, line, character);
      if (!prepared) {
        return {
          content: t("tool.lsp.rename_refused", {
            path: input.path,
            line: line + 1,
            character: character + 1,
          }),
          isError: true,
        };
      }
      const range = `${routed.resolved}:${prepared.line + 1}:${prepared.character + 1}-${prepared.endLine + 1}:${prepared.endCharacter + 1}`;
      return { content: prepared.placeholder !== undefined ? `${range} ${prepared.placeholder}` : range };
    },
  };
  return spec;
}

export function createLspRenameTool(options: LspToolsOptions): ToolSpec {
  const rendering = renderSingle("rename", "");
  const spec: ToolSpec<{ path: string; line?: number; character?: number; newName: string }> = {
    name: "lsp_rename",
    description:
      "Computes the workspace edits for renaming the symbol at the given 1-based " +
      "line/character to newName. Returns the edit list as a preview — the agent " +
      "applies it with the edit tool, which owns snapshots, approval, and diagnostics.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File containing the symbol." },
        line: { type: "integer", description: "1-based line of the symbol. Default 1." },
        character: { type: "integer", description: "1-based character of the symbol. Default 1." },
        newName: { type: "string", description: "The new name for the symbol." },
      },
      required: ["path", "newName"],
    },
    riskTier: "safe",
    renderCall: (input) => `rename ${str(input.path)} to ${str(input.newName)}`,
    renderResult: rendering.renderResult,
    async handler(input, ctx) {
      if (typeof input.newName !== "string" || input.newName.length === 0) {
        return { content: t("tool.lsp.no_edits"), isError: true };
      }
      const routed = await routeForPath(options, input.path, ctx, "lsp_rename");
      if ("error" in routed) return { content: routed.error, isError: true };
      const line = positiveIntOr(input.line, 1) - 1;
      const character = positiveIntOr(input.character, 1) - 1;
      const opened = await ensureOpen(options.registry, routed.client, routed.resolved);
      if (opened.detail) {
        return {
          content: t("lsp.server.start_failed", { language: input.path, detail: opened.detail }),
          isError: true,
        };
      }
      const edits = await routed.client.rename(routed.resolved, line, character, input.newName);
      if (edits.length === 0) return { content: t("tool.lsp.no_edits") };
      return {
        content: edits
          .map(
            (e) =>
              `${e.path}:${e.line + 1}:${e.character + 1}-${e.endLine + 1}:${e.endCharacter + 1} -> ${e.newText}`,
          )
          .join("\n"),
      };
    },
  };
  return spec;
}

export function createLspInstallDecisionTool(options: LspToolsOptions): ToolSpec {
  const spec: ToolSpec<{ server: string; decision: string }> = {
    name: "lsp_install_decision",
    description:
      "Records whether the user allowed or declined installing a missing language server. " +
      "Declined servers stay idle instead of retrying; the decision is session-scoped.",
    inputSchema: {
      type: "object",
      properties: {
        server: { type: "string", description: "Server command the decision applies to." },
        decision: {
          type: "string",
          description: "One of: allowed, declined (allow/deny accepted as aliases).",
        },
      },
      required: ["server", "decision"],
    },
    riskTier: "safe",
    renderCall: (input) => `lsp_install_decision ${str(input.server)} ${str(input.decision)}`,
    renderResult: (result) => {
      if (result.isError) return `lsp_install_decision failed: ${summarize(result.content)}`;
      return summarize(result.content);
    },
    async handler(input) {
      const server = str(input.server);
      const raw = str(input.decision).toLowerCase();
      const decision =
        raw === "allowed" || raw === "allow"
          ? "allowed"
          : raw === "declined" || raw === "decline" || raw === "deny"
            ? "declined"
            : undefined;
      if (server.length === 0 || decision === undefined) {
        return { content: t("tool.lsp.no_symbols"), isError: true };
      }
      options.registry.recordInstallDecision(server, decision);
      return { content: t("tool.lsp.install_recorded", { server, decision }) };
    },
  };
  return spec;
}

/**
 * All six LSP tools bound to one session's registry. The registry is captured
 * per scope, so concurrent sessions never share clients: clientFor routes by
 * file extension to the owning server, spawned lazily on first use.
 */
export function createLspTools(options: LspToolsOptions): ToolSpec[] {
  return [
    createLspGotoDefinitionTool(options),
    createLspFindReferencesTool(options),
    createLspSymbolsTool(options),
    createLspPrepareRenameTool(options),
    createLspRenameTool(options),
    createLspInstallDecisionTool(options),
  ];
}

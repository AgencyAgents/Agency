import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const LspServerConfigSchema = z.object({
  command: z.union([z.string(), z.array(z.string())]),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  extensions: z.array(z.string()),
  languageId: z.string().optional(),
});

export type LspServerConfigRaw = z.infer<typeof LspServerConfigSchema>;

export const LspServersConfigSchema = z.record(z.string(), LspServerConfigSchema);

export type LspServersConfig = z.infer<typeof LspServersConfigSchema>;

export function parseLspServers(raw: unknown): LspServersConfig {
  return LspServersConfigSchema.parse(raw);
}

export interface NormalizedLspServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  extensions: string[];
  languageId: string;
}

function inferLanguageId(extensions: string[]): string {
  const first = extensions[0] ?? "";
  return first.replace(/^\./, "") || "plaintext";
}

function normalizeExtension(ext: string): string {
  const lower = ext.toLowerCase();
  return lower.startsWith(".") ? lower : `.${lower}`;
}

export function normalizeLspServers(raw: LspServersConfig): NormalizedLspServerConfig[] {
  const out: NormalizedLspServerConfig[] = [];
  for (const [name, cfg] of Object.entries(raw)) {
    let command: string;
    let prefixArgs: string[] = [];
    if (Array.isArray(cfg.command)) {
      if (cfg.command.length === 0) throw new Error(`lspServers.${name}.command must not be empty`);
      const head = cfg.command.at(0);
      if (!head) throw new Error(`lspServers.${name}.command must not be empty`);
      command = head;
      prefixArgs = cfg.command.slice(1);
    } else {
      command = cfg.command;
    }
    const args = [...prefixArgs, ...(cfg.args ?? [])];
    const extensions = cfg.extensions.map(normalizeExtension);
    out.push({
      name,
      command,
      args: args.length > 0 ? args : undefined,
      env: cfg.env,
      extensions,
      languageId: cfg.languageId ?? inferLanguageId(extensions),
    });
  }
  return out;
}

/** The LSP servers of `.agency/lsp/*.json`, which `plugin install` writes for a plugin. A file that is not valid is skipped. */
export function loadProjectLspServers(
  workspaceRoot: string,
  warn: (message: string) => void = () => {},
): LspServersConfig {
  const dir = join(workspaceRoot, ".agency", "lsp");
  const servers: LspServersConfig = {};
  if (!existsSync(dir)) return servers;
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith(".json")) continue;
    const file = join(dir, entry);
    try {
      Object.assign(
        servers,
        parseLspServers((JSON.parse(readFileSync(file, "utf8")) as { lspServers?: unknown }).lspServers),
      );
    } catch (error) {
      warn(`LSP file ${file} is not valid: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return servers;
}

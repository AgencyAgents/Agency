import { z } from "zod";

export const McpServerConfigSchema = z.object({
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().url().optional(),
  riskTier: z.enum(["safe", "moderate", "dangerous"]).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  requestTimeoutMs: z.number().int().positive().optional(),
  toolCallTimeoutMs: z.number().int().positive().optional(),
  /** Read-only servers are safe to share across a team. */
  readOnly: z.boolean().optional(),
  /** Stateless servers hold no session state, so sharing never leaks. */
  stateless: z.boolean().optional(),
});

export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

export const McpServersConfigSchema = z.record(z.string(), McpServerConfigSchema);

export type McpServersConfig = z.infer<typeof McpServersConfigSchema>;

export function parseMcpServers(raw: unknown): McpServersConfig {
  return McpServersConfigSchema.parse(raw);
}

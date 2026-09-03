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
});

export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

export const McpServersConfigSchema = z.record(z.string(), McpServerConfigSchema);

export type McpServersConfig = z.infer<typeof McpServersConfigSchema>;

export function parseMcpServers(raw: unknown): McpServersConfig {
  return McpServersConfigSchema.parse(raw);
}

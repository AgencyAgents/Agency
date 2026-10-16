/** Wire shapes of the daemon, as the gateway sends them. Mirrors packages/schema content blocks. */

export type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "tool_call"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; toolCallId: string; content: string; isError?: boolean }
  | { type: "image"; mimeType: string; data: string };

export interface Message {
  role: "user" | "assistant" | "system";
  content: Block[];
}

export interface Entry {
  id: string;
  parentId: string | null;
  createdAt: string;
  type: string;
  message?: Message;
  title?: string;
  todos?: Todo[];
  usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number; costUsd?: number };
  model?: string;
  summary?: string;
  [key: string]: unknown;
}

export interface Todo {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "ready_for_review";
}

export interface SessionView {
  sessionId: string;
  entries: Entry[];
  tipId: string;
  messages: Message[];
}

export interface SessionRow {
  id: string;
  title: string | null;
  tipId: string | null;
  entries: number;
  updatedAt: string | null;
}

export interface ApprovalRequest {
  tool: string;
  title: string;
  command?: string;
  path?: string;
  riskTier?: string;
  argsSummary?: string;
  source?: string;
}

export interface Approval {
  requestId: string;
  sessionId: string;
  turnId?: string;
  request: ApprovalRequest;
}

export interface ModelInfo {
  id: string;
  family: string;
  name: string;
  providerName?: string;
  contextWindow: number;
  capabilities?: { tools: boolean; vision: boolean; thinking: boolean };
}

export interface ProviderSummary {
  id: string;
  name: string;
  models: { id: string; name: string; contextWindow: number }[];
}

export interface ProvidersList {
  all: ProviderSummary[];
  default: Record<string, string>;
  connected: string[];
}

export type PermissionMode = "ask" | "allow-edits" | "auto" | "allow-all" | "deny";
export type Effort = "low" | "medium" | "high" | "max";

export interface SendResult {
  stopReason: string;
  cancelled: boolean;
  budgetExceeded: boolean;
  error?: { code: string; message: string };
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
}

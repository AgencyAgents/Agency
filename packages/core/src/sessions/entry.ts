import { randomUUID } from "node:crypto";
import type { ThinkingLevel } from "@agency/providers";
import type { Message } from "@agency/schema";

export const SESSION_SCHEMA_VERSION = 2;

/** Every entry carries these regardless of type, including one this reader
 *  doesn't recognize (R5: unknown entries pass through, they're never dropped). */
export interface SessionEntryBase {
  id: string;
  parentId: string | null;
  schemaVersion: number;
  createdAt: string;
  type: string;
}

export type SessionEntry = SessionEntryBase & Record<string, unknown>;

export interface MessageEntry extends SessionEntryBase {
  type: "message";
  message: Message;
}

export interface ModelChangeEntry extends SessionEntryBase {
  type: "model_change";
  model: string;
}

export interface ThinkingLevelChangeEntry extends SessionEntryBase {
  type: "thinking_level_change";
  level: ThinkingLevel;
}

export interface CompactionSummaryEntry extends SessionEntryBase {
  type: "compaction_summary";
  summary: string;
  replacedEntryIds: string[];
}

export interface BranchSummaryEntry extends SessionEntryBase {
  type: "branch_summary";
  label: string;
}

export interface TodoStateEntry extends SessionEntryBase {
  type: "todo_state";
  todos: Array<{
    id: string;
    content: string;
    status: "pending" | "in_progress" | "completed" | "ready_for_review";
    claimedBy?: string;
  }>;
}

export interface AgentMessageEntry extends SessionEntryBase {
  type: "agent_message";
  from: string;
  to: string;
  body: string;
}

export interface AgentLifecycleEntry extends SessionEntryBase {
  type: "agent_lifecycle";
  handle: string;
  state: "working" | "idle" | "blocked" | "failed" | "completed";
  detail?: string;
}

export interface SessionTitleEntry extends SessionEntryBase {
  type: "session_title";
  title: string;
}

export function isMessageEntry(e: SessionEntry): e is SessionEntry & MessageEntry {
  return e.type === "message";
}

export function isCompactionSummaryEntry(e: SessionEntry): e is SessionEntry & CompactionSummaryEntry {
  return e.type === "compaction_summary";
}

export function isBranchSummaryEntry(e: SessionEntry): e is SessionEntry & BranchSummaryEntry {
  return e.type === "branch_summary";
}

export function isTodoStateEntry(e: SessionEntry): e is SessionEntry & TodoStateEntry {
  return e.type === "todo_state";
}

export function isSessionTitleEntry(e: SessionEntry): e is SessionEntry & SessionTitleEntry {
  return e.type === "session_title";
}

export function isAgentMessageEntry(e: SessionEntry): e is SessionEntry & AgentMessageEntry {
  return e.type === "agent_message";
}

export function isAgentLifecycleEntry(e: SessionEntry): e is SessionEntry & AgentLifecycleEntry {
  return e.type === "agent_lifecycle";
}

export function newEntryId(): string {
  return randomUUID();
}

/** True for anything with the base shape every entry must have, known type or not. */
export function hasEntryShape(raw: unknown): raw is SessionEntry {
  if (typeof raw !== "object" || raw === null) return false;
  const r = raw as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    (typeof r.parentId === "string" || r.parentId === null) &&
    typeof r.schemaVersion === "number" &&
    typeof r.createdAt === "string" &&
    typeof r.type === "string"
  );
}

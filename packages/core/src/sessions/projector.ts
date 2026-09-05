import type { AgentLifecycleEntry, MessageEntry, SessionEntry } from "./entry.ts";
import { isAgentLifecycleEntry, isMessageEntry } from "./entry.ts";
import type { SessionStore } from "./store.ts";

/**
 * A projected session event — a higher-level interpretation of the raw JSONL
 * entries that the SessionStore persists. The projector reads the append-only
 * log and emits these events in chronological order, purely in-memory, with
 * no persistence or DB dependency.
 *
 * Event semantics:
 * - Created: the first entry in the session (session was created)
 * - Updated: every entry appended to the session
 * - Deleted: the session file no longer exists on disk
 * - StepStarted: an agent began working (agent_lifecycle state "working")
 * - Ended: an agent stopped working (agent_lifecycle state "idle")
 * - ToolCalled: a message entry contains a tool_call block
 * - Success: an agent completed successfully (agent_lifecycle state "completed")
 * - Failed: an agent failed (agent_lifecycle state "failed")
 */
export type SessionEvent =
  | {
      type: "Created";
      sessionId: string;
      timestamp: string;
      entry: SessionEntry;
    }
  | {
      type: "Updated";
      sessionId: string;
      timestamp: string;
      entry: SessionEntry;
    }
  | {
      type: "Deleted";
      sessionId: string;
      timestamp: string;
    }
  | {
      type: "StepStarted";
      sessionId: string;
      timestamp: string;
      stepId: string;
      detail?: string;
      entry: SessionEntry;
    }
  | {
      type: "Ended";
      sessionId: string;
      timestamp: string;
      stepId: string;
      entry: SessionEntry;
    }
  | {
      type: "ToolCalled";
      sessionId: string;
      timestamp: string;
      toolName: string;
      toolInput: unknown;
      entry: SessionEntry;
    }
  | {
      type: "Success";
      sessionId: string;
      timestamp: string;
      stepId: string;
      entry: SessionEntry;
    }
  | {
      type: "Failed";
      sessionId: string;
      timestamp: string;
      stepId: string;
      error?: string;
      entry: SessionEntry;
    };

/**
 * In-memory SessionProjector that reads SessionStore JSONL entries and
 * projects them into a timeline of SessionEvents. Pure in-memory — no DB,
 * no persistence — operates over the existing JSONL via SessionStore.
 */
export class SessionProjector {
  constructor(private readonly store: SessionStore) {}

  /**
   * Project all entries for a session into a chronological event timeline.
   * Returns an empty array when the session has no entries.
   * Emits a Deleted event when the session file no longer exists.
   */
  project(sessionId: string): SessionEvent[] {
    const entries = this.store.load(sessionId);

    if (entries.length === 0) {
      // Session might have been deleted — check if it's known at all.
      if (!this.store.list().includes(sessionId)) {
        return [
          {
            type: "Deleted",
            sessionId,
            timestamp: new Date().toISOString(),
          },
        ];
      }
      return [];
    }

    return this.projectEntries(sessionId, entries);
  }

  /**
   * Project only the entries on the chain ending at `tipId` into events.
   * Useful for projecting a specific branch rather than the full session.
   */
  projectChain(sessionId: string, tipId: string): SessionEvent[] {
    const entries = this.store.load(sessionId);
    const chain = this.store.chainFor(entries, tipId);
    if (chain.length === 0) return [];
    return this.projectEntries(sessionId, chain);
  }

  private projectEntries(sessionId: string, entries: SessionEntry[]): SessionEvent[] {
    const events: SessionEvent[] = [];

    for (let i = 0; i < entries.length; i++) {
      const entry = entries.at(i);
      if (!entry) continue;
      const timestamp = entry.createdAt;

      // First entry → Created
      if (i === 0) {
        events.push({ type: "Created", sessionId, timestamp, entry });
      }

      // Every entry → Updated
      events.push({ type: "Updated", sessionId, timestamp, entry });

      // Agent lifecycle → StepStarted / Ended / Success / Failed
      if (isAgentLifecycleEntry(entry)) {
        const al = entry as SessionEntry & AgentLifecycleEntry;
        const stepId = al.id;
        switch (al.state) {
          case "working":
            events.push({
              type: "StepStarted",
              sessionId,
              timestamp,
              stepId,
              detail: al.detail,
              entry,
            });
            break;
          case "completed":
            events.push({ type: "Success", sessionId, timestamp, stepId, entry });
            events.push({ type: "Ended", sessionId, timestamp, stepId, entry });
            break;
          case "failed":
            events.push({
              type: "Failed",
              sessionId,
              timestamp,
              stepId,
              error: al.detail,
              entry,
            });
            events.push({ type: "Ended", sessionId, timestamp, stepId, entry });
            break;
          case "idle":
            events.push({ type: "Ended", sessionId, timestamp, stepId, entry });
            break;
          // "blocked" — no direct event mapping, falls through
        }
      }

      // Message entries with tool_call blocks → ToolCalled
      if (isMessageEntry(entry)) {
        const msg = entry as SessionEntry & MessageEntry;
        for (const block of msg.message.content) {
          if (block.type === "tool_call") {
            events.push({
              type: "ToolCalled",
              sessionId,
              timestamp,
              toolName: block.name,
              toolInput: block.input,
              entry,
            });
          }
        }
      }
    }

    return events;
  }
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BoardItem } from "./todo.ts";

export interface TeamWindow {
  teamId: string;
  leadSessionId: string;
  budgetUsd?: number;
  spentUsd: number;
  decisions: string[];
  boardSnapshot: BoardItem[];
  transcript: string[];
  createdAt: string;
  updatedAt: string;
}

export interface AgentRecord {
  teamId: string;
  itemId: string;
  handle: string;
  spans: Array<{ step: number; tool: string; target: string; ok: boolean }>;
  cassette: string;
  closedAt: string;
}

export interface AgentWindow {
  teamId: string;
  itemId: string;
  handle: string;
  budgetUsd?: number;
  turnsUsed: number;
  compactionCount: number;
  live: boolean;
  record?: AgentRecord;
}

export interface ItemCompactionInput {
  contract: BoardItem;
  decisions: string[];
  filesTouched: string[];
  verification: string;
  openQuestions: string[];
  exploration: string[];
}

function teamFile(root: string, teamId: string): string {
  return join(root, ".agency", "teams", `${teamId}.json`);
}

function agentFile(root: string, teamId: string, itemId: string): string {
  return join(root, ".agency", "teams", "agents", `${teamId}-${itemId}.json`);
}

function now(): string {
  return new Date().toISOString();
}

export class TeamWindowStore {
  constructor(private readonly workspaceRoot: string) {}

  open(teamId: string, leadSessionId: string, budgetUsd?: number): TeamWindow {
    const window: TeamWindow = {
      teamId,
      leadSessionId,
      ...(budgetUsd === undefined ? {} : { budgetUsd }),
      spentUsd: 0,
      decisions: [],
      boardSnapshot: [],
      transcript: [],
      createdAt: now(),
      updatedAt: now(),
    };
    this.save(window);
    return window;
  }

  load(teamId: string): TeamWindow | undefined {
    const file = teamFile(this.workspaceRoot, teamId);
    if (!existsSync(file)) return undefined;
    try {
      return JSON.parse(readFileSync(file, "utf8")) as TeamWindow;
    } catch {
      return undefined;
    }
  }

  save(window: TeamWindow): void {
    const file = teamFile(this.workspaceRoot, window.teamId);
    mkdirSync(join(file, ".."), { recursive: true });
    window.updatedAt = now();
    writeFileSync(file, JSON.stringify(window, null, 2), "utf8");
  }

  decide(teamId: string, decision: string): void {
    const window = this.load(teamId);
    if (!window) return;
    window.decisions.push(decision);
    this.save(window);
  }

  snapshotBoard(teamId: string, items: BoardItem[]): void {
    const window = this.load(teamId);
    if (!window) return;
    window.boardSnapshot = [...items];
    this.save(window);
  }

  spend(teamId: string, usd: number): void {
    const window = this.load(teamId);
    if (!window) return;
    window.spentUsd += usd;
    this.save(window);
  }

  appendTranscript(teamId: string, line: string): void {
    const window = this.load(teamId);
    if (!window) return;
    window.transcript.push(line);
    this.save(window);
  }

  compactTeamWindow(teamId: string): TeamWindow | undefined {
    const window = this.load(teamId);
    if (!window) return undefined;
    window.transcript = [
      `compacted: ${window.decisions.length} decisions, ${window.boardSnapshot.length} items, spent $${window.spentUsd.toFixed(4)}`,
    ];
    this.save(window);
    return window;
  }

  statusLine(teamId: string): string {
    const window = this.load(teamId);
    if (!window) return `team ${teamId} unknown`;
    const items = window.boardSnapshot;
    const done = items.filter((i) => i.status === "completed").length;
    const review = items.filter((i) => i.status === "ready_for_review").length;
    return `team ${String(items.length)} items, ${String(done)} done, ${String(review)} in review, $${window.spentUsd.toFixed(2)}`;
  }
}

export class AgentWindowStore {
  constructor(
    private readonly workspaceRoot: string,
    private readonly onSecondCompaction?: (teamId: string, itemId: string, handle: string) => void,
  ) {}

  open(teamId: string, itemId: string, handle: string, budgetUsd?: number): AgentWindow {
    const window: AgentWindow = {
      teamId,
      itemId,
      handle,
      ...(budgetUsd === undefined ? {} : { budgetUsd }),
      turnsUsed: 0,
      compactionCount: 0,
      live: true,
    };
    this.save(window);
    return window;
  }

  load(teamId: string, itemId: string): AgentWindow | undefined {
    const file = agentFile(this.workspaceRoot, teamId, itemId);
    if (!existsSync(file)) return undefined;
    try {
      return JSON.parse(readFileSync(file, "utf8")) as AgentWindow;
    } catch {
      return undefined;
    }
  }

  save(window: AgentWindow): void {
    const file = agentFile(this.workspaceRoot, window.teamId, window.itemId);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify(window, null, 2), "utf8");
  }

  close(
    teamId: string,
    itemId: string,
    record: Omit<AgentRecord, "teamId" | "itemId" | "handle" | "closedAt"> & { handle?: string },
  ): AgentWindow | undefined {
    const window = this.load(teamId, itemId);
    if (!window) return undefined;
    window.live = false;
    window.record = {
      teamId,
      itemId,
      handle: record.handle ?? window.handle,
      spans: record.spans,
      cassette: record.cassette,
      closedAt: now(),
    };
    this.save(window);
    return window;
  }

  compact(
    teamId: string,
    itemId: string,
    input: ItemCompactionInput,
  ): { text: string; second: boolean } | undefined {
    const window = this.load(teamId, itemId);
    if (!window) return undefined;
    window.compactionCount += 1;
    this.save(window);
    const second = window.compactionCount >= 2;
    if (second) this.onSecondCompaction?.(teamId, itemId, window.handle);
    return { text: compactItemWindow(input), second };
  }
}

export function compactItemWindow(input: ItemCompactionInput): string {
  const lines = [
    `contract: ${input.contract.id} ${input.contract.content}`,
    `acceptance: ${input.contract.acceptanceCriteria ?? "(none)"}`,
    `decisions: ${input.decisions.length > 0 ? input.decisions.join("; ") : "(none)"}`,
    `files: ${input.filesTouched.length > 0 ? input.filesTouched.join(", ") : "(none)"}`,
    `verification: ${input.verification.length > 0 ? input.verification : "(none)"}`,
    `open: ${input.openQuestions.length > 0 ? input.openQuestions.join("; ") : "(none)"}`,
  ];
  if (input.exploration.length > 0) {
    lines.push(`explored: ${summarizeExploration(input.exploration)}`);
  }
  return lines.join("\n");
}

function summarizeExploration(lines: string[]): string {
  const seen = new Set<string>();
  for (const line of lines) {
    const head = line.split(/[:/]/)[0]?.trim() ?? "";
    if (head.length > 0) seen.add(head);
    if (seen.size >= 8) break;
  }
  return `${String(lines.length)} read-only lines across ${[...seen].join(", ") || "no paths"}`;
}

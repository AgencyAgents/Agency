import { readFile, writeFile } from "node:fs/promises";

/** Schema version for persisted dispatch state. Bumped only additively. */
export const DISPATCH_STATE_VERSION = 1;

// Stable skip reason codes consumed by U11 feedback wiring.
export type DispatchSkipReason =
  | "empty-input"
  | "invalid-entry"
  | "unknown-handle"
  | "nested-blocked"
  | "depth-limit"
  | "orchestra-budget-exceeded"
  | "per-agent-budget-exceeded";

/** Every known skip reason. Coverage tests assert this list stays stable. */
export const DISPATCH_SKIP_REASONS: readonly DispatchSkipReason[] = [
  "empty-input",
  "invalid-entry",
  "unknown-handle",
  "nested-blocked",
  "depth-limit",
  "orchestra-budget-exceeded",
  "per-agent-budget-exceeded",
];

/** One requested dispatch target with optional per-agent overrides. */
export interface DispatchAgentRequest {
  handle: string;
  brief: string;
  effort?: string;
  model?: string;
  tools?: string[];
}

/** Registry-side record consulted when a request omits an override. */
export interface DispatchAgentRecord {
  handle: string;
  effort?: string;
  model?: string;
  tools?: string[];
}

/** Fallback values used only when request and registry both omit a field. */
export interface DispatchDefaults {
  effort?: string;
  model?: string;
  tools?: string[];
}

/** A validated target ready to spawn. */
export interface ResolvedDispatchTarget {
  index: number;
  handle: string;
  brief: string;
  effort?: string;
  model?: string;
  tools?: string[];
}

/** A skipped request. The reason is always machine-readable. */
export interface DispatchSkip {
  index: number;
  handle?: string;
  reason: DispatchSkipReason;
  detail: string;
}

/** Pick first defined value: per-agent request beats registry beats default. */
export function pickOverride<T>(
  request: T | undefined,
  agent: T | undefined,
  fallback: T | undefined,
): T | undefined {
  if (request !== undefined) return request;
  if (agent !== undefined) return agent;
  return fallback;
}

/** Resolve one target with per-agent over registry over default precedence. */
export function resolveDispatchTarget(
  request: DispatchAgentRequest,
  agent: DispatchAgentRecord | undefined,
  defaults: DispatchDefaults = {},
): ResolvedDispatchTarget {
  return {
    index: 0,
    handle: request.handle,
    brief: request.brief,
    effort: pickOverride(request.effort, agent?.effort, defaults.effort),
    model: pickOverride(request.model, agent?.model, defaults.model),
    tools: pickOverride(request.tools, agent?.tools, defaults.tools),
  };
}

/** Depth gate shared by dispatch and task tools. Null means proceed. */
export function checkDepthGate(
  kind: "dispatch" | "task",
  depth: number,
  maxDepth: number,
): DispatchSkip | null {
  if (depth > 0) {
    return {
      index: -1,
      reason: "nested-blocked",
      detail: kind === "dispatch" ? "nested dispatch blocked" : "nested task blocked",
    };
  }
  if (depth >= maxDepth) {
    return {
      index: -1,
      reason: "depth-limit",
      detail:
        kind === "dispatch"
          ? `depth limit reached (${depth} >= ${maxDepth})`
          : `depth limit reached (${depth} >= ${maxDepth})`,
    };
  }
  return null;
}

export interface PlanDispatchOptions {
  resolveHandle: (handle: string) => DispatchAgentRecord | undefined;
  defaults?: DispatchDefaults;
  taskDepth?: number;
  maxDepth?: number;
  budgets?: { perAgentUsd?: number; orchestraUsd?: number };
  perAgentSpend?: Map<string, number>;
  orchestraTotal?: number;
}

export interface DispatchPlan {
  targets: ResolvedDispatchTarget[];
  skips: DispatchSkip[];
}

/** Single dispatch entry: every request lands in targets or skips. */
export function planDispatchBatch(
  requests: readonly DispatchAgentRequest[],
  opts: PlanDispatchOptions,
): DispatchPlan {
  const taskDepth = opts.taskDepth ?? 0;
  if (requests.length === 0) {
    return {
      targets: [],
      skips: [{ index: -1, reason: "empty-input", detail: "no agents to dispatch" }],
    };
  }
  if (taskDepth > 0) {
    return {
      targets: [],
      skips: requests.map((r, index) => ({
        index,
        handle: typeof r?.handle === "string" ? r.handle : undefined,
        reason: "nested-blocked" as const,
        detail: "nested dispatch blocked: subagents cannot dispatch",
      })),
    };
  }
  const maxDepth = opts.maxDepth ?? 3;
  if (taskDepth >= maxDepth) {
    return {
      targets: [],
      skips: requests.map((r, index) => ({
        index,
        handle: typeof r?.handle === "string" ? r.handle : undefined,
        reason: "depth-limit" as const,
        detail: `dispatch depth limit reached (${taskDepth} >= ${maxDepth})`,
      })),
    };
  }
  const targets: ResolvedDispatchTarget[] = [];
  const skips: DispatchSkip[] = [];
  requests.forEach((r, index) => {
    if (
      typeof r?.handle !== "string" ||
      r.handle.length === 0 ||
      typeof r?.brief !== "string" ||
      r.brief.length === 0
    ) {
      skips.push({
        index,
        reason: "invalid-entry",
        detail: "each agent requires a non-empty handle and brief",
      });
      return;
    }
    const agent = opts.resolveHandle(r.handle);
    if (!agent) {
      skips.push({
        index,
        handle: r.handle,
        reason: "unknown-handle",
        detail: `unknown handle: ${r.handle}`,
      });
      return;
    }
    if (opts.budgets?.orchestraUsd !== undefined && (opts.orchestraTotal ?? 0) >= opts.budgets.orchestraUsd) {
      skips.push({
        index,
        handle: r.handle,
        reason: "orchestra-budget-exceeded",
        detail: `orchestra budget exceeded: ${opts.orchestraTotal} >= ${opts.budgets.orchestraUsd}`,
      });
      return;
    }
    const spent = opts.perAgentSpend?.get(r.handle) ?? 0;
    if (opts.budgets?.perAgentUsd !== undefined && spent >= opts.budgets.perAgentUsd) {
      skips.push({
        index,
        handle: r.handle,
        reason: "per-agent-budget-exceeded",
        detail: `budget exceeded: per-agent ${spent} >= ${opts.budgets.perAgentUsd}`,
      });
      return;
    }
    const resolved = resolveDispatchTarget(r, agent, opts.defaults);
    targets.push({ ...resolved, index });
  });
  return { targets, skips };
}

/** Render a skip as one line with a stable machine-readable token. */
export function formatSkipLine(skip: DispatchSkip): string {
  const who = skip.handle ?? `#${skip.index}`;
  return `${who}: [skip:${skip.reason}] ${skip.detail}`;
}

/** One persisted dispatch outcome. New optional fields must stay additive. */
export interface PersistedDispatchEntry {
  index: number;
  handle: string;
  brief: string;
  effort?: string;
  model?: string;
  status: "dispatched" | "skipped";
  reason?: DispatchSkipReason;
  at: string;
}

/** Versioned persisted dispatch state. Unknown versions are ignored on load. */
export interface PersistedDispatchState {
  version: number;
  entries: PersistedDispatchEntry[];
}

/** In-memory dispatch state with file persist and reload roundtrip. */
export class DispatchStateStore {
  private entries: PersistedDispatchEntry[] = [];

  constructor(initial: readonly PersistedDispatchEntry[] = []) {
    this.entries = [...initial];
  }

  append(entry: Omit<PersistedDispatchEntry, "at"> & { at?: string }): PersistedDispatchEntry {
    const full: PersistedDispatchEntry = { ...entry, at: entry.at ?? new Date().toISOString() };
    this.entries.push(full);
    return full;
  }

  list(): PersistedDispatchEntry[] {
    return [...this.entries];
  }

  clear(): void {
    this.entries.length = 0;
  }

  toJSON(): PersistedDispatchState {
    return { version: DISPATCH_STATE_VERSION, entries: [...this.entries] };
  }

  async save(file: string): Promise<void> {
    await writeFile(file, JSON.stringify(this.toJSON()), "utf8");
  }

  static fromJSON(raw: unknown): DispatchStateStore {
    if (typeof raw !== "object" || raw === null) return new DispatchStateStore();
    const state = raw as { version?: unknown; entries?: unknown };
    if (state.version !== DISPATCH_STATE_VERSION) return new DispatchStateStore();
    if (!Array.isArray(state.entries)) return new DispatchStateStore();
    const entries = (state.entries as PersistedDispatchEntry[]).filter(
      (e) => typeof e?.index === "number" && typeof e?.handle === "string",
    );
    return new DispatchStateStore(entries);
  }

  static async load(file: string): Promise<DispatchStateStore> {
    try {
      const text = await readFile(file, "utf8");
      return DispatchStateStore.fromJSON(JSON.parse(text) as unknown);
    } catch {
      return new DispatchStateStore();
    }
  }
}

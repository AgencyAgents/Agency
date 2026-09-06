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
  /** Estimated cost applied to running budget totals when accepted. */
  costUsd?: number;
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
  // Limit check first so the depth-limit branch stays reachable when nested.
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
  if (depth > 0) {
    return {
      index: -1,
      reason: "nested-blocked",
      detail: kind === "dispatch" ? "nested dispatch blocked" : "nested task blocked",
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
  const targets: ResolvedDispatchTarget[] = [];
  const skips: DispatchSkip[] = [];
  // Running totals so accepted targets consume budget mid-batch.
  let runningOrchestra = opts.orchestraTotal ?? 0;
  const runningPerAgent = new Map(opts.perAgentSpend);
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
    if (opts.budgets?.orchestraUsd !== undefined && runningOrchestra >= opts.budgets.orchestraUsd) {
      skips.push({
        index,
        handle: r.handle,
        reason: "orchestra-budget-exceeded",
        detail: `orchestra budget exceeded: ${runningOrchestra} >= ${opts.budgets.orchestraUsd}`,
      });
      return;
    }
    const spent = runningPerAgent.get(r.handle) ?? 0;
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
    const cost = r.costUsd ?? 0;
    runningOrchestra += cost;
    runningPerAgent.set(r.handle, spent + cost);
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
    return DispatchStateStore.fromJSONWithStatus(raw).store;
  }

  /** Validating parse: malformed entries are dropped, status kept additive. */
  static fromJSONWithStatus(raw: unknown): { store: DispatchStateStore; versionMismatch: boolean } {
    if (typeof raw !== "object" || raw === null)
      return { store: new DispatchStateStore(), versionMismatch: false };
    const state = raw as { version?: unknown; entries?: unknown };
    if (state.version !== DISPATCH_STATE_VERSION)
      return { store: new DispatchStateStore(), versionMismatch: true };
    if (!Array.isArray(state.entries)) return { store: new DispatchStateStore(), versionMismatch: false };
    const entries = (state.entries as unknown[]).filter(isPersistedDispatchEntry);
    return { store: new DispatchStateStore(entries), versionMismatch: false };
  }

  static async load(file: string): Promise<DispatchStateStore> {
    return (await DispatchStateStore.loadWithStatus(file)).store;
  }

  /** Status-returning load for daemon readiness: ok, missing, corrupt, or version-mismatch. */
  static async loadWithStatus(
    file: string,
  ): Promise<{ store: DispatchStateStore; status: DispatchLoadStatus }> {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      return { store: new DispatchStateStore(), status: "missing" };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch {
      return { store: new DispatchStateStore(), status: "corrupt" };
    }
    const { store, versionMismatch } = DispatchStateStore.fromJSONWithStatus(raw);
    if (versionMismatch) return { store, status: "version-mismatch" };
    if (typeof raw !== "object" || raw === null || !Array.isArray((raw as { entries?: unknown }).entries))
      return { store, status: "corrupt" };
    return { store, status: "ok" };
  }
}

/** Load outcome for daemon readiness wiring. */
export type DispatchLoadStatus = "ok" | "missing" | "corrupt" | "version-mismatch";

/** Every field validated; malformed entries are dropped. */
function isPersistedDispatchEntry(e: unknown): e is PersistedDispatchEntry {
  if (typeof e !== "object" || e === null) return false;
  const v = e as Record<string, unknown>;
  if (typeof v.index !== "number" || typeof v.handle !== "string") return false;
  if (typeof v.brief !== "string") return false;
  if (v.status !== "dispatched" && v.status !== "skipped") return false;
  if (v.reason !== undefined && !DISPATCH_SKIP_REASONS.includes(v.reason as DispatchSkipReason)) return false;
  if (typeof v.at !== "string" || Number.isNaN(Date.parse(v.at))) return false;
  if (v.model !== undefined && typeof v.model !== "string") return false;
  if (v.effort !== undefined && typeof v.effort !== "string") return false;
  return true;
}

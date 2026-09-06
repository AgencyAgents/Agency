/**
 * Parallel specialist spawn + promise barrier (item 52).
 *
 * run_in_background-like semantics for the daemon: every specialist is
 * spawned concurrently (no serial await), each child receives only a lean
 * slice of context (brief + one-line summary — never a full history), and a
 * single promise barrier notifies exactly once when the whole batch settles.
 */

/** Lean-context caps: children get briefs, parents get one-line summaries. */
export const LEAN_BRIEF_MAX_CHARS = 2000;
export const LEAN_SUMMARY_MAX_CHARS = 500;
export const LEAN_PROMPT_MAX_CHARS = 200;
export const LEAN_RESULT_PREVIEW_CHARS = 80;

/** Truncate a specialist brief to a lean slice (single string, no history). */
export function leanBrief(brief: string, maxChars: number = LEAN_BRIEF_MAX_CHARS): string {
  if (brief.length <= maxChars) return brief;
  return brief.slice(0, maxChars);
}

/** Collapse a child result to its first line, capped (what the parent sees). */
export function leanSummary(text: string, maxChars: number = LEAN_SUMMARY_MAX_CHARS): string {
  const line = text.split("\n")[0]?.trim() ?? "";
  if (line.length <= maxChars) return line;
  return line.slice(0, maxChars);
}

/** Short prompt excerpt persisted on task_result entries (never the full brief). */
export function leanPrompt(prompt: string, maxChars: number = LEAN_PROMPT_MAX_CHARS): string {
  if (prompt.length <= maxChars) return prompt;
  return prompt.slice(0, maxChars);
}

export interface BarrierSettled<T> {
  index: number;
  ok: boolean;
  value?: T;
  error?: unknown;
}

/**
 * Promise barrier: spawned tasks report exactly once via complete/fail, wait()
 * resolves with index-ordered results when every slot settles, and onSettle
 * fires exactly once as the completion notification (run_in_background-like
 * "all done" signal). No context is retained beyond the ordered slots.
 */
export class PromiseBarrier<T> {
  private readonly expected: number;
  private readonly slots: Array<BarrierSettled<T> | undefined>;
  private settled = 0;
  private notified = false;
  private readonly onSettle?: (settled: Array<BarrierSettled<T>>) => void;
  private resolve!: (values: Array<BarrierSettled<T>>) => void;
  private readonly done: Promise<Array<BarrierSettled<T>>>;

  constructor(expected: number, onSettle?: (settled: Array<BarrierSettled<T>>) => void) {
    this.expected = expected;
    this.slots = new Array(expected);
    this.onSettle = onSettle;
    this.done = new Promise<Array<BarrierSettled<T>>>((resolve) => {
      this.resolve = resolve;
    });
    if (expected === 0) {
      this.notified = true;
      this.resolve([]);
      this.onSettle?.([]);
    }
  }

  get completedCount(): number {
    return this.settled;
  }

  get isSettled(): boolean {
    return this.settled >= this.expected;
  }

  complete(index: number, value: T): void {
    this.settle(index, { index, ok: true, value });
  }

  fail(index: number, error: unknown): void {
    this.settle(index, { index, ok: false, error });
  }

  private settle(index: number, entry: BarrierSettled<T>): void {
    if (index < 0 || index >= this.expected) return;
    if (this.slots[index] !== undefined) return;
    this.slots[index] = entry;
    this.settled++;
    if (this.settled >= this.expected && !this.notified) {
      this.notified = true;
      const ordered = (this.slots as Array<BarrierSettled<T>>).slice();
      this.onSettle?.(ordered);
      this.resolve(ordered);
    }
  }

  wait(): Promise<Array<BarrierSettled<T>>> {
    return this.done;
  }
}

export interface SpawnParallelOptions {
  /** Completion notification: fires once when the barrier settles. */
  onSettle?: (settled: Array<BarrierSettled<unknown>>) => void;
  /** AbortSignal shared with every child (a single abort cancels the batch). */
  signal?: AbortSignal;
}

/**
 * run_in_background-like spawn: launch every item concurrently and wait on a
 * single promise barrier. Results preserve input order (index slots, never
 * push-from-parallel), each child failure is captured per-slot so one
 * specialist never takes down its peers, and onSettle notifies once.
 */
export async function spawnParallel<T, R>(
  items: readonly T[],
  run: (item: T, index: number, signal: AbortSignal | undefined) => Promise<R>,
  opts: SpawnParallelOptions = {},
): Promise<{ results: R[]; errors: Array<unknown | undefined>; settled: Array<BarrierSettled<R>> }> {
  const barrier = new PromiseBarrier<R>(
    items.length,
    opts.onSettle as SpawnParallelOptions["onSettle"] as never,
  );
  items.forEach((item, index) => {
    void (async () => {
      if (opts.signal?.aborted) {
        barrier.fail(index, new Error("[cancelled: batch aborted before spawn]"));
        return;
      }
      try {
        const value = await run(item, index, opts.signal);
        barrier.complete(index, value);
      } catch (error) {
        barrier.fail(index, error);
      }
    })();
  });
  const settled = await barrier.wait();
  const results: R[] = new Array(items.length);
  const errors: Array<unknown | undefined> = new Array(items.length);
  for (const s of settled) {
    if (s.ok) {
      results[s.index] = s.value as R;
      errors[s.index] = undefined;
    } else {
      results[s.index] = undefined as unknown as R;
      errors[s.index] = s.error;
    }
  }
  return { results, errors, settled };
}

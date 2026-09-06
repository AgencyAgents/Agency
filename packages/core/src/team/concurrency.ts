// Team-level concurrency: a full five-agent roster still runs fully
// parallel, while larger fan-outs queue behind team slots.
export const TEAM_MAX_CONCURRENT = 5;

export interface TeamLimiter {
  run<T>(fn: () => Promise<T>): Promise<T>;
  active(): number;
}

// FIFO semaphore: queued turns start in arrival order as slots free.
export function createTeamLimiter(max: number = TEAM_MAX_CONCURRENT): TeamLimiter {
  let running = 0;
  const queue: Array<() => void> = [];
  const pump = (): void => {
    while (running < max && queue.length > 0) {
      const next = queue.shift();
      if (!next) return;
      running += 1;
      next();
    }
  };
  return {
    active: () => running,
    run<T>(fn: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        queue.push(() => {
          void (async () => {
            try {
              resolve(await fn());
            } catch (error) {
              reject(error instanceof Error ? error : new Error(String(error)));
            } finally {
              running -= 1;
              pump();
            }
          })();
        });
        pump();
      });
    },
  };
}

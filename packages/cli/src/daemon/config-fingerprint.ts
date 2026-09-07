import { statSync } from "node:fs";

export function createConfigFingerprint(paths: readonly string[]): { check(): boolean } {
  const snapshot = new Map<string, number>();
  for (const p of paths) {
    try {
      snapshot.set(p, statSync(p).mtimeMs);
    } catch {
      snapshot.set(p, 0);
    }
  }
  return {
    check: () => {
      for (const [p, prev] of snapshot) {
        let cur = 0;
        try {
          cur = statSync(p).mtimeMs;
        } catch {
          cur = 0;
        }
        if (cur !== prev) return true;
      }
      return false;
    },
  };
}

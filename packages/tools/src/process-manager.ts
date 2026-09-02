import { randomUUID } from "node:crypto";

const MAX_LOG_BYTES = 256 * 1024; // bounded ring buffer per process, not unbounded growth

export interface ManagedProcessInfo {
  id: string;
  command: string;
  pid: number;
  startedAt: string;
  running: boolean;
}

interface Entry {
  proc: ReturnType<typeof Bun.spawn>;
  command: string;
  startedAt: string;
  log: string;
  exited: boolean;
}

function appendBounded(log: string, chunk: string): string {
  const combined = log + chunk;
  return combined.length > MAX_LOG_BYTES ? combined.slice(combined.length - MAX_LOG_BYTES) : combined;
}

/**
 * Tracks processes meant to outlive a single tool call (dev servers,
 * watchers), distinct from the bash tool's own one-shot subprocess, which
 * the loop's cancellation already reaches directly. Everything here gets
 * killed on session end so nothing orphans past the session that started it.
 */
export class ProcessManager {
  private readonly entries = new Map<string, Entry>();

  spawn(command: string[], options: { cwd?: string } = {}): ManagedProcessInfo {
    const id = randomUUID();
    const proc = Bun.spawn(command, {
      cwd: options.cwd,
      stdout: "pipe",
      stderr: "pipe",
    });

    const entry: Entry = {
      proc,
      command: command.join(" "),
      startedAt: new Date().toISOString(),
      log: "",
      exited: false,
    };
    this.entries.set(id, entry);

    // proc.exitCode only updates once something has awaited `.exited`, so
    // that's tracked explicitly here rather than read lazily on demand.
    void proc.exited.then(() => {
      entry.exited = true;
    });
    void this.pump(id, proc.stdout);
    void this.pump(id, proc.stderr);

    return this.toInfo(id, entry);
  }

  private async pump(id: string, stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      const entry = this.entries.get(id);
      if (!entry) return;
      entry.log = appendBounded(entry.log, decoder.decode(chunk, { stream: true }));
    }
  }

  getLogs(id: string): string | undefined {
    return this.entries.get(id)?.log;
  }

  list(): ManagedProcessInfo[] {
    return [...this.entries.entries()].map(([id, entry]) => this.toInfo(id, entry));
  }

  kill(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.stopEntry(entry);
    return true;
  }

  /** Adopt an externally spawned proc (e.g. an MCP server) so it is reaped with the session. */
  adopt(proc: { pid?: number; kill: () => void }, command: string): string {
    const id = randomUUID();
    this.entries.set(id, {
      proc: proc as ReturnType<typeof Bun.spawn>,
      command,
      startedAt: new Date().toISOString(),
      log: "",
      exited: false,
    });
    return id;
  }

  /** Called on session end so nothing this manager started outlives it. */
  killAll(): void {
    for (const entry of this.entries.values()) this.stopEntry(entry);
  }

  private stopEntry(entry: Entry): void {
    const pid = entry.proc.pid;
    // Adopted procs may not expose a pid, and exited processes have no tree left.
    if (!entry.exited && typeof pid === "number" && pid > 0) {
      this.killTree(pid);
    }
    try {
      entry.proc.kill();
    } catch {
      // already exited — nothing to reap
    }
    entry.exited = true;
  }

  /**
   * Terminate a process and its descendants, not just the direct child:
   * MCP servers spawned via npx routinely shell out to grandchildren that
   * would otherwise orphan past the session. Best-effort by design — any
   * failure leaves the direct proc.kill() at the call site as the fallback.
   */
  private killTree(pid: number): void {
    try {
      if (process.platform === "win32") {
        // /T walks the child tree, /F forces termination.
        Bun.spawnSync(["taskkill", "/pid", String(pid), "/T", "/F"]);
        return;
      }
      try {
        // A negative pid signals the process group. This only lands when the
        // child is its own group leader; otherwise no live group has this id
        // (pgids equal their leader's pid) and it throws ESRCH, which is safe.
        process.kill(-pid, "SIGTERM");
        return;
      } catch {
        // not a group leader (ESRCH) or denied (EPERM) — walk the tree instead
      }
      this.killDescendants(pid);
    } catch {
      // missing taskkill/pgrep or spawn failure — direct kill still follows
    }
  }

  /** Depth-first SIGTERM over everything under `pid` (itself excluded). */
  private killDescendants(pid: number): void {
    let children: number[];
    try {
      const result = Bun.spawnSync(["pgrep", "-P", String(pid)]);
      children = result.stdout
        .toString()
        .split(/\s+/)
        .map((part) => Number.parseInt(part, 10))
        .filter((n) => Number.isFinite(n) && n > 0);
    } catch {
      return; // pgrep unavailable — descendants leak rather than misfire
    }
    for (const child of children) {
      // Recurse before killing: once the child dies its subtree is reparented
      // and unreachable via pgrep -P.
      this.killDescendants(child);
      try {
        process.kill(child, "SIGTERM");
      } catch {
        // already gone or permission denied
      }
    }
  }

  private toInfo(id: string, entry: Entry): ManagedProcessInfo {
    return {
      id,
      command: entry.command,
      pid: entry.proc.pid,
      startedAt: entry.startedAt,
      running: !entry.exited,
    };
  }
}

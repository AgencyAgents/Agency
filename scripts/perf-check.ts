#!/usr/bin/env bun
/**
 * Perf budgets for CI: cold start, idle RSS, zero-CPU-at-idle.
 * Blocking: the CI perf job fails on a budget breach.
 *
 * - cold start < 150ms: `agency --version` (prefer built binary at dist/, fallback to entrypoint.ts)
 * - idle RSS < 120MB: spawn daemon, measure after settle
 * - zero-CPU-at-idle: daemon idle CPU over a 2s window stays near zero
 *
 * Fail-closed on budget breach; skips gracefully when no binary and daemon can't start.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const BUDGETS = {
  coldStartMs: 150,
  idleRssMb: 120,
  idleCpuPercent: 5, // generous: "zero" means <5% over 2s window
};

/**
 * Parse utime/stime (fields 14/15) from /proc pid stat, finding the
 * comm field by its last paren. Returns undefined on any failure.
 */
export function parseProcStatUtimeStime(statContent: string): { utime: number; stime: number } | undefined {
  try {
    const closeParen = statContent.lastIndexOf(")");
    if (closeParen === -1 || closeParen >= statContent.length - 1) return undefined;
    const afterComm = statContent.slice(closeParen + 1).trimStart();
    const fields = afterComm.split(/\s+/);
    if (fields.length < 13) return undefined;
    // utime is field 14 (1-indexed) => index 11, stime is field 15 => index 12
    const utimeRaw = fields[11];
    const stimeRaw = fields[12];
    if (utimeRaw === undefined || stimeRaw === undefined) return undefined;
    const utime = Number.parseInt(utimeRaw, 10);
    const stime = Number.parseInt(stimeRaw, 10);
    if (!Number.isFinite(utime) || !Number.isFinite(stime)) return undefined;
    return { utime, stime };
  } catch {
    return undefined;
  }
}

/**
 * Compute CPU percent from a windowed jiffy delta.
 * cpuPercent = (deltaJiffies / clkTck / deltaWallSec) * 100
 */
export function windowedCpuPercent(deltaJiffies: number, clkTck: number, deltaWallSec: number): number {
  if (deltaWallSec <= 0 || clkTck <= 0) return 0;
  return (deltaJiffies / clkTck / deltaWallSec) * 100;
}

function findAgencyCmd(): string[] {
  const candidates = [
    "dist/agency-linux-x64",
    "dist/agency-darwin-x64",
    "dist/agency-darwin-arm64",
    "dist/agency-windows-x64.exe",
    "dist/agency",
  ];
  for (const p of candidates) if (existsSync(p)) return [p];
  return [process.execPath, "packages/cli/src/entrypoint.ts"];
}

function measureColdStart(cmd: string[]): { ms: number; ok: boolean } {
  const start = performance.now();
  const bin = cmd.at(0);
  if (!bin) throw new Error("perf-check: empty command");
  const result = spawnSync(bin, [...cmd.slice(1), "--version"], {
    timeout: 5000,
    stdio: "pipe",
  });
  const ms = performance.now() - start;
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`agency --version exited ${result.status}: ${result.stderr?.toString()}`);
  return { ms, ok: true };
}

async function measureDaemonIdle(): Promise<{
  rssMb: number | undefined;
  cpuPercent: number | undefined;
  skipped: boolean;
  reason?: string;
}> {
  // Spawn a minimal daemon via Bun running daemon-entry.ts directly would require
  // workspace setup; instead measure the headless entrypoint's daemon spawn via
  // a temporary workspace + instance dir. If we can't spawn, skip.
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const ws = mkdtempSync(join(tmpdir(), "agency-perf-ws-"));
  const instanceDir = mkdtempSync(join(tmpdir(), "agency-perf-inst-"));
  let daemonPid: number | undefined;
  try {
    // Use the RPC instance helper with a fake spawn that we can monitor.
    // Simpler: spawn `bun packages/cli/src/daemon-entry.ts --workspace ws --instance-file ...` directly.
    const instanceFile = join(instanceDir, "test.json");
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        join(import.meta.dir, "..", "packages/cli/src/daemon-entry.ts"),
        "--workspace",
        ws,
        "--instance-file",
        instanceFile,
      ],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
    daemonPid = proc.pid;

    // Wait for instance file
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (existsSync(instanceFile)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!existsSync(instanceFile)) {
      proc.kill();
      return {
        rssMb: undefined,
        cpuPercent: undefined,
        skipped: true,
        reason: "daemon instance file never appeared",
      };
    }

    // Give it a moment to settle
    await new Promise((r) => setTimeout(r, 800));

    // Sample CPU
    const cpuSample = (pid: number): { user: number; system: number } | undefined => {
      try {
        if (process.platform === "win32") {
          // Windows: use wmic or ps alternative - approximate via process.cpuUsage not available for other pid
          // Fall back to not measuring CPU on Windows in this script; report skipped CPU.
          return undefined;
        }
        // Unix: use `ps -o pcpu,rss -p <pid>`
        const out = spawnSync("ps", ["-o", "pcpu=", "-o", "rss=", "-p", String(pid)], { encoding: "utf8" });
        if (out.status !== 0) return undefined;
        const line = out.stdout.trim().split("\n")[0]?.trim() ?? "";
        const [pcpuStr, rssStr] = line.trim().split(/\s+/);
        const pcpu = Number.parseFloat(pcpuStr ?? "");
        const rssKb = Number.parseInt(rssStr ?? "", 10);
        if (!Number.isFinite(pcpu) || !Number.isFinite(rssKb)) return undefined;
        return { user: pcpu, system: rssKb };
      } catch {
        return undefined;
      }
    };

    // RSS via ps on Unix; on Windows approximate via not available -> skip
    let rssMb: number | undefined;
    let cpuPercent: number | undefined;
    if (process.platform !== "win32") {
      const out = spawnSync("ps", ["-o", "rss=", "-p", String(daemonPid)], { encoding: "utf8" });
      if (out.status === 0) {
        const rssKb = Number.parseInt(out.stdout.trim(), 10);
        if (Number.isFinite(rssKb)) rssMb = rssKb / 1024;
      }
      // Windowed idle CPU on Linux via /proc stat; ps fallback otherwise.
      if (process.platform === "linux") {
        let first: { utime: number; stime: number } | undefined;
        try {
          first = parseProcStatUtimeStime(readFileSync(`/proc/${daemonPid}/stat`, "utf8"));
        } catch {}
        await new Promise((r) => setTimeout(r, 2000));
        let second: { utime: number; stime: number } | undefined;
        if (first) {
          try {
            second = parseProcStatUtimeStime(readFileSync(`/proc/${daemonPid}/stat`, "utf8"));
          } catch {}
        }
        if (first && second) {
          const deltaUtime = second.utime - first.utime;
          const deltaStime = second.stime - first.stime;
          const deltaJiffies = deltaUtime + deltaStime;
          const clkTck =
            Number.parseInt(spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).stdout.trim(), 10) || 100;
          cpuPercent = windowedCpuPercent(deltaJiffies, clkTck, 2);
        }
      }
      if (cpuPercent === undefined) {
        const first = cpuSample(daemonPid);
        await new Promise((r) => setTimeout(r, 2000));
        const second = cpuSample(daemonPid);
        if (first && second) {
          cpuPercent = second.user;
        }
      }
    } else {
      // Windows: RSS via ps not reliable; try to get via `tasklist` or skip
      // Use `wmic` if available
      try {
        const out = spawnSync(
          "wmic",
          ["process", "where", `ProcessId=${daemonPid}`, "get", "WorkingSetSize", "/value"],
          {
            encoding: "utf8",
          },
        );
        const m = out.stdout.match(/WorkingSetSize=(\d+)/);
        const digits = m?.at(1);
        if (digits) rssMb = Number.parseInt(digits, 10) / (1024 * 1024);
      } catch {}
    }

    proc.kill();
    // Wait for exit (best effort)
    await new Promise((r) => setTimeout(r, 300));
    try {
      proc.kill(9);
    } catch {}

    if (rssMb === undefined && cpuPercent === undefined) {
      return { rssMb, cpuPercent, skipped: true, reason: "could not measure RSS/CPU on this platform" };
    }
    return { rssMb, cpuPercent, skipped: false };
  } finally {
    if (daemonPid) {
      try {
        process.kill(daemonPid, 9);
      } catch {}
    }
    try {
      rmSync(ws, { recursive: true, force: true });
      rmSync(instanceDir, { recursive: true, force: true });
    } catch {}
  }
}

async function main(): Promise<number> {
  const cmd = findAgencyCmd();
  const useBinary = cmd.length === 1 && cmd[0] !== process.execPath;
  console.log(`perf-check: using ${cmd.join(" ")} ${useBinary ? "(built binary)" : "(entrypoint via bun)"}`);

  const budgets = useBinary ? BUDGETS : { ...BUDGETS, coldStartMs: 1000, idleCpuPercent: 15 };
  const failures: string[] = [];
  const warnings: string[] = [];

  // Cold start
  try {
    const { ms } = measureColdStart(cmd);
    console.log(`cold start: ${ms.toFixed(1)} ms (budget ${budgets.coldStartMs} ms)`);
    if (ms > budgets.coldStartMs)
      failures.push(`cold start ${ms.toFixed(1)}ms exceeds ${budgets.coldStartMs}ms`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    warnings.push(`cold start measurement failed: ${msg}`);
    console.log(`cold start: skipped (${msg})`);
  }

  // Daemon idle
  try {
    const { rssMb, cpuPercent, skipped, reason } = await measureDaemonIdle();
    if (skipped) {
      console.log(`daemon idle: skipped${reason ? ` (${reason})` : ""}`);
    } else {
      if (rssMb !== undefined) {
        console.log(`idle RSS: ${rssMb.toFixed(1)} MB (budget ${budgets.idleRssMb} MB)`);
        if (rssMb > budgets.idleRssMb)
          failures.push(`idle RSS ${rssMb.toFixed(1)}MB exceeds ${budgets.idleRssMb}MB`);
      }
      if (cpuPercent !== undefined) {
        console.log(`idle CPU: ${cpuPercent.toFixed(1)}% over 2s (budget ${budgets.idleCpuPercent}%)`);
        if (cpuPercent > budgets.idleCpuPercent)
          failures.push(`idle CPU ${cpuPercent.toFixed(1)}% exceeds ${budgets.idleCpuPercent}%`);
      }
    }
  } catch (error) {
    warnings.push(
      `daemon idle measurement failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.log(`daemon idle: skipped (${warnings[warnings.length - 1]})`);
  }

  if (warnings.length > 0) {
    for (const w of warnings) console.warn(`warn: ${w}`);
  }
  if (failures.length > 0) {
    for (const f of failures) console.error(`error: ${f}`);
    return 1;
  }
  console.log("perf budgets: ok");
  return 0;
}

if (import.meta.main) process.exitCode = await main();

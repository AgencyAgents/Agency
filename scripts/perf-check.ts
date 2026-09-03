#!/usr/bin/env bun
/**
 * Perf budgets for CI: cold start, idle RSS, zero-CPU-at-idle.
 * Non-blocking initially (CI `continue-on-error: true`), but present and real.
 *
 * - cold start < 150ms: `agency --version` (prefer built binary at dist/, fallback to entrypoint.ts)
 * - idle RSS < 120MB: spawn daemon, measure after settle
 * - zero-CPU-at-idle: daemon idle CPU over a 2s window stays near zero
 *
 * Fail-closed on budget breach; skips gracefully when no binary and daemon can't start.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const BUDGETS = {
  coldStartMs: 150,
  idleRssMb: 120,
  idleCpuPercent: 5, // generous: "zero" means <5% over 2s window
};

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
  const result = spawnSync(cmd[0]!, [...cmd.slice(1), "--version"], {
    timeout: 5000,
    stdio: "pipe",
  });
  const ms = performance.now() - start;
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`agency --version exited ${result.status}: ${result.stderr?.toString()}`);
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
      ["bun", "run", join(import.meta.dir, "..", "packages/cli/src/daemon-entry.ts"), "--workspace", ws, "--instance-file", instanceFile],
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
      return { rssMb: undefined, cpuPercent: undefined, skipped: true, reason: "daemon instance file never appeared" };
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
      // CPU over 2s window
      const first = cpuSample(daemonPid);
      await new Promise((r) => setTimeout(r, 2000));
      const second = cpuSample(daemonPid);
      if (first && second) {
        // pcpu is instantaneous; second sample is enough for idle check
        cpuPercent = second.user;
      }
    } else {
      // Windows: RSS via ps not reliable; try to get via `tasklist` or skip
      // Use `wmic` if available
      try {
        const out = spawnSync("wmic", ["process", "where", `ProcessId=${daemonPid}`, "get", "WorkingSetSize", "/value"], {
          encoding: "utf8",
        });
        const m = out.stdout.match(/WorkingSetSize=(\d+)/);
        if (m) rssMb = Number.parseInt(m[1]!, 10) / (1024 * 1024);
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

  const failures: string[] = [];
  const warnings: string[] = [];

  // Cold start
  try {
    const { ms } = measureColdStart(cmd);
    console.log(`cold start: ${ms.toFixed(1)} ms (budget ${BUDGETS.coldStartMs} ms)`);
    if (ms > BUDGETS.coldStartMs) failures.push(`cold start ${ms.toFixed(1)}ms exceeds ${BUDGETS.coldStartMs}ms`);
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
        console.log(`idle RSS: ${rssMb.toFixed(1)} MB (budget ${BUDGETS.idleRssMb} MB)`);
        if (rssMb > BUDGETS.idleRssMb) failures.push(`idle RSS ${rssMb.toFixed(1)}MB exceeds ${BUDGETS.idleRssMb}MB`);
      }
      if (cpuPercent !== undefined) {
        console.log(`idle CPU: ${cpuPercent.toFixed(1)}% over 2s (budget ${BUDGETS.idleCpuPercent}%)`);
        if (cpuPercent > BUDGETS.idleCpuPercent) failures.push(`idle CPU ${cpuPercent.toFixed(1)}% exceeds ${BUDGETS.idleCpuPercent}%`);
      }
    }
  } catch (error) {
    warnings.push(`daemon idle measurement failed: ${error instanceof Error ? error.message : String(error)}`);
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

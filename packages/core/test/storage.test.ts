import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cacheDir,
  dataDir,
  logDir,
  pruneCache,
  pruneSessions,
  reportStorage,
  storagePaths,
  workspaceId,
} from "../src/storage.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeEnv() {
  const home = mkdtempSync(join(tmpdir(), "agency-storage-"));
  dirs.push(home);
  return { home, env: { HOME: home } as NodeJS.ProcessEnv };
}

describe("per-OS directories", () => {
  test("windows uses LOCALAPPDATA, separating data from cache", () => {
    const env = { LOCALAPPDATA: "C:\\Users\\pixel\\AppData\\Local" } as NodeJS.ProcessEnv;
    expect(dataDir(env, "win32")).toBe(join("C:\\Users\\pixel\\AppData\\Local", "Agency"));
    expect(cacheDir(env, "win32")).toBe(join("C:\\Users\\pixel\\AppData\\Local", "Agency", "Cache"));
    expect(logDir(env, "win32")).toBe(join("C:\\Users\\pixel\\AppData\\Local", "Agency", "logs"));
  });

  test("linux respects XDG_DATA_HOME and XDG_CACHE_HOME", () => {
    const env = { XDG_DATA_HOME: "/data", XDG_CACHE_HOME: "/cache" } as NodeJS.ProcessEnv;
    expect(dataDir(env, "linux")).toBe(join("/data", "agency"));
    expect(cacheDir(env, "linux")).toBe(join("/cache", "agency"));
  });
});

describe("workspaceId", () => {
  test("is stable for the same root and differs across roots", () => {
    expect(workspaceId("/a/b")).toBe(workspaceId("/a/b"));
    expect(workspaceId("/a/b")).not.toBe(workspaceId("/a/c"));
  });
});

describe("storagePaths", () => {
  test("scopes sessions per workspace but shares one global snapshot store", () => {
    const env = { LOCALAPPDATA: "C:\\data" } as NodeJS.ProcessEnv;
    const a = storagePaths("/repo/a", env, "win32");
    const b = storagePaths("/repo/b", env, "win32");
    expect(a.sessionsDir).not.toBe(b.sessionsDir);
    expect(a.snapshotsDir).toBe(b.snapshotsDir);
  });
});

describe("reportStorage and pruneCache", () => {
  test("reports sizes by category, and pruning cache empties it without touching data", async () => {
    const { home } = fakeEnv();
    const env = {
      XDG_DATA_HOME: join(home, "data"),
      XDG_CACHE_HOME: join(home, "cache"),
    } as NodeJS.ProcessEnv;

    mkdirSync(join(home, "data", "agency", "sessions"), { recursive: true });
    writeFileSync(join(home, "data", "agency", "sessions", "s1.jsonl"), "x".repeat(100));
    mkdirSync(join(home, "cache", "agency"), { recursive: true });
    writeFileSync(join(home, "cache", "agency", "catalog.json"), "y".repeat(50));

    const before = await reportStorage(env, "linux");
    expect(before.dataBytes).toBeGreaterThanOrEqual(100);
    expect(before.cacheBytes).toBeGreaterThanOrEqual(50);

    pruneCache(env, "linux");
    const after = await reportStorage(env, "linux");
    expect(after.cacheBytes).toBe(0);
    expect(after.dataBytes).toBeGreaterThanOrEqual(100);
    expect(existsSync(cacheDir(env, "linux"))).toBe(true);
  });

  test("dataBytes excludes nested cache and logs subtrees instead of double-counting them", async () => {
    const { home } = fakeEnv();
    const env = { LOCALAPPDATA: join(home, "local") } as NodeJS.ProcessEnv;
    const data = dataDir(env, "win32");
    const cache = cacheDir(env, "win32");
    const logs = logDir(env, "win32");
    mkdirSync(cache, { recursive: true });
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(cache, "catalog.json"), "y".repeat(50));
    writeFileSync(join(logs, "daemon.jsonl"), "z".repeat(30));
    writeFileSync(join(data, "sessions.jsonl"), "x".repeat(100));

    const report = await reportStorage(env, "win32");
    expect(report.cacheBytes).toBeGreaterThanOrEqual(50);
    expect(report.logsBytes).toBeGreaterThanOrEqual(30);
    // dataBytes holds only the sessions file: the nested cache/logs bytes
    // belong to their own categories, not data's.
    expect(report.dataBytes).toBeGreaterThanOrEqual(100);
    expect(report.dataBytes).toBeLessThan(100 + 50 + 30);
  });
});

describe("pruneSessions", () => {
  test("deletes session files older than maxAgeDays", async () => {
    const { home } = fakeEnv();
    const env = { XDG_DATA_HOME: join(home, "data") } as NodeJS.ProcessEnv;
    const sessionsRoot = join(home, "data", "agency", "sessions", "ws1");
    mkdirSync(sessionsRoot, { recursive: true });
    const oldFile = join(sessionsRoot, "old.jsonl");
    writeFileSync(oldFile, "old");
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    utimesSync(oldFile, oldDate, oldDate);
    writeFileSync(join(sessionsRoot, "new.jsonl"), "new");

    const result = await pruneSessions({ maxAgeDays: 30 }, env, "linux");
    expect(result.deleted).toEqual([oldFile]);
    expect(existsSync(join(sessionsRoot, "new.jsonl"))).toBe(true);
  });

  test("evicts oldest-first once over the total byte ceiling", async () => {
    const { home } = fakeEnv();
    const env = { XDG_DATA_HOME: join(home, "data") } as NodeJS.ProcessEnv;
    const sessionsRoot = join(home, "data", "agency", "sessions", "ws1");
    mkdirSync(sessionsRoot, { recursive: true });
    const older = join(sessionsRoot, "a.jsonl");
    writeFileSync(older, "x".repeat(100));
    utimesSync(older, new Date(Date.now() - 2000), new Date(Date.now() - 2000));
    const newer = join(sessionsRoot, "b.jsonl");
    writeFileSync(newer, "x".repeat(100));

    const result = await pruneSessions({ maxTotalBytes: 150 }, env, "linux");
    expect(result.deleted).toEqual([older]);
    expect(existsSync(newer)).toBe(true);
  });

  test("applies both retention knobs: age filter first, then size cap on remainder", async () => {
    const { home } = fakeEnv();
    const env = { XDG_DATA_HOME: join(home, "data") } as NodeJS.ProcessEnv;
    const sessionsRoot = join(home, "data", "agency", "sessions", "ws1");
    mkdirSync(sessionsRoot, { recursive: true });

    const oldFile = join(sessionsRoot, "old.jsonl");
    writeFileSync(oldFile, "x".repeat(100));
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    utimesSync(oldFile, oldDate, oldDate);

    const recent = join(sessionsRoot, "recent.jsonl");
    writeFileSync(recent, "x".repeat(100));

    const result = await pruneSessions({ maxAgeDays: 30, maxTotalBytes: 50 }, env, "linux");
    expect(result.deleted).toEqual([oldFile, recent]);
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(recent)).toBe(false);
  });

  test("deterministic sort: same mtimeMs breaks ties by path", async () => {
    const { home } = fakeEnv();
    const env = { XDG_DATA_HOME: join(home, "data") } as NodeJS.ProcessEnv;
    const sessionsRoot = join(home, "data", "agency", "sessions", "ws1");
    mkdirSync(sessionsRoot, { recursive: true });

    const aFile = join(sessionsRoot, "a.jsonl");
    writeFileSync(aFile, "x".repeat(100));
    const bFile = join(sessionsRoot, "b.jsonl");
    writeFileSync(bFile, "x".repeat(100));
    const sameTime = new Date(Date.now() - 1000);
    utimesSync(aFile, sameTime, sameTime);
    utimesSync(bFile, sameTime, sameTime);

    const result = await pruneSessions({ maxTotalBytes: 150 }, env, "linux");
    expect(result.deleted).toEqual([aFile]);
    expect(existsSync(aFile)).toBe(false);
    expect(existsSync(bFile)).toBe(true);
  });

  test("removes sidecar shard files alongside the main session file", async () => {
    const { home } = fakeEnv();
    const env = { XDG_DATA_HOME: join(home, "data") } as NodeJS.ProcessEnv;
    const sessionsRoot = join(home, "data", "agency", "sessions", "ws1");
    mkdirSync(sessionsRoot, { recursive: true });

    const main = join(sessionsRoot, "s1.jsonl");
    writeFileSync(main, "x".repeat(100));
    const trace = join(sessionsRoot, "s1.trace.jsonl");
    writeFileSync(trace, "trace data");
    const cassette = join(sessionsRoot, "s1.turn1.cassette.json");
    writeFileSync(cassette, "{}");

    const other = join(sessionsRoot, "s2.jsonl");
    writeFileSync(other, "y".repeat(50));

    const result = await pruneSessions({ maxTotalBytes: 120 }, env, "linux");
    expect(result.deleted).toContain(main);
    expect(result.deleted).toContain(trace);
    expect(result.deleted).toContain(cassette);
    expect(existsSync(main)).toBe(false);
    expect(existsSync(trace)).toBe(false);
    expect(existsSync(cassette)).toBe(false);
    expect(existsSync(other)).toBe(true);
  });

  test("age-based prune deletes trace + cassette sidecars together with the session", async () => {
    const { home } = fakeEnv();
    const env = { XDG_DATA_HOME: join(home, "data") } as NodeJS.ProcessEnv;
    const sessionsRoot = join(home, "data", "agency", "sessions", "ws1");
    mkdirSync(sessionsRoot, { recursive: true });

    const main = join(sessionsRoot, "old.jsonl");
    writeFileSync(main, "old");
    const trace = join(sessionsRoot, "old.trace.jsonl");
    writeFileSync(trace, "trace data");
    const cassette = join(sessionsRoot, "old.turn1.cassette.json");
    writeFileSync(cassette, "{}");
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    utimesSync(main, oldDate, oldDate);
    writeFileSync(join(sessionsRoot, "new.jsonl"), "new");

    const result = await pruneSessions({ maxAgeDays: 30 }, env, "linux");
    expect(result.deleted).toContain(main);
    expect(result.deleted).toContain(trace);
    expect(result.deleted).toContain(cassette);
    expect(existsSync(main)).toBe(false);
    expect(existsSync(trace)).toBe(false);
    expect(existsSync(cassette)).toBe(false);
    expect(existsSync(join(sessionsRoot, "new.jsonl"))).toBe(true);
  });

  test("orphan *.trace.jsonl sidecars are excluded from prune candidates", async () => {
    const { home } = fakeEnv();
    const env = { XDG_DATA_HOME: join(home, "data") } as NodeJS.ProcessEnv;
    const sessionsRoot = join(home, "data", "agency", "sessions", "ws1");
    mkdirSync(sessionsRoot, { recursive: true });

    // No main session file: a lone trace sidecar must never be treated as a
    // prunable session itself (it is only ever removed together with its main
    // .jsonl via removeWithSidecars).
    const orphanTrace = join(sessionsRoot, "gone.trace.jsonl");
    writeFileSync(orphanTrace, "orphan trace");
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    utimesSync(orphanTrace, oldDate, oldDate);

    const result = await pruneSessions({ maxAgeDays: 30, maxTotalBytes: 1 }, env, "linux");
    expect(result.deleted).not.toContain(orphanTrace);
    expect(existsSync(orphanTrace)).toBe(true);
  });

  test("prunes across every per-workspace sessionsDir, not just one", async () => {
    const { home } = fakeEnv();
    const env = { XDG_DATA_HOME: join(home, "data") } as NodeJS.ProcessEnv;
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    const olds: string[] = [];
    for (const ws of ["ws1", "ws2"]) {
      const dir = join(home, "data", "agency", "sessions", ws);
      mkdirSync(dir, { recursive: true });
      const main = join(dir, "old.jsonl");
      writeFileSync(main, "old");
      utimesSync(main, oldDate, oldDate);
      olds.push(main);
    }

    const result = await pruneSessions({ maxAgeDays: 30 }, env, "linux");
    expect(result.deleted).toEqual(expect.arrayContaining(olds));
    for (const old of olds) expect(existsSync(old)).toBe(false);
  });
});

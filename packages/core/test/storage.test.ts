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
});

describe("pruneSessions", () => {
  test("deletes session files older than maxAgeDays", () => {
    const { home } = fakeEnv();
    const env = { XDG_DATA_HOME: join(home, "data") } as NodeJS.ProcessEnv;
    const sessionsRoot = join(home, "data", "agency", "sessions", "ws1");
    mkdirSync(sessionsRoot, { recursive: true });
    const oldFile = join(sessionsRoot, "old.jsonl");
    writeFileSync(oldFile, "old");
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    utimesSync(oldFile, oldDate, oldDate);
    writeFileSync(join(sessionsRoot, "new.jsonl"), "new");

    const result = pruneSessions({ maxAgeDays: 30 }, env, "linux");
    expect(result.deleted).toEqual([oldFile]);
    expect(existsSync(join(sessionsRoot, "new.jsonl"))).toBe(true);
  });

  test("evicts oldest-first once over the total byte ceiling", () => {
    const { home } = fakeEnv();
    const env = { XDG_DATA_HOME: join(home, "data") } as NodeJS.ProcessEnv;
    const sessionsRoot = join(home, "data", "agency", "sessions", "ws1");
    mkdirSync(sessionsRoot, { recursive: true });
    const older = join(sessionsRoot, "a.jsonl");
    writeFileSync(older, "x".repeat(100));
    utimesSync(older, new Date(Date.now() - 2000), new Date(Date.now() - 2000));
    const newer = join(sessionsRoot, "b.jsonl");
    writeFileSync(newer, "x".repeat(100));

    const result = pruneSessions({ maxTotalBytes: 150 }, env, "linux");
    expect(result.deleted).toEqual([older]);
    expect(existsSync(newer)).toBe(true);
  });
});

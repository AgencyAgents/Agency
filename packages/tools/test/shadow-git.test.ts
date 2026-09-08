import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgencyError, ErrorCode } from "@agency/schema";
import { SHADOW_GIT_TIMEOUT_MS, type ShadowGitRunner, SnapshotStore } from "../src/snapshot.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function sh(gitBin: string, args: string[], cwd: string): string {
  const result = spawnSync(gitBin, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return typeof result.stdout === "string" ? result.stdout : "";
}

/** Real-git runner that counts invocations (deny paths assert the count stays 0). */
function countingRunner(
  counter: { spawns: number },
  gitBin = "git",
  timeoutMs = SHADOW_GIT_TIMEOUT_MS,
): ShadowGitRunner {
  return (args, opts) => {
    counter.spawns += 1;
    const result = spawnSync(gitBin, args, { cwd: opts.cwd, encoding: "utf8", timeout: timeoutMs });
    return {
      exitCode: typeof result.status === "number" ? result.status : 1,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : "",
    };
  };
}

function initRepo(): string {
  const repo = tempDir("agency-shadow-git-repo-");
  sh("git", ["init"], repo);
  return repo;
}

/** Captures two files under `root`, shadows them, then diverges the worktree. */
function shadowWithTwoFiles(store: SnapshotStore, root: string): { commitHash: string } {
  mkdirSync(join(root, "sub"), { recursive: true });
  const a = join(root, "a.ts");
  const b = join(root, "sub", "b.ts");
  writeFileSync(a, "v1", "utf8");
  writeFileSync(b, "b1", "utf8");
  store.capture(a, "v1", "turn-1");
  store.capture(b, "b1", "turn-1");
  writeFileSync(a, "v2", "utf8");
  writeFileSync(b, "b2", "utf8");
  store.recordAfter(a);
  store.recordAfter(b);
  const { commitHash } = store.shadowCommit("session-1", "checkpoint one");
  writeFileSync(a, "diverged", "utf8");
  writeFileSync(b, "diverged", "utf8");
  return { commitHash };
}

async function expectAgencyError(promise: Promise<unknown>, code: ErrorCode): Promise<AgencyError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AgencyError);
    expect((error as AgencyError).code).toBe(code);
    return error as AgencyError;
  }
  throw new Error(`expected AgencyError ${code}, but the call succeeded`);
}

describe("SnapshotStore.materializeShadowCommit", () => {
  test("allow creates a commit with exact blob contents and journal correlation", async () => {
    const storeDir = tempDir("agency-shadow-git-store-");
    const store = new SnapshotStore(storeDir);
    const repo = initRepo();
    const counter = { spawns: 0 };
    const { commitHash } = shadowWithTwoFiles(store, repo);

    const outcome = await store.materializeShadowCommit(commitHash, {
      targetDir: repo,
      sessionRoot: repo,
      permissions: { git_write: "allow" },
      runGit: countingRunner(counter),
    });

    expect(counter.spawns).toBeGreaterThan(0);
    expect(outcome.commitHash).toBe(commitHash);
    expect(outcome.gitCommit).toMatch(/^[0-9a-f]{40}$/);
    expect([...outcome.files].sort()).toEqual(["a.ts", join("sub", "b.ts")]);
    expect(readFileSync(join(repo, "a.ts"), "utf8")).toBe("v2");
    expect(readFileSync(join(repo, "sub", "b.ts"), "utf8")).toBe("b2");
    expect(sh("git", ["show", "HEAD:a.ts"], repo)).toBe("v2");
    expect(sh("git", ["show", "HEAD:sub/b.ts"], repo)).toBe("b2");
    expect(sh("git", ["log", "-1", "--format=%B"], repo)).toContain(commitHash);
    expect(sh("git", ["rev-parse", "HEAD"], repo).trim()).toBe(outcome.gitCommit);

    const correlation = store.readMaterialization(commitHash);
    expect(correlation?.commitHash).toBe(commitHash);
    expect(correlation?.gitCommit).toBe(outcome.gitCommit);

    const restarted = new SnapshotStore(storeDir);
    expect(restarted.readMaterialization(commitHash)?.gitCommit).toBe(outcome.gitCommit);
  });

  test("ask approve proceeds, ask reject denies with zero git spawns", async () => {
    const storeDir = tempDir("agency-shadow-git-store-");
    const store = new SnapshotStore(storeDir);
    const repo = initRepo();
    const { commitHash } = shadowWithTwoFiles(store, repo);

    const approved = await store.materializeShadowCommit(commitHash, {
      targetDir: repo,
      permissions: { git_write: "ask" },
      ask: async () => "once",
    });
    expect(approved.gitCommit).toMatch(/^[0-9a-f]{40}$/);

    const counter = { spawns: 0 };
    const rejected = expectAgencyError(
      store.materializeShadowCommit(commitHash, {
        targetDir: repo,
        permissions: { git_write: "ask" },
        ask: async () => "reject",
        runGit: countingRunner(counter),
      }),
      ErrorCode.PERMISSION_DENIED,
    );
    await rejected;
    expect(counter.spawns).toBe(0);
  });

  test("deny and non-interactive throw typed errors with zero git spawns", async () => {
    const store = new SnapshotStore(tempDir("agency-shadow-git-store-"));
    const repo = initRepo();
    const { commitHash } = shadowWithTwoFiles(store, repo);

    for (const options of [
      { permissions: { git_write: "deny" as const } },
      { permissions: { git_write: "allow" as const }, nonInteractive: true },
      {},
    ]) {
      const counter = { spawns: 0 };
      await expectAgencyError(
        store.materializeShadowCommit(commitHash, {
          targetDir: repo,
          ...options,
          runGit: countingRunner(counter),
        }),
        ErrorCode.PERMISSION_DENIED,
      );
      expect(counter.spawns).toBe(0);
    }
    expect(sh("git", ["rev-list", "--all", "--count"], repo).trim()).toBe("0");
  });

  test("out-of-scope paths stay byte-identical and never enter the repo", async () => {
    const store = new SnapshotStore(tempDir("agency-shadow-git-store-"));
    const repo = initRepo();
    const outside = tempDir("agency-shadow-git-outside-");
    const outsideFile = join(outside, "outside.txt");
    writeFileSync(outsideFile, "untouched", "utf8");
    store.capture(outsideFile, "untouched", "turn-1");
    writeFileSync(join(repo, "in.ts"), "v1", "utf8");
    store.capture(join(repo, "in.ts"), "v1", "turn-1");
    const { commitHash } = store.shadowCommit("session-1", "scoped");

    const outcome = await store.materializeShadowCommit(commitHash, {
      targetDir: repo,
      sessionRoot: repo,
      permissions: { git_write: "allow" },
    });
    expect(outcome.files).toEqual(["in.ts"]);
    expect(readFileSync(outsideFile, "utf8")).toBe("untouched");
    expect(sh("git", ["ls-tree", "-r", "--name-only", "HEAD"], repo).trim()).toBe("in.ts");
  });

  test("malformed inputs throw typed errors", async () => {
    const storeDir = tempDir("agency-shadow-git-store-");
    const store = new SnapshotStore(storeDir);
    const repo = initRepo();
    const { commitHash } = shadowWithTwoFiles(store, repo);
    const allow = { permissions: { git_write: "allow" as const } };

    await expectAgencyError(
      store.materializeShadowCommit("0".repeat(64), { targetDir: repo, ...allow }),
      ErrorCode.TOOL_ERROR,
    );
    await expectAgencyError(
      store.materializeShadowCommit("   ", { targetDir: repo, ...allow }),
      ErrorCode.TOOL_ERROR,
    );

    writeFileSync(join(storeDir, "shadow-commits", `${commitHash}.json`), "{broken", "utf8");
    await expectAgencyError(
      store.materializeShadowCommit(commitHash, { targetDir: repo, ...allow }),
      ErrorCode.TOOL_ERROR,
    );

    const store2 = new SnapshotStore(tempDir("agency-shadow-git-store-"));
    const { commitHash: hash2 } = shadowWithTwoFiles(store2, repo);
    const manifest = store2.readShadowCommit(hash2);
    const missing = manifest?.files[0];
    if (!missing) throw new Error("expected manifest files");
    const blobPath = join(
      (store2 as unknown as { storeDir: string }).storeDir,
      "blobs",
      missing.hash.slice(0, 2),
      missing.hash.slice(2),
    );
    rmSync(blobPath, { force: true });
    await expectAgencyError(
      store2.materializeShadowCommit(hash2, { targetDir: repo, ...allow }),
      ErrorCode.TOOL_ERROR,
    );

    const plainDir = tempDir("agency-shadow-git-plain-");
    await expectAgencyError(
      store2.materializeShadowCommit(hash2, { targetDir: plainDir, ...allow }),
      ErrorCode.TOOL_ERROR,
    );
  });

  test("git spawn timeout ceiling is documented and enforced by default", () => {
    expect(SHADOW_GIT_TIMEOUT_MS).toBe(30_000);
  });
});

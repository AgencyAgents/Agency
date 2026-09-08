import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storagePaths } from "@agency/core";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, StreamEvent } from "@agency/providers";
import { SnapshotStore } from "@agency/tools";
import { type AgentDaemon, createAgentDaemon } from "../src/daemon.ts";

const noopHttp: HttpClient = { fetch: async () => new Response() };
const daemons: AgentDaemon[] = [];
const dirs: string[] = [];

const prevKey = process.env.AGENCY_ANTHROPIC_API_KEY;
process.env.AGENCY_ANTHROPIC_API_KEY = "test-key-restore";
const prevOffline = process.env.AGENCY_DISABLE_MODELS_FETCH;
process.env.AGENCY_DISABLE_MODELS_FETCH = "1";
const prevLocalAppData = process.env.LOCALAPPDATA;
const prevXdg = process.env.XDG_DATA_HOME;
afterAll(() => {
  if (prevKey === undefined) delete process.env.AGENCY_ANTHROPIC_API_KEY;
  else process.env.AGENCY_ANTHROPIC_API_KEY = prevKey;
  if (prevOffline === undefined) delete process.env.AGENCY_DISABLE_MODELS_FETCH;
  else process.env.AGENCY_DISABLE_MODELS_FETCH = prevOffline;
  if (prevLocalAppData === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = prevLocalAppData;
  if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = prevXdg;
});

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function echoAdapter(): ProviderAdapter {
  return {
    family: "fake",
    async *stream(): AsyncIterable<StreamEvent> {
      yield { type: "text_delta", text: "ok" };
      yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 5 } };
    },
  };
}

async function startDaemon() {
  const workspaceRoot = tempDir("agency-restore-ws-");
  process.env.LOCALAPPDATA = tempDir("agency-restore-data-");
  process.env.XDG_DATA_HOME = tempDir("agency-restore-xdg-");
  const daemon = await createAgentDaemon({
    workspaceRoot,
    instanceFile: join(workspaceRoot, ".agency", "instance.json"),
    sessionsDir: tempDir("agency-restore-sess-"),
    approvalsDir: tempDir("agency-restore-appr-"),
    adapterFor: () => echoAdapter(),
    http: noopHttp,
    tools: [],
  });
  daemons.push(daemon);
  return { daemon, workspaceRoot, base: `http://127.0.0.1:${daemon.httpPort}`, token: daemon.server.token as string };
}

async function rpcCall(
  base: string,
  token: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<{ status: number; body: { result?: unknown; error?: { message: string } } }> {
  const res = await fetch(`${base}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ id: `req-${method}`, method, params }),
  });
  return {
    status: res.status,
    body: (await res.json()) as { result?: unknown; error?: { message: string } },
  };
}

async function rpcOk(base: string, token: string, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const { status, body } = await rpcCall(base, token, method, params);
  if (status !== 200 || body.error !== undefined || body.result === undefined) {
    throw new Error(`rpc ${method} failed (${status}): ${JSON.stringify(body)}`);
  }
  return body.result;
}

async function send(base: string, token: string, sessionId: string, userText: string): Promise<void> {
  await rpcOk(base, token, "session_send", {
    sessionId,
    provider: "anthropic",
    model: "test-model",
    systemPrompt: "sys",
    userText,
  });
}

async function tipOf(base: string, token: string, sessionId: string): Promise<string | null> {
  const listed = (await rpcOk(base, token, "session_list")) as {
    sessions: { id: string; tipId: string | null }[];
  };
  return listed.sessions.find((s) => s.id === sessionId)?.tipId ?? null;
}

async function entryCount(base: string, token: string, sessionId: string): Promise<number> {
  const shown = (await rpcOk(base, token, "session_show", { sessionId })) as { entries: unknown[] };
  return shown.entries.length;
}

function seedShadowCommit(workspaceRoot: string, sessionId: string, files: Record<string, string>): string {
  const snapshotsDir = storagePaths(workspaceRoot).snapshotsDir;
  const store = new SnapshotStore(snapshotsDir, {
    journalFile: join(snapshotsDir, "journals", `${sessionId}.journal.jsonl`),
  });
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(workspaceRoot, rel);
    writeFileSync(abs, content, "utf8");
    store.capture(abs, content);
  }
  return store.shadowCommit(sessionId, `checkpoint ${sessionId}`).commitHash;
}

function snapshotsDirOf(workspaceRoot: string): string {
  return storagePaths(workspaceRoot).snapshotsDir;
}

describe("undo_run restore modes", () => {
  test("files-only restores blob contents and keeps the session tip", async () => {
    const { workspaceRoot, base, token } = await startDaemon();
    const sessionId = "files-only";
    await send(base, token, sessionId, "first");
    await send(base, token, sessionId, "second");
    const commitHash = seedShadowCommit(workspaceRoot, sessionId, { "note.txt": "original\n" });
    writeFileSync(join(workspaceRoot, "note.txt"), "dirty\n", "utf8");
    const tipBefore = await tipOf(base, token, sessionId);
    const entriesBefore = await entryCount(base, token, sessionId);

    const result = (await rpcOk(base, token, "undo_run", {
      sessionId,
      mode: "files-only",
      commitHash,
    })) as { undone: boolean; mode: string; restored: number; tipId: string };
    expect(result.undone).toBe(true);
    expect(result.mode).toBe("files-only");
    expect(result.restored).toBe(1);
    expect(readFileSync(join(workspaceRoot, "note.txt"), "utf8")).toBe("original\n");
    expect(await tipOf(base, token, sessionId)).toBe(tipBefore);
    expect(result.tipId).toBe(tipBefore);
    expect(await entryCount(base, token, sessionId)).toBe(entriesBefore);
    console.log(`restore-modes files-only: restored=${result.restored} tip-kept=${result.tipId === tipBefore}`);
  }, 30_000);

  test("task-only rolls the session back without touching files", async () => {
    const { workspaceRoot, base, token } = await startDaemon();
    const sessionId = "task-only";
    await send(base, token, sessionId, "first");
    await send(base, token, sessionId, "second");
    const commitHash = seedShadowCommit(workspaceRoot, sessionId, { "note.txt": "original\n" });
    writeFileSync(join(workspaceRoot, "note.txt"), "dirty\n", "utf8");
    const tipBefore = await tipOf(base, token, sessionId);
    const entriesBefore = await entryCount(base, token, sessionId);

    const result = (await rpcOk(base, token, "undo_run", { sessionId, mode: "task-only" })) as {
      undone: boolean;
      tipId: string;
    };
    expect(result.undone).toBe(true);
    expect(result.tipId).not.toBe(tipBefore);
    expect(await tipOf(base, token, sessionId)).toBe(result.tipId);
    expect(await entryCount(base, token, sessionId)).toBeLessThan(entriesBefore);
    expect(readFileSync(join(workspaceRoot, "note.txt"), "utf8")).toBe("dirty\n");
    expect(commitHash.length).toBe(64);
    console.log(`restore-modes task-only: tip ${String(tipBefore).slice(0, 8)} -> ${String(result.tipId).slice(0, 8)} file-untouched=true`);
  }, 30_000);

  test("both restores files and rolls the tip back", async () => {
    const { workspaceRoot, base, token } = await startDaemon();
    const sessionId = "both";
    await send(base, token, sessionId, "first");
    await send(base, token, sessionId, "second");
    const commitHash = seedShadowCommit(workspaceRoot, sessionId, { "note.txt": "original\n" });
    writeFileSync(join(workspaceRoot, "note.txt"), "dirty\n", "utf8");
    const tipBefore = await tipOf(base, token, sessionId);
    const entriesBefore = await entryCount(base, token, sessionId);

    const result = (await rpcOk(base, token, "undo_run", {
      sessionId,
      mode: "both",
      commitHash,
    })) as { undone: boolean; mode: string; restored: number; tipId: string };
    expect(result.undone).toBe(true);
    expect(result.mode).toBe("both");
    expect(result.restored).toBe(1);
    expect(readFileSync(join(workspaceRoot, "note.txt"), "utf8")).toBe("original\n");
    expect(result.tipId).not.toBe(tipBefore);
    expect(await tipOf(base, token, sessionId)).toBe(result.tipId);
    expect(await entryCount(base, token, sessionId)).toBeLessThan(entriesBefore);
    console.log(`restore-modes both: restored=${result.restored} tip-rolled-back=true`);
  }, 30_000);

  test("missing blob errors typed with session intact and zero file writes", async () => {
    const { workspaceRoot, base, token } = await startDaemon();
    const sessionId = "missing-blob";
    await send(base, token, sessionId, "first");
    const commitHash = seedShadowCommit(workspaceRoot, sessionId, {
      "a.txt": "alpha\n",
      "b.txt": "beta\n",
    });
    const snapshotsDir = snapshotsDirOf(workspaceRoot);
    const seeder = new SnapshotStore(snapshotsDir, {
      journalFile: join(snapshotsDir, "journals", `${sessionId}.journal.jsonl`),
    });
    const manifest = seeder.readShadowCommit(commitHash);
    const victim = manifest?.files.find((f) => f.path.endsWith("b.txt"));
    expect(victim).toBeDefined();
    rmSync(join(snapshotsDir, "blobs", victim!.hash.slice(0, 2), victim!.hash.slice(2)), { force: true });
    writeFileSync(join(workspaceRoot, "a.txt"), "dirty-a\n", "utf8");
    writeFileSync(join(workspaceRoot, "b.txt"), "dirty-b\n", "utf8");
    const tipBefore = await tipOf(base, token, sessionId);
    const entriesBefore = await entryCount(base, token, sessionId);

    const failed = await rpcCall(base, token, "undo_run", { sessionId, mode: "files-only", commitHash });
    expect(failed.status).toBe(500);
    expect(failed.body.error?.message ?? "").toContain("snapshot blob missing");
    expect(await tipOf(base, token, sessionId)).toBe(tipBefore);
    expect(await entryCount(base, token, sessionId)).toBe(entriesBefore);
    expect(readFileSync(join(workspaceRoot, "a.txt"), "utf8")).toBe("dirty-a\n");
    expect(readFileSync(join(workspaceRoot, "b.txt"), "utf8")).toBe("dirty-b\n");
    console.log("restore-modes missing-blob: typed-error session-intact zero-writes=true");
  }, 30_000);

  test("missing manifest and malformed inputs error typed with zero mutation", async () => {
    const { workspaceRoot, base, token } = await startDaemon();
    const sessionId = "malformed";
    await send(base, token, sessionId, "first");
    writeFileSync(join(workspaceRoot, "note.txt"), "dirty\n", "utf8");
    const tipBefore = await tipOf(base, token, sessionId);
    const entriesBefore = await entryCount(base, token, sessionId);

    const unknownManifest = await rpcCall(base, token, "undo_run", {
      sessionId,
      mode: "files-only",
      commitHash: "0".repeat(64),
    });
    expect(unknownManifest.status).toBe(500);
    expect(unknownManifest.body.error?.message ?? "").toContain("unknown shadow commit");

    const unknownMode = await rpcCall(base, token, "undo_run", { sessionId, mode: "time-travel" });
    expect(unknownMode.status).toBe(500);
    expect(unknownMode.body.error?.message ?? "").toContain("unknown mode");

    const missingHash = await rpcCall(base, token, "undo_run", { sessionId, mode: "both" });
    expect(missingHash.status).toBe(500);
    expect(missingHash.body.error?.message ?? "").toContain("requires commitHash");

    const unknownTip = await rpcCall(base, token, "undo_run", {
      sessionId,
      mode: "task-only",
      tipId: "tip-does-not-exist",
    });
    expect(unknownTip.status).toBe(500);
    expect(unknownTip.body.error?.message ?? "").toContain("unknown tip");

    expect(await tipOf(base, token, sessionId)).toBe(tipBefore);
    expect(await entryCount(base, token, sessionId)).toBe(entriesBefore);
    expect(readFileSync(join(workspaceRoot, "note.txt"), "utf8")).toBe("dirty\n");
    console.log("restore-modes malformed: unknown-manifest/mode/hash/tip all typed zero-mutation=true");
  }, 30_000);

  test("both with an unknown tip reports the partial state: files restored, tip kept", async () => {
    const { workspaceRoot, base, token } = await startDaemon();
    const sessionId = "partial";
    await send(base, token, sessionId, "first");
    const commitHash = seedShadowCommit(workspaceRoot, sessionId, { "note.txt": "original\n" });
    writeFileSync(join(workspaceRoot, "note.txt"), "dirty\n", "utf8");
    const tipBefore = await tipOf(base, token, sessionId);
    const entriesBefore = await entryCount(base, token, sessionId);

    const failed = await rpcCall(base, token, "undo_run", {
      sessionId,
      mode: "both",
      commitHash,
      tipId: "tip-does-not-exist",
    });
    expect(failed.status).toBe(500);
    expect(failed.body.error?.message ?? "").toContain("partial restore");
    expect(readFileSync(join(workspaceRoot, "note.txt"), "utf8")).toBe("original\n");
    expect(await tipOf(base, token, sessionId)).toBe(tipBefore);
    expect(await entryCount(base, token, sessionId)).toBe(entriesBefore);
    console.log("restore-modes partial: files-restored tip-kept partial-reported=true");
  }, 30_000);
});

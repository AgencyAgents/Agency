import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSessionTitle, SessionStore } from "@agency/core";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, StreamEvent } from "@agency/providers";
import { connectToDaemon, type DaemonClient } from "@agency/rpc";
import { type AgentDaemon, createAgentDaemon, type RunTurnRpcResult } from "../src/daemon.ts";
import { type EntrypointDeps, runEntrypoint } from "../src/entrypoint.ts";
import { runSessionTurn } from "../src/session-runner.ts";

const dirs: string[] = [];
const daemons: AgentDaemon[] = [];
const clients: DaemonClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const daemon of daemons.splice(0)) await daemon.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function writeConfigDir(config: Record<string, unknown>): string {
  const dir = tempDir("agency-phase7-config-");
  writeFileSync(join(dir, "config.jsonc"), JSON.stringify({ schemaVersion: 2, ...config }));
  return dir;
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const deps: EntrypointDeps = {
    out: (line: string) => {
      out.push(line);
    },
    err: (line: string) => {
      err.push(line);
    },
  };
  return { out, err, deps };
}

function textAdapter(text: string): ProviderAdapter {
  return {
    family: "fake",
    async *stream(): AsyncIterable<StreamEvent> {
      yield { type: "text_delta", text };
      yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 3, outputTokens: 2 } };
    },
  };
}

describe("phase 7: session list title search", () => {
  async function seedSessions(sessionsDir: string): Promise<void> {
    const store = new SessionStore(sessionsDir);
    store.create("garden-session");
    const g = await store.append("garden-session", {
      type: "message",
      parentId: null,
      message: { role: "user", content: [{ type: "text", text: "plan my garden" }] },
    });
    await store.append("garden-session", {
      type: "session_title",
      parentId: g.id,
      title: "Garden Renovation Plan",
    });
    store.create("other-session");
    await store.append("other-session", {
      type: "message",
      parentId: null,
      message: { role: "user", content: [{ type: "text", text: "fix the build" }] },
    });
  }

  test("session list <query> filters by title, case-insensitively", async () => {
    const sessionsDir = tempDir("agency-phase7-search-");
    await seedSessions(sessionsDir);
    const c = capture();
    expect(await runEntrypoint(["session", "list", "garden"], { sessionsDir, ...c.deps })).toBe(0);
    const lines = c.out.join("\n");
    expect(lines).toContain("garden-session");
    expect(lines).toContain("Garden Renovation Plan");
    expect(lines).not.toContain("other-session");
  });

  test("session list <query> falls back to matching session id when no title exists", async () => {
    const sessionsDir = tempDir("agency-phase7-search-id-");
    await seedSessions(sessionsDir);
    const c = capture();
    expect(await runEntrypoint(["session", "list", "other-sess"], { sessionsDir, ...c.deps })).toBe(0);
    const lines = c.out.join("\n");
    expect(lines).toContain("other-session");
    expect(lines).not.toContain("garden-session");
  });

  test("session list with no query still shows every session with title or id fallback", async () => {
    const sessionsDir = tempDir("agency-phase7-search-all-");
    await seedSessions(sessionsDir);
    const c = capture();
    expect(await runEntrypoint(["session", "list"], { sessionsDir, ...c.deps })).toBe(0);
    const lines = c.out.join("\n");
    expect(lines).toContain("Garden Renovation Plan");
    expect(lines).toContain("other-session");
  });
});

describe("phase 7: first-turn title generation end to end", () => {
  test("completing a first real turn appends a session_title entry via the resolved small-model key", async () => {
    const sessionsDir = tempDir("agency-phase7-title-");
    const approvalsDir = tempDir("agency-phase7-approvals-");
    const requestedProviders: string[] = [];
    const noopHttp: HttpClient = { fetch: async () => new Response() };
    const daemon = await createAgentDaemon({
      workspaceRoot: tempDir("agency-phase7-root-"),
      instanceFile: join(tempDir("agency-phase7-instance-"), "instance.json"),
      sessionsDir,
      approvalsDir,
      configDir: writeConfigDir({
        small_model: "tiny/tiny-model",
        provider: { tiny: { apiKey: "tiny-test-key" } },
      }),
      http: noopHttp,
      adapterFor: (provider: string) => {
        requestedProviders.push(provider);
        if (provider === "tiny") return textAdapter("Garden Renovation Plan");
        return textAdapter("turn reply");
      },
    });
    daemons.push(daemon);
    const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
    clients.push(client);

    const result = (await client.call("run_turn", {
      turnId: "phase7-t1",
      sessionId: "phase7-session",
      provider: "main",
      model: "m",
      apiKey: "main-key",
      systemPrompt: "sys",
      session: [{ role: "user", content: [{ type: "text", text: "Plan my garden renovation" }] }],
    })) as RunTurnRpcResult;
    expect(result.stopReason).toBe("end_turn");

    // Title generation is fire-and-forget after turn completion: poll for it.
    let title: string | undefined;
    for (let i = 0; i < 200 && title === undefined; i++) {
      title = getSessionTitle(new SessionStore(sessionsDir).load("phase7-session"));
      if (title === undefined) await new Promise((r) => setTimeout(r, 50));
    }
    expect(title).toBe("Garden Renovation Plan");
    // The title call went through the small model's resolved provider, not the turn's.
    expect(requestedProviders).toContain("tiny");

    // A second turn must not duplicate the title entry.
    const before = new SessionStore(sessionsDir)
      .load("phase7-session")
      .filter((e) => e.type === "session_title").length;
    await client.call("run_turn", {
      turnId: "phase7-t2",
      sessionId: "phase7-session",
      provider: "main",
      model: "m",
      apiKey: "main-key",
      systemPrompt: "sys",
      session: [{ role: "user", content: [{ type: "text", text: "Plan my garden renovation" }] }],
    });
    await new Promise((r) => setTimeout(r, 500));
    const after = new SessionStore(sessionsDir)
      .load("phase7-session")
      .filter((e) => e.type === "session_title").length;
    expect(after).toBe(before);

    // The generated title is visible in the session list, not just the id.
    const c = capture();
    expect(await runEntrypoint(["session", "list"], { sessionsDir, ...c.deps })).toBe(0);
    expect(c.out.join("\n")).toContain("Garden Renovation Plan");
  });

  test("runSessionTurn forwards sessionId so the title lands in the caller's session file", async () => {
    const sessionsDir = tempDir("agency-phase7-runner-");
    const previousMainKey = process.env.AGENCY_MAIN_API_KEY;
    process.env.AGENCY_MAIN_API_KEY = "main-runner-key";
    try {
      const requestedProviders: string[] = [];
      const noopHttp: HttpClient = { fetch: async () => new Response() };
      const daemon = await createAgentDaemon({
        workspaceRoot: tempDir("agency-phase7-runner-root-"),
        instanceFile: join(tempDir("agency-phase7-runner-instance-"), "instance.json"),
        sessionsDir,
        approvalsDir: tempDir("agency-phase7-runner-approvals-"),
        configDir: writeConfigDir({
          small_model: "tiny/tiny-model",
          provider: { tiny: { apiKey: "tiny-test-key" } },
        }),
        http: noopHttp,
        adapterFor: (provider: string) => {
          requestedProviders.push(provider);
          if (provider === "tiny") return textAdapter("Harbor Cleanup Sprint");
          return textAdapter("turn reply");
        },
      });
      daemons.push(daemon);
      const client = await connectToDaemon(daemon.server.port, "127.0.0.1", { token: daemon.server.token });
      clients.push(client);

      const { result } = await runSessionTurn(client, {
        sessionId: "runner-session",
        provider: "main",
        model: "m",
        systemPrompt: "sys",
        userText: "Clean up the harbor district",
      });
      expect(result.stopReason).toBe("end_turn");

      let title: string | undefined;
      for (let i = 0; i < 200 && title === undefined; i++) {
        title = getSessionTitle(new SessionStore(sessionsDir).load("runner-session"));
        if (title === undefined) await new Promise((r) => setTimeout(r, 50));
      }
      expect(title).toBe("Harbor Cleanup Sprint");
      expect(requestedProviders).toContain("tiny");

      const c = capture();
      expect(await runEntrypoint(["session", "list", "harbor"], { sessionsDir, ...c.deps })).toBe(0);
      expect(c.out.join("\n")).toContain("runner-session");
    } finally {
      if (previousMainKey === undefined) delete process.env.AGENCY_MAIN_API_KEY;
      else process.env.AGENCY_MAIN_API_KEY = previousMainKey;
    }
  });
});

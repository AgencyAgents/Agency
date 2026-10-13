import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileFallbackBackend } from "@agency/providers";
import type { RunTurnRpcResult } from "../src/daemon.ts";
import { type EntrypointDeps, runEntrypoint } from "../src/entrypoint.ts";
import type { RunHeadlessOptions } from "../src/headless.ts";
import { runParallel } from "../src/workflow.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agency-workflow-"));
  dirs.push(dir);
  return dir;
}

/** A fake of the headless turn: the answer is the prompt in capitals, after an optional wait in ms that the prompt names. */
function setup(script: string) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: RunHeadlessOptions[] = [];
  let running = 0;
  let most = 0;
  const file = join(tempDir(), "flow.mjs");
  writeFileSync(file, script);
  const deps: EntrypointDeps = {
    out: (line) => {
      out.push(line);
    },
    err: (line) => {
      err.push(line);
    },
    env: { AGENCY_OPENAI_API_KEY: "sk-test" },
    configDir: tempDir(),
    keychain: createFileFallbackBackend(tempDir()),
    cwd: tempDir(),
    runHeadless: async (options): Promise<RunTurnRpcResult> => {
      calls.push(options);
      running += 1;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, Number(/wait (\d+)/.exec(options.prompt)?.[1] ?? 0)));
      running -= 1;
      const failed = options.prompt.includes("fail");
      return {
        messages: [
          { role: "user", content: [{ type: "text", text: options.prompt }] },
          { role: "assistant", content: [{ type: "text", text: options.prompt.toUpperCase() }] },
        ],
        stopReason: failed ? "error" : "end_turn",
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
        budgetExceeded: false,
        cancelled: false,
      };
    },
  };
  return { out, err, calls, deps, file, most: () => most };
}

describe("agency workflow run", () => {
  test("the script gets its arguments, runs agents in order, and its result is the output", async () => {
    const s = setup(`
      export default async ({ agent, args, log }) => {
        const plan = await agent("plan " + args.topic);
        log("plan done");
        const review = await agent("review " + plan.text, { model: "openai/other-model", maxSteps: 7, permissionMode: "allow-all" });
        return { plan: plan.text, review: review.text, ok: plan.ok && review.ok, tokens: plan.usage.inputTokens };
      };
    `);
    const code = await runEntrypoint(
      ["workflow", "run", s.file, "--arg", "topic=caching", "--model", "openai/fake-1", "--max-steps", "40"],
      s.deps,
    );
    expect(code).toBe(0);
    expect(JSON.parse(s.out.join("\n"))).toEqual({
      plan: "PLAN CACHING",
      review: "REVIEW PLAN CACHING",
      ok: true,
      tokens: 10,
    });
    expect(s.calls.map((c) => [c.model, c.maxToolIterations, c.permissionMode])).toEqual([
      ["fake-1", 40, "ask"],
      ["other-model", 7, "allow-all"],
    ]);
    expect(s.err.join("\n")).toContain("plan done");
  });

  test("parallel runs its tasks at the same time, with a limit, and keeps their order", async () => {
    const s = setup(`
      export default async ({ agent, parallel }) => {
        const results = await parallel(
          ["wait 60 a", "wait 10 b", "wait 30 c"].map((prompt) => () => agent(prompt)),
          2,
        );
        return results.map((r) => r.text).join("|");
      };
    `);
    const code = await runEntrypoint(["workflow", "run", s.file, "--model", "openai/fake-1"], s.deps);
    expect(code).toBe(0);
    expect(s.out).toEqual(["WAIT 60 A|WAIT 10 B|WAIT 30 C"]);
    expect(s.most()).toBe(2);
  });

  test("a turn that failed has ok false, and an error of the script is exit code 1", async () => {
    const s = setup(`
      export default async ({ agent }) => {
        const result = await agent("fail now");
        if (!result.ok) throw new Error("the step failed: " + result.stopReason);
        return "not reached";
      };
    `);
    const code = await runEntrypoint(["workflow", "run", s.file, "--model", "openai/fake-1"], s.deps);
    expect(code).toBe(1);
    expect(s.out).toEqual([]);
    expect(s.err.join("\n")).toContain("the step failed: error");
  });

  test("a file with no default function, a missing file name and a wrong argument are errors", async () => {
    const s = setup("export const x = 1;");
    expect(await runEntrypoint(["workflow", "run", s.file, "--model", "openai/fake-1"], s.deps)).toBe(1);
    expect(await runEntrypoint(["workflow", "run"], s.deps)).toBe(1);
    expect(await runEntrypoint(["workflow", "run", s.file, "--arg", "novalue"], s.deps)).toBe(1);
    expect(s.calls).toEqual([]);
  });
});

describe("runParallel", () => {
  test("an empty list gives an empty list, and a failed task fails the call", async () => {
    expect(await runParallel([])).toEqual([]);
    await expect(
      runParallel([
        async () => 1,
        async () => {
          throw new Error("task failed");
        },
      ]),
    ).rejects.toThrow("task failed");
  });
});

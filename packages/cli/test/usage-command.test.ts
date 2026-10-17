import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataDir } from "@agency/core";
import { runEntrypoint } from "../src/entrypoint.ts";

test("agency usage sums the model calls of the traces of all workspaces, by day, month or model", async () => {
  const home = mkdtempSync(join(tmpdir(), "agency-usage-"));
  try {
    const env = { ...process.env, AGENCY_HOME: home };
    const span = (kind: string, startTime: string, model: string, tokens: number, cost: number) =>
      JSON.stringify({
        kind,
        startTime,
        attributes: {
          provider: "openrouter",
          model,
          inputTokens: tokens,
          cachedInputTokens: 10,
          outputTokens: 5,
          cost,
        },
      });
    const write = (path: string, lines: string[]) => {
      mkdirSync(join(dataDir(env), "sessions", path, ".."), { recursive: true });
      writeFileSync(join(dataDir(env), "sessions", path), `${lines.join("\n")}\nnot json\n`);
    };
    // A turn span repeats the sums of its model spans: it does not count.
    write("ws1/a.trace.jsonl", [
      span("turn", "2026-10-14T12:00:00Z", "flash", 999, 9),
      span("model", "2026-10-14T12:00:00Z", "flash", 100, 0.5),
      span("model", "2026-10-15T12:00:00Z", "pro", 200, 1),
    ]);
    write("ws2/b.trace.jsonl", [span("model", "2026-10-15T13:00:00Z", "flash", 300, 0.25)]);

    const run = async (args: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runEntrypoint(["usage", ...args], {
        env,
        out: (line: string) => out.push(line),
        err: (line: string) => err.push(line),
      });
      return { code, text: out.join("\n"), err: err.join("\n") };
    };
    const byDay = JSON.parse((await run(["--json"])).text);
    expect(
      byDay.rows.map((row: { key: string; calls: number; cost: number }) => [row.key, row.calls, row.cost]),
    ).toEqual([
      ["2026-10-14", 1, 0.5],
      ["2026-10-15", 2, 1.25],
    ]);
    expect(byDay.total).toMatchObject({
      calls: 3,
      inputTokens: 600,
      cachedInputTokens: 30,
      outputTokens: 15,
      cost: 1.75,
    });
    const byModel = JSON.parse((await run(["--by", "model", "--since", "2026-10-15", "--json"])).text);
    expect(byModel.rows.map((row: { key: string }) => row.key)).toEqual([
      "openrouter/pro",
      "openrouter/flash",
    ]);
    const table = await run(["--by", "month"]);
    expect(table.code).toBe(0);
    expect(table.text).toContain("2026-10");
    expect(table.text).toMatch(/total\s+3\s+600\s+30\s+15\s+\$1\.7500/);
    const wrong = await run(["--by", "week"]);
    expect(wrong.code).not.toBe(0);
    expect(wrong.err).toContain("--by takes day, month or model");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

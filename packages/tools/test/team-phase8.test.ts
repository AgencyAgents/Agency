import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendReviewFindings, listDiffComments } from "../src/diff-review.ts";
import {
  classifyTeamServer,
  splitTeamServers,
  TEAM_MCP_PROCESS_CAP,
  TeamMcpPool,
} from "../src/mcp/team-policy.ts";

describe("phase 8 team-scoped MCP policy", () => {
  it("shares read-only or stateless servers, isolates the rest", () => {
    expect(classifyTeamServer({ readOnly: true })).toBe("shared");
    expect(classifyTeamServer({ stateless: true })).toBe("shared");
    expect(classifyTeamServer({})).toBe("dedicated");
    expect(classifyTeamServer({ command: "x" })).toBe("dedicated");
    const split = splitTeamServers({
      docs: { url: "https://docs.example.com/mcp", readOnly: true },
      kv: { command: "kv-server" },
    });
    expect(Object.keys(split.shared)).toEqual(["docs"]);
    expect(Object.keys(split.dedicated)).toEqual(["kv"]);
  });

  it("caps shared processes and reports usage for the cost report", () => {
    const pool = new TeamMcpPool(
      "team-1",
      {},
      { capabilities: { tools: "*", pathScopes: "*", network: "*" } },
    );
    expect(pool.usage()).toEqual({ sharedServers: 0, sharedProcesses: 0, cap: TEAM_MCP_PROCESS_CAP });
    expect(pool.sharedTools()).toEqual([]);
  });

  it("starting an empty pool is a no-op that disposes cleanly", async () => {
    const pool = new TeamMcpPool(
      "team-1",
      {},
      { capabilities: { tools: "*", pathScopes: "*", network: "*" } },
    );
    await pool.start();
    await pool.dispose();
    expect(pool.sharedTools()).toEqual([]);
  });
});

describe("phase 8 reviewer findings on the diff substrate", () => {
  it("appends findings as attributed diff comments", () => {
    const dir = mkdtempSync(join(tmpdir(), "agency-phase8-diff-"));
    try {
      const target = join(dir, "login.ts");
      const comments = appendReviewFindings(
        target,
        [{ text: "token refresh races logout", line: 10 }, { text: "overall shape is right" }],
        "code-reviewer",
      );
      expect(comments).toHaveLength(2);
      expect(listDiffComments(target).map((c) => c.author)).toEqual(["code-reviewer", "code-reviewer"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

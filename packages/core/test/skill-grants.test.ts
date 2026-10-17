import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FULL_CAPABILITIES, PermissionsGate } from "@agency/guard";
import type { HttpClient } from "@agency/net";
import type { ProviderAdapter, StreamEvent } from "@agency/providers";
import { Scheduler } from "@agency/providers";
import { runTurn, type ToolSpec } from "../src/loop.ts";
import { createSkillTool, discoverSkills, parseSkillFrontmatter } from "../src/plugins/skill.ts";

const usage = { inputTokens: 1, outputTokens: 1 };
const noopHttp: HttpClient = { fetch: async () => new Response() };

/** Sends each call in turn, one per request, then ends. */
function calls(list: Array<{ name: string; input: Record<string, unknown> }>): ProviderAdapter {
  let n = 0;
  return {
    family: "fake",
    async *stream(): AsyncIterable<StreamEvent> {
      const call = list[n++];
      if (call === undefined) {
        yield { type: "text_delta", text: "done" };
        yield { type: "message_stop", stopReason: "end_turn", usage };
        return;
      }
      yield { type: "tool_call_start", id: `c${n}`, name: call.name };
      yield { type: "tool_call_delta", id: `c${n}`, inputJsonDelta: JSON.stringify(call.input) };
      yield { type: "tool_call_end", id: `c${n}` };
      yield { type: "message_stop", stopReason: "tool_use", usage };
    },
  };
}

test("allowed-tools of a skill: a list, a string, and the folder of the skill in a rule", () => {
  expect(
    parseSkillFrontmatter("---\nallowed-tools: Read, Bash(git add:*), mcp__gh__list\n---\nx").allowedTools,
  ).toEqual(["Read", "Bash(git add:*)", "mcp__gh__list"]);
  expect(
    parseSkillFrontmatter("---\nallowed-tools:\n  - Read\n  - Bash(npm *)\n---\nx").allowedTools,
  ).toEqual(["Read", "Bash(npm *)"]);
  const dir = mkdtempSync(join(tmpdir(), "agency-skill-grant-"));
  try {
    mkdirSync(join(dir, "render"));
    writeFileSync(
      join(dir, "render", "SKILL.md"),
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder of Claude Code
      "---\ndescription: Renders\nallowed-tools: Bash(${CLAUDE_SKILL_DIR}/run.sh *)\n---\nRun it.",
    );
    const [skill] = discoverSkills([{ dir, tier: "user" }]);
    expect(skill?.allowedTools).toEqual([`Bash(${join(dir, "render")}/run.sh *)`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a skill that the model loads pre-approves its allowed-tools for the rest of the turn; a deny rule still holds", async () => {
  const ran: string[] = [];
  const bash: ToolSpec = {
    name: "bash",
    description: "runs a command",
    inputSchema: {},
    riskTier: "dangerous",
    handler: async (input) => {
      ran.push(String(input.command));
      return { content: "ok" };
    },
  };
  const skill = createSkillTool([
    {
      name: "test-runner",
      path: join(tmpdir(), "test-runner", "SKILL.md"),
      description: "Runs the tests",
      body: "Run npm test.",
      tier: "user",
      modelInvocable: true,
      userInvocable: true,
      allowedTools: ["Bash(npm *)", "Bash(rm *)"],
    },
  ]);
  const turn = (list: Array<{ name: string; input: Record<string, unknown> }>, grantedTools?: string[]) =>
    runTurn(calls(list), new Scheduler(), noopHttp, {
      identity: { type: "user" },
      capabilities: FULL_CAPABILITIES,
      systemPrompt: "sys",
      tools: [bash, skill],
      model: "m",
      apiKey: "k",
      session: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      // No one to ask: a call that needs a prompt is refused.
      toolPolicy: new PermissionsGate({
        workspaceRoot: process.cwd(),
        permissions: { bash: { "rm *": "deny" } },
      }),
      ...(grantedTools ? { grantedTools } : {}),
    });
  // Before the skill loads, `npm test` needs a prompt; after, it runs. `rm` stays denied, and `git` was not granted.
  await turn([
    { name: "bash", input: { command: "npm test" } },
    { name: "skill", input: { name: "test-runner" } },
    { name: "bash", input: { command: "npm test" } },
    { name: "bash", input: { command: "rm -f x" } },
    { name: "bash", input: { command: "git push" } },
  ]);
  expect(ran).toEqual(["npm test"]);
  // A `/name` of the user starts the turn with the grant.
  ran.length = 0;
  await turn([{ name: "bash", input: { command: "npm run build" } }], ["Bash(npm *)"]);
  expect(ran).toEqual(["npm run build"]);
});

test("context: fork runs the skill in a subagent of its agent type, and the model gets only the answer", async () => {
  const parsed = parseSkillFrontmatter(
    "---\ncontext: fork\nagent: Explore\nmodel: inherit\n---\nFind the bug.",
  );
  expect(parsed.fork).toEqual({ agent: "Explore" });
  const spawned: Array<Record<string, unknown>> = [];
  const spawn: ToolSpec = {
    name: "spawn",
    description: "starts a worker",
    inputSchema: {},
    riskTier: "safe",
    handler: async (input) => {
      spawned.push(input);
      return { content: "the bug is in parse()" };
    },
  };
  const skill = createSkillTool([
    {
      name: "hunt",
      path: join(tmpdir(), "hunt", "SKILL.md"),
      description: "Hunts a bug",
      body: "Find the bug in $ARGUMENTS.",
      tier: "user",
      modelInvocable: true,
      userInvocable: true,
      fork: { agent: "Explore" },
    },
  ]);
  const result = await runTurn(
    calls([{ name: "skill", input: { name: "hunt", arguments: "src/a.ts" } }]),
    new Scheduler(),
    noopHttp,
    {
      identity: { type: "user" },
      capabilities: FULL_CAPABILITIES,
      systemPrompt: "sys",
      tools: [skill, spawn],
      model: "m",
      apiKey: "k",
      session: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    },
  );
  expect(spawned).toHaveLength(1);
  expect(spawned[0]).toMatchObject({ agent: "Explore" });
  expect(String(spawned[0]?.prompt)).toContain("Find the bug in src/a.ts.");
  const answer = result.messages.flatMap((m) =>
    m.content.flatMap((b) => (b.type === "tool_result" ? [b.content] : [])),
  );
  expect(answer).toEqual(["The skill hunt ran in a subagent. Its answer:\n\nthe bug is in parse()"]);
});

test("in auto mode the grant of a skill answers before the reviewer", async () => {
  const ran: string[] = [];
  const bash: ToolSpec = {
    name: "bash",
    description: "runs a command",
    inputSchema: {},
    riskTier: "dangerous",
    handler: async (input) => {
      ran.push(String(input.command));
      return { content: "ok" };
    },
  };
  await runTurn(calls([{ name: "bash", input: { command: "npm run build" } }]), new Scheduler(), noopHttp, {
    identity: { type: "user" },
    capabilities: FULL_CAPABILITIES,
    systemPrompt: "sys",
    tools: [bash],
    model: "m",
    apiKey: "k",
    session: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    toolPolicy: new PermissionsGate({ workspaceRoot: process.cwd(), permissions: {} }),
    reviewApproval: async () => ({ allow: false, reason: "the reviewer says no" }),
    grantedTools: ["Bash(npm *)"],
  });
  expect(ran).toEqual(["npm run build"]);
});

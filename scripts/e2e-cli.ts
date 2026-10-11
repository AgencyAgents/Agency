/**
 * Offline end to end through the real CLI: daemon spawn, RPC, agent loop, a real tool and session resume,
 * once per provider wire format. Run: bun scripts/e2e-cli.ts [compiled-binary]   (no argument runs the source entrypoint)
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function assert(cond: boolean, what: string): void {
  if (!cond) throw new Error(`e2e-cli failed: ${what}`);
}

const binary = process.argv[2];
const cli = binary
  ? [binary]
  : [process.execPath, join(import.meta.dir, "..", "packages/cli/src/entrypoint.ts")];
const secret = `note-${crypto.randomUUID()}`;
const KEY = "e2e-key";

/** What the model stand-in decides from, whatever the wire format. */
interface Seen {
  auth: string | null;
  offersRead: boolean;
  lastIsToolResult: boolean;
  hadToolResult: boolean;
  /** Every message of the request, serialized, to check that history and tool output arrive. */
  history: string;
}
type Reply = { text: string } | { readPath: string };

const sse = (events: Array<{ event?: string; data: unknown }>, tail = ""): Response =>
  new Response(
    events.map((e) => `${e.event ? `event: ${e.event}\n` : ""}data: ${JSON.stringify(e.data)}\n\n`).join("") +
      tail,
    { headers: { "Content-Type": "text/event-stream" } },
  );

type Body = Record<string, unknown>;
type Msg = { role: string; content?: unknown; parts?: Array<Record<string, unknown>> };
const blocks = (m: Msg | undefined): Array<Record<string, unknown>> =>
  Array.isArray(m?.content) ? (m.content as Array<Record<string, unknown>>) : (m?.parts ?? []);

const wire = {
  openai: {
    route: "/openai/v1/chat/completions",
    seen(req: Request, body: Body): Seen {
      const messages = (body.messages ?? []) as Msg[];
      const tools = (body.tools ?? []) as Array<{ function: { name: string } }>;
      return {
        auth: req.headers.get("authorization")?.replace("Bearer ", "") ?? null,
        offersRead: tools.some((t) => t.function.name === "read"),
        lastIsToolResult: messages.at(-1)?.role === "tool",
        hadToolResult: messages.some((m) => m.role === "tool"),
        history: JSON.stringify(messages),
      };
    },
    reply(reply: Reply): Response {
      const chunk = (delta: unknown, finish: string | null = null) => ({
        data: { id: "c", choices: [{ index: 0, delta, finish_reason: finish }] },
      });
      const call = (args: string, head: boolean) => ({
        index: 0,
        ...(head ? { id: "call_1", type: "function" } : {}),
        function: { ...(head ? { name: "read" } : {}), arguments: args },
      });
      const body =
        "text" in reply
          ? [chunk({ role: "assistant", content: reply.text }), chunk({}, "stop")]
          : [
              chunk({ tool_calls: [call("", true)] }),
              chunk({ tool_calls: [call(JSON.stringify({ path: reply.readPath }), false)] }),
              chunk({}, "tool_calls"),
            ];
      const usage = { data: { id: "c", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } } };
      return sse([...body, usage], "data: [DONE]\n\n");
    },
  },
  anthropic: {
    route: "/anthropic/v1/messages",
    seen(req: Request, body: Body): Seen {
      const messages = (body.messages ?? []) as Msg[];
      const isResult = (m: Msg | undefined) => blocks(m).some((b) => b.type === "tool_result");
      return {
        auth: req.headers.get("x-api-key"),
        offersRead: ((body.tools ?? []) as Array<{ name: string }>).some((t) => t.name === "read"),
        lastIsToolResult: isResult(messages.at(-1)),
        hadToolResult: messages.some(isResult),
        history: JSON.stringify(messages),
      };
    },
    reply(reply: Reply): Response {
      const block =
        "text" in reply
          ? { start: { type: "text", text: "" }, delta: { type: "text_delta", text: reply.text } }
          : {
              start: { type: "tool_use", id: "toolu_1", name: "read", input: {} },
              delta: { type: "input_json_delta", partial_json: JSON.stringify({ path: reply.readPath }) },
            };
      const event = (type: string, rest: Record<string, unknown>) => ({
        event: type,
        data: { type, ...rest },
      });
      const usage = { input_tokens: 10, output_tokens: 1 };
      return sse([
        event("message_start", {
          message: { id: "m", type: "message", role: "assistant", content: [], usage },
        }),
        event("content_block_start", { index: 0, content_block: block.start }),
        event("content_block_delta", { index: 0, delta: block.delta }),
        event("content_block_stop", { index: 0 }),
        event("message_delta", {
          delta: { stop_reason: "text" in reply ? "end_turn" : "tool_use", stop_sequence: null },
          usage: { output_tokens: 5 },
        }),
        event("message_stop", {}),
      ]);
    },
  },
  google: {
    route: "/google/v1beta/models/m:streamGenerateContent",
    seen(req: Request, body: Body): Seen {
      const contents = (body.contents ?? []) as Msg[];
      const tools = (body.tools ?? []) as Array<{ functionDeclarations?: Array<{ name: string }> }>;
      const isResult = (m: Msg | undefined) => blocks(m).some((p) => "functionResponse" in p);
      return {
        auth: new URL(req.url).searchParams.get("key"),
        offersRead: tools.some((t) => t.functionDeclarations?.some((f) => f.name === "read") === true),
        lastIsToolResult: isResult(contents.at(-1)),
        hadToolResult: contents.some(isResult),
        history: JSON.stringify(contents),
      };
    },
    reply(reply: Reply): Response {
      const part =
        "text" in reply
          ? { text: reply.text }
          : { functionCall: { name: "read", args: { path: reply.readPath } } };
      return sse([
        {
          data: {
            candidates: [{ content: { parts: [part], role: "model" }, finishReason: "STOP", index: 0 }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
          },
        },
      ]);
    },
  },
};
type Family = keyof typeof wire;
const families = Object.keys(wire) as Family[];
const seen: Record<Family, Seen[]> = { openai: [], anthropic: [], google: [] };

// Model stand-in: asks for `read` once, then repeats what the tool returned.
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const family = families.find((f) => wire[f].route === path);
    if (!family) return new Response(`no such route: ${path}`, { status: 404 });
    const view = wire[family].seen(request, (await request.json()) as Body);
    seen[family].push(view);
    if (!view.offersRead) return wire[family].reply({ text: "ok" });
    if (view.lastIsToolResult) {
      return wire[family].reply({ text: `saw: ${view.history.includes(secret) ? secret : "nothing"}` });
    }
    if (view.hadToolResult) return wire[family].reply({ text: "second turn" });
    return wire[family].reply({ readPath: "note.txt" });
  },
});

const home = mkdtempSync(join(tmpdir(), "agency-e2e-home-"));
const workspace = mkdtempSync(join(tmpdir(), "agency-e2e-ws-"));
const origin = `http://127.0.0.1:${server.port}`;
const models = { m: { contextWindow: 32_000, maxOutputTokens: 1_000 } };
mkdirSync(join(home, "config"), { recursive: true });
writeFileSync(
  join(home, "config", "config.jsonc"),
  JSON.stringify({
    provider: {
      "fake-openai": { baseUrl: `${origin}/openai/v1`, apiKey: KEY, models },
      "fake-anthropic": { family: "anthropic", baseUrl: `${origin}/anthropic/v1`, apiKey: KEY, models },
      "fake-google": { family: "google", baseUrl: `${origin}/google/v1beta`, apiKey: KEY, models },
    },
  }),
);
writeFileSync(join(workspace, "note.txt"), secret);

// A user machine has no bun on PATH; the binary must not need one.
const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
const env: Record<string, string | undefined> = { ...process.env, AGENCY_HOME: home };
for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
env.PATH = process.platform === "win32" ? `${systemRoot}\\System32;${systemRoot}` : "/usr/bin:/bin";

const instances = join(home, "data", "instances");
const daemonPids = (): number[] =>
  readdirSync(instances)
    .filter((f) => f.endsWith(".json"))
    .map((f) => (JSON.parse(readFileSync(join(instances, f), "utf8")) as { pid: number }).pid);
const daemonsSeen = new Set<number>();

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([...cli, ...args, "--workspace", workspace], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  for (const pid of daemonPids()) daemonsSeen.add(pid);
  return { code, stdout, stderr };
}

try {
  for (const family of families) {
    const target = ["--model", `fake-${family}/m`];
    const first = await run(["-p", "read note.txt", "--session", `e2e-${family}`, ...target]);
    assert(first.code === 0, `${family}: first turn exits 0, got ${first.code}: ${first.stderr}`);
    assert(
      first.stdout.includes(secret),
      `${family}: stdout carries what the read tool returned: ${first.stdout}`,
    );
    assert(seen[family].length > 0, `${family}: the request reached the configured baseUrl`);
    assert(
      seen[family].every((r) => r.auth === KEY),
      `${family}: the configured key reaches the provider`,
    );

    const second = await run(["-p", "again", "--continue", ...target]);
    assert(second.code === 0, `${family}: resumed turn exits 0, got ${second.code}: ${second.stderr}`);
    assert(
      second.stdout.includes("second turn"),
      `${family}: resumed turn prints the reply: ${second.stdout}`,
    );
    const resumed = seen[family].at(-1)?.history ?? "";
    assert(
      resumed.includes("read note.txt") && resumed.includes(secret),
      `${family}: the resumed request carries the first turn`,
    );
  }
  assert(
    daemonsSeen.size === 1,
    `one daemon outlives the CLI that started it and serves every run, saw ${daemonsSeen.size}`,
  );
  console.log(
    `e2e-cli: ${binary ? "compiled binary" : "source"}: tool turn and session resume green on ${families.join(", ")}`,
  );
} finally {
  for (const pid of daemonPids()) {
    try {
      process.kill(pid);
    } catch {
      // The daemon already exited.
    }
  }
  await server.stop(true);
  for (const dir of [home, workspace]) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}

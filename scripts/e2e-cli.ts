/**
 * Offline end to end through the real CLI: daemon spawn, RPC, agent loop, HTTP provider, a real tool, session resume.
 * Run: bun scripts/e2e-cli.ts [compiled-binary]   (no argument runs the source entrypoint)
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

type ChatRequest = {
  messages: { role: string; content: unknown }[];
  tools?: { function: { name: string } }[];
};
const requests: { auth: string | null; body: ChatRequest }[] = [];

const chunk = (delta: unknown, finish: string | null = null) => ({
  id: "c",
  choices: [{ index: 0, delta, finish_reason: finish }],
});
const usage = { id: "c", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };

function sse(chunks: unknown[]): Response {
  const body = [...chunks, usage].map((c) => `data: ${JSON.stringify(c)}\n\n`).join("");
  return new Response(`${body}data: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
}
const say = (text: string) => sse([chunk({ role: "assistant", content: text }), chunk({}, "stop")]);

// Model stand-in: asks for `read` once, then answers with whatever the tool returned.
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const body = (await request.json()) as ChatRequest;
    requests.push({ auth: request.headers.get("authorization"), body });
    const last = body.messages.at(-1);
    if (!body.tools?.length) return say("ok");
    if (last?.role === "tool") return say(`saw: ${String(last.content)}`);
    if (body.messages.some((m) => m.role === "tool")) return say("second turn");
    const call = { index: 0, id: "call_1", type: "function", function: { name: "read", arguments: "" } };
    return sse([
      chunk({ role: "assistant", content: "" }),
      chunk({ tool_calls: [call] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ path: "note.txt" }) } }] }),
      chunk({}, "tool_calls"),
    ]);
  },
});

const home = mkdtempSync(join(tmpdir(), "agency-e2e-home-"));
const workspace = mkdtempSync(join(tmpdir(), "agency-e2e-ws-"));
mkdirSync(join(home, "config"), { recursive: true });
writeFileSync(
  join(home, "config", "config.jsonc"),
  JSON.stringify({
    provider: {
      fake: {
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        apiKey: "e2e-key",
        models: { m: { contextWindow: 32_000, maxOutputTokens: 1_000 } },
      },
    },
  }),
);
writeFileSync(join(workspace, "note.txt"), secret);

// A user machine has no bun on PATH; the binary must not need one.
const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
const env: Record<string, string | undefined> = { ...process.env, AGENCY_HOME: home };
for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
env.PATH = process.platform === "win32" ? `${systemRoot}\\System32;${systemRoot}` : "/usr/bin:/bin";

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([...cli, ...args, "--model", "fake/m", "--workspace", workspace], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

try {
  const first = await run(["-p", "read note.txt", "--session", "e2e"]);
  assert(first.code === 0, `first turn exits 0, got ${first.code}: ${first.stderr}`);
  assert(
    first.stdout.includes(secret),
    `stdout carries the file content the read tool returned: ${first.stdout}`,
  );
  const withTools = requests.find((r) => r.body.tools?.length);
  assert(withTools?.auth === "Bearer e2e-key", "the configured key reaches the provider");
  assert(withTools?.body.tools?.some((t) => t.function.name === "read") === true, "the read tool is offered");

  const second = await run(["-p", "again", "--continue"]);
  assert(second.code === 0, `resumed turn exits 0, got ${second.code}: ${second.stderr}`);
  assert(second.stdout.includes("second turn"), `resumed turn prints the reply: ${second.stdout}`);
  const resumed = JSON.stringify(requests.at(-1)?.body.messages);
  assert(
    resumed.includes("read note.txt") && resumed.includes(secret),
    "the resumed request carries the first turn",
  );

  console.log(`e2e-cli: ${binary ? "compiled binary" : "source"}: tool turn and session resume green`);
} finally {
  const instances = join(home, "data", "instances");
  for (const file of readdirSync(instances, { withFileTypes: false }).filter((f) => f.endsWith(".json"))) {
    try {
      process.kill((JSON.parse(readFileSync(join(instances, file), "utf8")) as { pid: number }).pid);
    } catch {
      // The daemon already exited.
    }
  }
  await server.stop(true);
  for (const dir of [home, workspace]) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}

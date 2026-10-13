import { join } from "node:path";
import { createInterface } from "node:readline";
import type { ToolSpec } from "./loop.ts";

export const CODE_TOOL = "code";
/** Hidden entrypoint command: a compiled binary runs itself as the script process. */
export const CODE_COMMAND = "__code";
const TIMEOUT_MS = 120_000;
// ponytail: a fixed limit against a script that loops on tool calls. Make it a config value if a real task needs more.
const MAX_CALLS = 100;

type Reply = { id: number; content: string; isError: boolean };
type FromChild =
  | { call: number; name: string; input?: unknown }
  | { done: true; output: string; result?: string; error?: string };

async function* linesOf(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let rest = "";
  for await (const chunk of stream) {
    const parts = (rest + decoder.decode(chunk, { stream: true })).split("\n");
    rest = parts.pop() ?? "";
    yield* parts;
  }
  if (rest !== "") yield rest;
}

const STANDALONE = /^(B:[\\/]~BUN|\/\$bunfs)[\\/]/.test(Bun.main);

/** A user machine has no `bun` on PATH and no source files, so a compiled binary runs itself. */
export function codeRunner(): string[] {
  if (STANDALONE) return [process.execPath, CODE_COMMAND];
  return [process.execPath, "run", join(import.meta.dir, "codemode-entry.ts")];
}

/** The files that the script process must read to start: all that an isolated one sees of the user's disk. */
export function codeRunnerReadPaths(): string[] {
  return STANDALONE ? [process.execPath] : [process.execPath, import.meta.dir];
}

/**
 * A tool that runs a script of the model in a child process. The script calls the other tools through the loop, so
 * each inner call meets the same permission gate and hooks. Without a sandbox argv as `runner`, the script itself has
 * the authority of a shell command.
 */
export function codeTool(env: () => Record<string, string>, runner: string[] = codeRunner()): ToolSpec {
  return {
    name: CODE_TOOL,
    description:
      "Runs JavaScript: the body of an async function. Your other tools are functions: " +
      "`await tools.<name>(input)` takes the same input object as a direct call and returns the output text. " +
      "A failed call throws. Use Promise.all for calls that do not depend on each other. " +
      "You get back only what you print with console.log and the return value, so print only what you need. " +
      "Use it for three or more calls in a row, for a call on each item of a result, or to filter a large output. " +
      "For one call, call the tool directly.",
    inputSchema: {
      type: "object",
      properties: { code: { type: "string", description: "The JavaScript to run." } },
      required: ["code"],
    },
    riskTier: "dangerous",
    handler: async (input, ctx) => {
      const callTool = ctx.callTool;
      if (!callTool) return { content: "the code tool is not available in this run", isError: true };
      const child = Bun.spawn(runner, {
        cwd: ctx.cwd,
        env: env(),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      });
      const send = (message: { code: string } | Reply): void => {
        try {
          child.stdin.write(`${JSON.stringify(message)}\n`);
          child.stdin.flush();
        } catch {}
      };
      let timedOut = false;
      const kill = (): void => child.kill();
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, TIMEOUT_MS);
      ctx.signal.addEventListener("abort", kill, { once: true });
      const stderr = new Response(child.stderr).text();
      const stray: string[] = [];
      let calls = 0;
      let done: Extract<FromChild, { done: true }> | undefined;
      try {
        send({ code: String(input.code ?? "") });
        for await (const line of linesOf(child.stdout)) {
          let message: FromChild;
          try {
            message = JSON.parse(line) as FromChild;
          } catch {
            // The script wrote to stdout directly: that is output too.
            stray.push(line);
            continue;
          }
          if ("done" in message) {
            done = message;
            break;
          }
          if (typeof message?.call !== "number") {
            stray.push(line);
            continue;
          }
          const id = message.call;
          calls += 1;
          const refused =
            message.name === CODE_TOOL
              ? "the code tool cannot call itself"
              : calls > MAX_CALLS
                ? `not run: a script can make at most ${MAX_CALLS} tool calls`
                : message.input === null || typeof message.input !== "object" || Array.isArray(message.input)
                  ? `the input of ${message.name} must be an object`
                  : undefined;
          if (refused !== undefined) {
            send({ id, content: refused, isError: true });
            continue;
          }
          ctx.onProgress?.(`tools.${message.name}`);
          void callTool(message.name, message.input as Record<string, unknown>).then(
            (result) => send({ id, content: result.content, isError: result.isError }),
            (error) => send({ id, content: String(error), isError: true }),
          );
        }
      } finally {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", kill);
        kill();
      }
      const output = [...stray, done?.output ?? ""].filter((text) => text !== "").join("\n");
      if (done === undefined) {
        const why = timedOut
          ? `the script did not end in ${TIMEOUT_MS / 1000} s and was stopped`
          : ctx.signal.aborted
            ? "the script was stopped: the turn was cancelled"
            : `the script process ended early: ${(await stderr).trim().slice(-2000) || "no error text"}`;
        return { content: [output, why].filter((text) => text !== "").join("\n"), isError: true };
      }
      if (done.error !== undefined) {
        return {
          content: [output, `error: ${done.error}`].filter((text) => text !== "").join("\n"),
          isError: true,
        };
      }
      const returned = done.result === undefined ? [] : [`return: ${done.result}`];
      return { content: [output, ...returned].filter((text) => text !== "").join("\n") };
    },
  };
}

/** The script process: reads the script and the tool results from stdin, writes tool calls and the end to stdout. */
export async function runCodeChild(): Promise<never> {
  const printed: string[] = [];
  const show = (value: unknown): string => (typeof value === "string" ? value : Bun.inspect(value));
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    console[level] = (...values: unknown[]) => {
      printed.push(values.map(show).join(" "));
    };
  }
  const write = (message: FromChild): void => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };
  const pending = new Map<number, { resolve: (text: string) => void; reject: (error: Error) => void }>();
  let nextId = 0;
  const tools = new Proxy(
    {},
    {
      get:
        (_target, name) =>
        (input: unknown): Promise<string> =>
          new Promise((resolve, reject) => {
            nextId += 1;
            pending.set(nextId, { resolve, reject });
            write({ call: nextId, name: String(name), input: input ?? {} });
          }),
    },
  );
  const run = async (code: string): Promise<void> => {
    try {
      const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
        ...args: string[]
      ) => (tools: unknown) => Promise<unknown>;
      const result = await new AsyncFunction("tools", code)(tools);
      write({
        done: true,
        output: printed.join("\n"),
        ...(result === undefined ? {} : { result: show(result) }),
      });
    } catch (error) {
      const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
      write({ done: true, output: printed.join("\n"), error: text });
    }
    process.exit(0);
  };
  let started = false;
  for await (const line of createInterface({ input: process.stdin })) {
    const message = JSON.parse(line) as { code: string } | Reply;
    if (!started && "code" in message) {
      started = true;
      void run(message.code);
      continue;
    }
    const reply = message as Reply;
    const waiter = pending.get(reply.id);
    pending.delete(reply.id);
    if (reply.isError) waiter?.reject(new Error(reply.content));
    else waiter?.resolve(reply.content);
  }
  process.exit(0);
}

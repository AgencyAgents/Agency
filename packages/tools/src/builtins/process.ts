import { t } from "@agency/i18n";
import type { ToolDeps, ToolSpec } from "../contract.ts";
import type { ProcessManager } from "../process-manager.ts";
import { str, summarize } from "../render.ts";

function unknown(id: string): { content: string; isError: true } {
  return { content: t("tool.process.unknown", { id }), isError: true };
}

export function createProcessOutputTool(processManager: ProcessManager): ToolSpec {
  const spec: ToolSpec<{ id: string; wait?: number }> = {
    name: "process_output",
    deferred: true,
    description:
      "Reads the accumulated output of a background process. Pass wait (seconds, at most 600) to wait " +
      "until the process exits or that time passes, instead of calling again and again.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The process id returned when it was started." },
        wait: { type: "number", description: "Seconds to wait for the process to exit first." },
      },
      required: ["id"],
    },
    riskTier: "safe",
    renderCall: (input) => `process_output ${str(input.id)}`,
    renderResult: (result) =>
      result.isError
        ? `process_output failed: ${summarize(result.content)}`
        : `process_output: ${summarize(result.content) || "(no output)"}`,

    async handler(input, ctx) {
      const wait = typeof input.wait === "number" && input.wait > 0 ? Math.min(input.wait, 600) : 0;
      let status = "";
      if (wait > 0) {
        const exited = await Promise.race([
          processManager.wait(str(input.id), wait * 1000),
          new Promise<boolean>((r) => ctx.signal.addEventListener("abort", () => r(false), { once: true })),
        ]);
        status = exited ? t("tool.process.exited") : t("tool.process.still_running", { seconds: wait });
      }
      const logs = processManager.getLogs(str(input.id));
      if (logs === undefined) return unknown(str(input.id));
      const content = logs.length === 0 ? t("tool.process.no_output", { id: str(input.id) }) : logs;
      return {
        content: status
          ? `${content}
${status}`
          : content,
      };
    },
  };
  return spec;
}

export function createProcessListTool(processManager: ProcessManager): ToolSpec {
  const spec: ToolSpec<Record<string, never>> = {
    name: "process_list",
    deferred: true,
    description: "Lists background processes started this session, with id, pid, command and running state.",
    inputSchema: { type: "object", properties: {} },
    riskTier: "safe",
    renderCall: () => "process_list",
    renderResult: (result) =>
      result.isError ? `process_list failed: ${summarize(result.content)}` : summarize(result.content),

    async handler() {
      const processes = processManager.list();
      if (processes.length === 0) return { content: t("tool.process.none_running") };
      const lines = processes.map(
        (info) =>
          `${info.running ? "running" : "exited"}  ${info.id}  pid ${info.pid}  ${info.command}  (started ${info.startedAt})`,
      );
      return { content: lines.join("\n") };
    },
  };
  return spec;
}

export function createProcessKillTool(_deps: ToolDeps, processManager: ProcessManager): ToolSpec {
  const spec: ToolSpec<{ id: string }> = {
    name: "process_kill",
    deferred: true,
    description: "Kills a background process (and its process tree) started this session.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The process id returned when it was started." },
      },
      required: ["id"],
    },
    riskTier: "moderate",
    renderCall: (input) => `process_kill ${str(input.id)}`,
    renderResult: (result) =>
      result.isError ? `process_kill failed: ${summarize(result.content)}` : summarize(result.content),

    async handler(input) {
      const id = str(input.id);
      const known = processManager.list().some((info) => info.id === id);
      if (!known) return unknown(id);
      try {
        processManager.kill(id);
      } catch (error) {
        return {
          content: `failed to kill process ${id}: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      }
      return { content: t("tool.process.killed", { id }) };
    },
  };
  return spec;
}

export function createProcessTools(deps: ToolDeps, processManager: ProcessManager): ToolSpec[] {
  return [
    createProcessOutputTool(processManager),
    createProcessListTool(processManager),
    createProcessKillTool(deps, processManager),
  ];
}

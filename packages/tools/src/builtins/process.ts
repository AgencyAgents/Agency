import { t } from "@agency/i18n";
import type { ToolDeps, ToolSpec } from "../contract.ts";
import { str, summarize } from "../render.ts";
import type { ProcessManager } from "../process-manager.ts";

function unknown(id: string): { content: string; isError: true } {
  return { content: t("tool.process.unknown", { id }), isError: true };
}

export function createProcessOutputTool(processManager: ProcessManager): ToolSpec {
  const spec: ToolSpec<{ id: string }> = {
    name: "process_output",
    description: "Reads the accumulated output of a background process started via bash with background: true.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The process id returned when it was started." },
      },
      required: ["id"],
    },
    riskTier: "safe",
    renderCall: (input) => `process_output ${str(input.id)}`,
    renderResult: (result) =>
      result.isError
        ? `process_output failed: ${summarize(result.content)}`
        : `process_output: ${summarize(result.content) || "(no output)"}`,

    async handler(input) {
      const logs = processManager.getLogs(str(input.id));
      if (logs === undefined) return unknown(str(input.id));
      if (logs.length === 0) return { content: t("tool.process.no_output", { id: str(input.id) }) };
      return { content: logs };
    },
  };
  return spec as unknown as ToolSpec;
}

export function createProcessListTool(processManager: ProcessManager): ToolSpec {
  const spec: ToolSpec<Record<string, never>> = {
    name: "process_list",
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
  return spec as unknown as ToolSpec;
}

export function createProcessKillTool(_deps: ToolDeps, processManager: ProcessManager): ToolSpec {
  const spec: ToolSpec<{ id: string }> = {
    name: "process_kill",
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
  return spec as unknown as ToolSpec;
}

export function createProcessTools(deps: ToolDeps, processManager: ProcessManager): ToolSpec[] {
  return [
    createProcessOutputTool(processManager),
    createProcessListTool(processManager),
    createProcessKillTool(deps, processManager),
  ];
}
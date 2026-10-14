import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { PermissionMode } from "@agency/guard";
import { t } from "@agency/i18n";
import type { Usage } from "@agency/providers";

export interface WorkflowAgentOptions {
  /** `provider/model`. With no value: the model of the run. */
  model?: string;
  permissionMode?: PermissionMode;
  maxSteps?: number;
  /** USD, for this turn. */
  maxCost?: number;
}

export interface WorkflowAgentResult {
  /** The answer of the agent: the text of its last message. */
  text: string;
  stopReason: string;
  usage: Usage;
  /** False when the turn ended with an error, at the step limit or at the cost limit. */
  ok: boolean;
}

/** What the default export of a workflow script gets. */
export interface WorkflowApi {
  /** Runs one agent turn with a new context. */
  agent(prompt: string, options?: WorkflowAgentOptions): Promise<WorkflowAgentResult>;
  /** Runs the tasks with at most `limit` at one time (4 with no value), and gives the results in the order of the tasks. */
  parallel<T>(tasks: Array<() => Promise<T>>, limit?: number): Promise<T[]>;
  /** The `--arg key=value` pairs of the command line. */
  args: Record<string, string>;
  /** Prints a progress line on stderr. */
  log(message: string): void;
}

export async function runParallel<T>(tasks: Array<() => Promise<T>>, limit = 4): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await (tasks[index] as () => Promise<T>)();
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(limit, 1), tasks.length) }, worker));
  return results;
}

/** Loads the script and calls its default export. The script is code of the user: it runs with the rights of this process. */
export async function runWorkflow(file: string, api: WorkflowApi): Promise<unknown> {
  const mod = (await import(pathToFileURL(resolve(file)).href)) as { default?: unknown };
  if (typeof mod.default !== "function") throw new Error(t("cli.error.workflow_no_default", { file }));
  return (mod.default as (api: WorkflowApi) => unknown)(api);
}

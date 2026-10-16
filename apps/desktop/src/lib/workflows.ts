import { invoke } from "@tauri-apps/api/core";
import { createStore, produce, reconcile } from "solid-js/store";
import { errorText, host } from "./host.ts";
import { currentModel, modelChoices, project, refreshRows, rpcWhenUp, state, toast } from "./store.ts";
import { duration } from "./transcript.ts";
import type { Block, SendResult, SessionView } from "./types.ts";

export type Trigger = "manual" | "commit" | "schedule";

export interface WorkflowStep {
  agent: string;
  text: string;
}

export interface Workflow {
  id: string;
  name: string;
  desc: string;
  trigger: Trigger;
  steps: WorkflowStep[];
}

export type StepState = "wait" | "now" | "done" | "fail" | "stop" | "skip";
export type RunStatus = "running" | "passed" | "failed" | "stopped";

export interface RunStep {
  /** The agent, instruction and model as the run used them: the workflow may change later. */
  agent: string;
  text: string;
  model: string;
  state: StepState;
  sessionId?: string;
  turnId?: string;
  startedAt?: number;
  endedAt?: number;
  reply?: string;
  error?: string;
}

export interface Run {
  id: string;
  workflowId: string;
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
  stopping?: boolean;
  steps: RunStep[];
}

export const TRIGGERS: { id: Trigger; label: string; line: string; icon: string }[] = [
  {
    id: "manual",
    label: "When you start it",
    line: "Runs when you start it",
    icon: "M7 4l10 6.5-4.5 1.2L15 17l-1.8.9-2.6-5.2L7 15.5Z",
  },
  {
    id: "commit",
    label: "On new commit",
    line: "Runs on each new commit, while Agency is open",
    icon: "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM3 12h5.5M15.5 12H21",
  },
  {
    id: "schedule",
    label: "Every night",
    line: "Runs every night at 02:00, while Agency is open",
    icon: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7.5V12l3 2",
  },
];

export const trigger = (id: Trigger) =>
  TRIGGERS.find((t) => t.id === id) ?? (TRIGGERS[0] as (typeof TRIGGERS)[0]);

/* ---------- agents ---------- */

export interface AgentInfo {
  name: string;
  provider?: string;
  model?: string;
  effort?: string;
  /** The model as a person reads it. */
  label: string;
}

const text = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

function describe(root: string, name: string, entry: Record<string, unknown> | undefined): AgentInfo {
  const provider = text(entry?.provider);
  const model = text(entry?.model);
  const ref = provider && model ? `${provider}/${model}` : model;
  const label = ref ? (modelChoices(root).find((c) => c.ref === ref)?.label ?? ref) : "Default model";
  return { name, provider, model, effort: text(entry?.effort), label };
}

/** The agents of the project config; a project without any offers one "default" agent on the default model. */
export function agentsOf(root: string): AgentInfo[] {
  const agents = (project(root)?.config?.agents ?? {}) as Record<string, Record<string, unknown>>;
  const names = Object.keys(agents);
  return names.length > 0
    ? names.map((n) => describe(root, n, agents[n]))
    : [describe(root, "default", undefined)];
}

/** An agent a workflow names but the config no longer has runs on the default model. */
export const agentInfo = (root: string, name: string): AgentInfo =>
  agentsOf(root).find((a) => a.name === name) ?? describe(root, name, undefined);

/* ---------- store ---------- */

const [data, setData] = createStore<{ lists: Record<string, Workflow[]>; runs: Record<string, Run[]> }>({
  lists: {},
  runs: {},
});

const rk = (root: string, id: string) => `${root}\u0000${id}`;
export const workflowsOf = (root: string): Workflow[] => data.lists[root] ?? [];
export const isLoaded = (root: string): boolean => data.lists[root] !== undefined;
export const runsOf = (root: string, id: string): Run[] => data.runs[rk(root, id)] ?? [];
export const liveRunOf = (root: string, id: string): Run | undefined =>
  runsOf(root, id).find((r) => r.status === "running");

const STATUSES: RunStatus[] = ["running", "passed", "failed", "stopped"];
const str = (v: unknown): string => (typeof v === "string" ? v : "");

function normalize(raw: unknown): Workflow | null {
  const w = raw as Partial<Workflow> | null;
  if (!w || typeof w.id !== "string" || !Array.isArray(w.steps)) return null;
  return {
    id: w.id,
    name: str(w.name) || w.id,
    desc: str(w.desc),
    trigger: w.trigger === "commit" || w.trigger === "schedule" ? w.trigger : "manual",
    steps: w.steps.map((s) => ({
      agent: str((s as WorkflowStep)?.agent),
      text: str((s as WorkflowStep)?.text),
    })),
  };
}

/** A run still marked running on disk was cut off by a quit. */
function settle(run: Run): Run {
  if (run.status !== "running") return run;
  const steps = run.steps.map((s) => (s.state === "now" ? { ...s, state: "stop" as const } : s));
  return {
    ...run,
    status: "stopped",
    steps: steps.map((s) => (s.state === "wait" ? { ...s, state: "skip" as const } : s)),
  };
}

const loading = new Map<string, Promise<void>>();

/** Run history loads from disk once; from then on the store is the truth. */
function ensureRuns(root: string, id: string): Promise<void> {
  const k = rk(root, id);
  if (data.runs[k] !== undefined) return Promise.resolve();
  let p = loading.get(k);
  if (!p) {
    p = invoke<Run[]>("workflow_runs", { root, id })
      .catch(() => [] as Run[])
      .then((disk) => {
        if (data.runs[k] === undefined) {
          setData(
            "runs",
            k,
            disk.filter((r) => r && typeof r.id === "string" && STATUSES.includes(r.status)).map(settle),
          );
        }
      })
      .finally(() => loading.delete(k));
    loading.set(k, p);
  }
  return p;
}

export async function loadWorkflows(root: string): Promise<void> {
  try {
    const raw = await invoke<unknown[]>("workflows_list", { root });
    const list = raw.map(normalize).filter((w): w is Workflow => w !== null);
    list.sort((a, b) => a.name.localeCompare(b.name));
    setData("lists", root, reconcile(list, { key: "id" }));
    await Promise.all(list.map((w) => ensureRuns(root, w.id)));
  } catch (error) {
    if (!isLoaded(root)) setData("lists", root, []);
    toast(errorText(error), { tone: "err" });
  }
}

export async function saveWorkflow(root: string, workflow: Workflow): Promise<void> {
  await invoke("workflow_save", { root, workflow });
  if (!isLoaded(root)) setData("lists", root, []);
  setData(
    "lists",
    root,
    produce((list: Workflow[]) => {
      const i = list.findIndex((w) => w.id === workflow.id);
      if (i >= 0) list[i] = workflow;
      else list.push(workflow);
      list.sort((a, b) => a.name.localeCompare(b.name));
    }),
  );
  await ensureRuns(root, workflow.id);
}

export async function deleteWorkflow(root: string, id: string): Promise<void> {
  await invoke("workflow_delete", { root, id });
  setData("lists", root, (list) => list.filter((w) => w.id !== id));
}

/** A file name for a new workflow: the name in lowercase, dashes between words, a number when taken. */
export function slug(name: string, taken: string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "workflow";
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

/* ---------- persistence of runs ---------- */

const saves = new Map<string, Promise<unknown>>();

function persist(root: string, id: string, run: Run): void {
  const k = rk(root, id);
  const snapshot = JSON.parse(JSON.stringify(run)) as Run;
  const next = (saves.get(k) ?? Promise.resolve())
    .then(() => invoke("workflow_run_save", { root, id, run: snapshot }))
    .catch((error) => toast(`Could not save the run: ${errorText(error)}`, { tone: "err" }));
  saves.set(k, next);
}

function patch(root: string, workflowId: string, runId: string, fn: (run: Run) => void): void {
  const k = rk(root, workflowId);
  setData(
    "runs",
    k,
    produce((list: Run[]) => {
      const run = list.find((r) => r.id === runId);
      if (run) fn(run);
    }),
  );
  const run = data.runs[k]?.find((r) => r.id === runId);
  if (run) persist(root, workflowId, run);
}

/* ---------- runner ---------- */

interface Ctl {
  stopped: boolean;
  turnId?: string;
}
const ctls = new Map<string, Ctl>();
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

const EFFORTS = ["low", "medium", "high", "max"];

async function replyOf(root: string, sessionId: string): Promise<string> {
  try {
    const { messages } = await rpcWhenUp<SessionView>(root, "session_show", { sessionId });
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m?.role !== "assistant") continue;
      const reply = m.content
        .filter((b): b is Extract<Block, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      if (reply) return reply;
    }
  } catch {
    // A missing reply only leaves the next step without a hand-over.
  }
  return "";
}

/** Starts a run. Returns its id, or null when the workflow already runs or has no step. */
export async function startRun(root: string, w: Workflow): Promise<string | null> {
  if (w.steps.length === 0) {
    toast("Add a step to this workflow first.", { tone: "err" });
    return null;
  }
  await ensureRuns(root, w.id);
  if (liveRunOf(root, w.id)) return null;
  const run: Run = {
    id: crypto.randomUUID(),
    workflowId: w.id,
    status: "running",
    startedAt: Date.now(),
    steps: w.steps.map((s) => ({
      agent: s.agent,
      text: s.text,
      model: agentInfo(root, s.agent).label,
      state: "wait" as const,
    })),
  };
  ctls.set(run.id, { stopped: false });
  setData(
    "runs",
    rk(root, w.id),
    produce((list: Run[]) => {
      list.unshift(run);
      list.splice(20);
    }),
  );
  persist(root, w.id, run);
  void execute(root, w, run.id);
  return run.id;
}

async function execute(root: string, w: Workflow, runId: string): Promise<void> {
  const ctl = ctls.get(runId) as Ctl;
  const step = (i: number, fn: (s: RunStep) => void) =>
    patch(root, w.id, runId, (r) => fn(r.steps[i] as RunStep));
  /** Ends the run: step `at` takes `mark`, the steps after it that never started are skipped. */
  const finish = (status: Exclude<RunStatus, "running">, at: number, mark?: StepState, error?: string) => {
    patch(root, w.id, runId, (r) => {
      r.steps.forEach((s, j) => {
        if (j === at && mark) {
          s.state = mark;
          s.endedAt = Date.now();
          if (error) s.error = error;
        } else if (j >= at && s.state === "wait") {
          s.state = "skip";
        }
      });
      r.status = status;
      r.endedAt = Date.now();
      delete r.stopping;
    });
    ctls.delete(runId);
    toast(`${w.name} ${status}`, status === "failed" ? { tone: "err" } : {});
    void refreshRows(root);
    void rebaseCommit(root);
  };

  let previous = "";
  for (let i = 0; i < w.steps.length; i++) {
    const spec = w.steps[i] as WorkflowStep;
    if (ctl.stopped) return finish("stopped", i);
    step(i, (s) => {
      s.state = "now";
      s.startedAt = Date.now();
    });
    try {
      const agent = agentInfo(root, spec.agent);
      const fallback = currentModel(root);
      // As the daemon's dispatch does: an agent pinned to a provider with no key runs on the default model.
      const pinned =
        agent.provider && agent.model && project(root)?.providers?.connected.includes(agent.provider);
      const provider = pinned ? agent.provider : fallback?.provider;
      const model = pinned ? agent.model : fallback?.model;
      if (!provider || !model) throw new Error("Connect a provider in Settings to run workflows.");
      if (!pinned) {
        const label = fallback?.label ?? model;
        step(i, (s) => {
          s.model = label;
        });
      }
      const { sessionId } = await rpcWhenUp<{ sessionId: string }>(root, "session_create");
      step(i, (s) => {
        s.sessionId = sessionId;
      });
      if (ctl.stopped) return finish("stopped", i, "stop");
      const turnId = crypto.randomUUID();
      ctl.turnId = turnId;
      step(i, (s) => {
        s.turnId = turnId;
      });
      const userText =
        (spec.text.trim() || "Do your part of this workflow.") +
        (previous ? `\n\nThe previous step reported:\n${previous}` : "");
      const result = await rpcWhenUp<SendResult>(root, "session_send", {
        sessionId,
        turnId,
        provider,
        model,
        userText,
        permissionMode: state.prefs.mode,
        ...(agent.effort && EFFORTS.includes(agent.effort) ? { thinkingLevel: agent.effort } : {}),
      });
      ctl.turnId = undefined;
      if (ctl.stopped || result.cancelled) return finish("stopped", i, "stop");
      if (result.error) throw new Error(result.error.message);
      previous = await replyOf(root, sessionId);
      const reply = previous;
      step(i, (s) => {
        s.state = "done";
        s.endedAt = Date.now();
        s.reply = reply;
      });
    } catch (error) {
      ctl.turnId = undefined;
      if (ctl.stopped) return finish("stopped", i, "stop");
      return finish("failed", i, "fail", errorText(error));
    }
    void refreshRows(root);
  }
  finish("passed", w.steps.length);
}

/** Cancels the running step. The daemon may not know the turn yet, so the cancel repeats until it lands. */
export function stopRun(root: string, workflowId: string): void {
  const run = liveRunOf(root, workflowId);
  const ctl = run && ctls.get(run.id);
  if (!run || !ctl || ctl.stopped) return;
  ctl.stopped = true;
  patch(root, workflowId, run.id, (r) => {
    r.stopping = true;
  });
  void (async () => {
    for (let n = 0; n < 40 && ctls.has(run.id); n++) {
      if (ctl.turnId) {
        const done = await host
          .rpc<{ cancelled: boolean }>(root, "cancel_turn", { turnId: ctl.turnId })
          .then((r) => r.cancelled)
          .catch(() => false);
        if (done) return;
      }
      await sleep(300);
    }
  })();
}

export const took = (run: Pick<Run, "startedAt" | "endedAt">): string =>
  run.endedAt ? duration(run.endedAt - run.startedAt) : "";

export function since(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/* ---------- triggers ---------- */

const hashes = new Map<string, string>();

async function commitHash(root: string): Promise<string | undefined> {
  return (await host.gitStatus(root).catch(() => null))?.lastCommit?.hash || undefined;
}

/** Commits a run makes itself must not start the next run. */
async function rebaseCommit(root: string): Promise<void> {
  if (!hashes.has(root)) return;
  const hash = await commitHash(root);
  if (hash) hashes.set(root, hash);
}

function lastNight(now: number): number {
  const b = new Date(now);
  b.setHours(2, 0, 0, 0);
  if (b.getTime() > now) b.setDate(b.getDate() - 1);
  return b.getTime();
}

let triggersOn = false;

/** Polls while the app is open: a new last commit starts "commit" workflows, 02:00 starts "schedule" ones. */
export function startTriggers(): void {
  if (triggersOn) return;
  triggersOn = true;
  let last = Date.now();
  const tick = async () => {
    const now = Date.now();
    const night = last < lastNight(now) && lastNight(now) <= now;
    last = now;
    for (const p of state.projects) {
      if (p.conn !== "up") continue;
      await loadWorkflows(p.path);
      const list = workflowsOf(p.path);
      if (night) for (const w of list) if (w.trigger === "schedule") void startRun(p.path, w);
      const onCommit = list.filter((w) => w.trigger === "commit");
      if (onCommit.length === 0) {
        hashes.delete(p.path);
        continue;
      }
      const hash = await commitHash(p.path);
      if (!hash) continue;
      const seen = hashes.get(p.path);
      hashes.set(p.path, hash);
      if (seen && seen !== hash) for (const w of onCommit) void startRun(p.path, w);
    }
  };
  void tick();
  setInterval(() => void tick(), 60_000);
}

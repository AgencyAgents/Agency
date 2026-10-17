import { batch } from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import { type Environment, environmentLayer } from "./environments.ts";
import { type DaemonFrame, errorCode, errorText, type GitStatus, host, type Project } from "./host.ts";
import {
  addAssistant,
  buildTurns,
  chain,
  history,
  type Part,
  type Turn,
  toolsOf,
  workAt,
} from "./transcript.ts";
import type {
  Approval,
  Effort,
  Entry,
  PermissionMode,
  ProvidersList,
  SendResult,
  SessionRow,
  SessionView,
  Todo,
} from "./types.ts";

export type ConnState = "connecting" | "up" | "down";
export type View = "welcome" | "new" | "session" | "review" | "skills" | "workflows";
export type Filter = "all" | "running" | "needs" | "done" | "archived";
export type Theme = "light" | "dark" | "system";

export interface ProjectState extends Project {
  conn: ConnState;
  error: string | null;
  untrusted: boolean;
  rows: SessionRow[];
  git: GitStatus | null;
  providers: ProvidersList | null;
  config: Record<string, unknown> | null;
  /** The user file alone: Settings writes whole keys from it, so project values stay out of it. */
  userConfig?: Record<string, unknown>;
  commands: { name: string; description?: string; source?: string }[];
}

export interface Attachment {
  name: string;
  size: number;
  mimeType: string;
  /** base64 for images and PDFs, plain text otherwise */
  data: string;
  kind: "image" | "text";
}

export interface Failure {
  message: string;
  code?: string;
  retry: { text: string; attachments: Attachment[] };
}

export interface SessionState {
  view: SessionView | null;
  loading: boolean;
  failure: Failure | null;
  /** The prompt text a new session shows until the daemon titles it. */
  title?: string;
}

export interface LiveTurn {
  turnId: string;
  prompt: string;
  note?: string;
  startedAt: number;
  /** History turns before this one. Times cannot tell: a compaction stamps the entries it copies anew. */
  baseTurns?: number;
  parts: Part[];
  approval: Approval | null;
  tokens: number;
  mine: boolean;
  /** The model gave its last answer; the turn settles soon. */
  ending?: boolean;
  /** The daemon summarizes earlier messages to free context. */
  compacting?: boolean;
}

export interface Toast {
  text: string;
  tone?: "ok" | "err";
  act?: { label: string; run: () => void };
}

interface Prefs {
  theme: Theme;
  layout: "project" | "status";
  model: string | null;
  effort: Effort;
  mode: PermissionMode;
  side: boolean;
  panel: boolean;
  fold: Record<string, boolean>;
  /** The session opened last: a launch opens a new session in its project. */
  last: { root: string; id: string } | null;
  /** Model refs picked last, newest first. */
  recent: string[];
  /** Sessions hidden from the list, by keyOf. */
  archived: string[];
  envs: Environment[];
  /** The environment id of each project root. */
  envOf: Record<string, string>;
  /** The environment id that a project added without one gets; empty for none. */
  defaultEnv: string;
}

const PREFS_KEY = "agency.prefs";

export const MODES: { value: PermissionMode; label: string; desc: string }[] = [
  { value: "ask", label: "Manual", desc: "Asks before each edit and command." },
  { value: "plan", label: "Plan", desc: "Reads and plans. Changes nothing until you approve the plan." },
  { value: "allow-edits", label: "Accept edits", desc: "Edits run. Commands still ask." },
  { value: "auto", label: "Auto", desc: "Edits run. A reviewer model answers the other asks." },
];
export const EFFORT_LABEL: Record<Effort, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};
const EFFORT_ORDER = Object.keys(EFFORT_LABEL) as Effort[];

function loadPrefs(): Prefs {
  const defaults: Prefs = {
    theme: "system",
    layout: "project",
    model: null,
    effort: "high",
    mode: "ask",
    side: true,
    panel: window.innerWidth > 1391,
    fold: {},
    last: null,
    recent: [],
    archived: [],
    envs: [],
    envOf: {},
    defaultEnv: "",
  };
  try {
    const saved = { ...defaults, ...(JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<Prefs>) };
    // Modes of earlier versions: allow-all ran without asking, deny changed nothing.
    const old = saved.mode as string;
    if (!MODES.some((m) => m.value === saved.mode))
      saved.mode = old === "allow-all" ? "auto" : old === "deny" ? "plan" : "ask";
    return saved;
  } catch {
    return defaults;
  }
}

export interface AppState {
  booted: boolean;
  projects: ProjectState[];
  view: View;
  current: { root: string; id: string } | null;
  newRoot: string | null;
  prefs: Prefs;
  panelAnim: boolean;
  settings: boolean;
  filter: Filter;
  q: string;
  toast: Toast | null;
  sessions: Record<string, SessionState>;
  live: Record<string, LiveTurn>;
  composer: Record<string, { draft: string; attachments: Attachment[] }>;
}

export const [state, setState] = createStore<AppState>({
  booted: false,
  projects: [],
  view: "welcome",
  current: null,
  newRoot: null,
  prefs: loadPrefs(),
  panelAnim: false,
  settings: false,
  filter: "all",
  q: "",
  toast: null,
  sessions: {},
  live: {},
  composer: {},
});

export const keyOf = (root: string, id: string): string => `${root}\u0000${id}`;

export function savePrefs(patch: Partial<Prefs>): void {
  setState("prefs", patch);
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs));
  } catch {
    // A blocked storage only loses the remembered layout.
  }
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(text: string, extra: Omit<Toast, "text"> = {}): void {
  clearTimeout(toastTimer);
  setState("toast", { text, ...extra });
  toastTimer = setTimeout(
    () => setState("toast", null),
    extra.act ? 5000 : extra.tone === "err" ? 6000 : 2600,
  );
}
export function dismissToast(): void {
  clearTimeout(toastTimer);
  setState("toast", null);
}

export function project(root: string | null | undefined): ProjectState | undefined {
  return root ? state.projects.find((p) => p.path === root) : undefined;
}

/** A call sent while the daemon restarts (after a config change) waits for it and goes again, for up to 15 s. */
export async function rpcWhenUp<T>(
  root: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const end = Date.now() + 15_000;
  for (;;) {
    try {
      return await host.rpc<T>(root, method, params);
    } catch (error) {
      if (errorCode(error) !== "DAEMON_DOWN" || Date.now() > end) throw error;
      // The status frame can still say "up" for the daemon that just left: wait, then ask again.
      await new Promise((r) => setTimeout(r, 250));
      while (project(root)?.conn !== "up" && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    }
  }
}

function patchProject(root: string, patch: Partial<ProjectState>): void {
  const i = state.projects.findIndex((p) => p.path === root);
  if (i >= 0) setState("projects", i, patch);
}

/* ---------- events ---------- */

const turnSessions = new Map<string, { root: string; id: string }>();
/** Turns that ended here: a late heartbeat or cost event of one must not open a phantom live turn. */
const endedTurns = new Set<string>();
function endTurn(turnId: string): void {
  turnSessions.delete(turnId);
  endedTurns.add(turnId);
  if (endedTurns.size > 500) endedTurns.delete(endedTurns.values().next().value as string);
}
const pendingText = new Map<string, { text: string; thinking: string }>();
let flushQueued = false;

function flushDeltas(): void {
  flushQueued = false;
  batch(() => {
    for (const [key, delta] of pendingText) {
      if (!state.live[key]) continue;
      setState(
        "live",
        key,
        "parts",
        produce((parts: Part[]) => {
          if (delta.thinking) {
            const work = workAt(parts, Date.now());
            const last = work.items.at(-1);
            if (last?.kind === "thought") last.text += delta.thinking;
            else work.items.push({ kind: "thought", text: delta.thinking });
          }
          if (delta.text) {
            const last = parts.at(-1);
            if (last?.kind === "text") last.text += delta.text;
            else parts.push({ kind: "text", text: delta.text });
          }
        }),
      );
    }
    pendingText.clear();
  });
}

function queueDelta(key: string, field: "text" | "thinking", text: string): void {
  const entry = pendingText.get(key) ?? { text: "", thinking: "" };
  entry[field] += text;
  pendingText.set(key, entry);
  if (!flushQueued) {
    flushQueued = true;
    requestAnimationFrame(flushDeltas);
  }
}

function ensureLive(root: string, sessionId: string, turnId: string, mine = false): string {
  const key = keyOf(root, sessionId);
  turnSessions.set(turnId, { root, id: sessionId });
  if (!state.live[key]) {
    setState("live", key, {
      turnId,
      prompt: "",
      startedAt: Date.now(),
      parts: [],
      approval: null,
      tokens: 0,
      mine,
    });
  }
  return key;
}

const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
function refreshSoon(root: string, ms = 250): void {
  clearTimeout(refreshTimers.get(root));
  refreshTimers.set(
    root,
    setTimeout(() => void refreshRows(root), ms),
  );
}

function onTurnEvent(root: string, turnId: string, data: Record<string, unknown>): void {
  if (endedTurns.has(turnId)) return;
  const owner = turnSessions.get(turnId);
  const sessionId = owner?.id ?? (typeof data.sessionId === "string" ? data.sessionId : undefined);
  if (!sessionId) return;
  const key = ensureLive(root, sessionId, turnId);
  switch (data.type) {
    case "text_delta":
      queueDelta(key, "text", String(data.text ?? ""));
      break;
    case "thinking_delta":
      queueDelta(key, "thinking", String(data.text ?? ""));
      break;
    case "tool_start":
      flushDeltas();
      addLiveTool(key, String(data.id), String(data.name), (data.input as Record<string, unknown>) ?? {});
      break;
    case "tool_result":
      flushDeltas();
      setState(
        "live",
        key,
        "parts",
        produce((parts: Part[]) => {
          for (const part of parts) {
            if (part.kind !== "work") continue;
            const step = toolsOf(part).find((s) => s.id === data.id);
            if (step) {
              step.result = String(data.content ?? "");
              step.isError = data.isError === true;
              part.endedAt = Date.now();
            }
          }
        }),
      );
      if (state.live[key]?.approval) setState("live", key, "approval", null);
      break;
    case "approval_requested":
      setApproval(key, data);
      break;
    case "mode_changed": {
      // An approved plan: the turn goes on in Accept edits, and so does the picker.
      const mode = MODES.find((m) => m.value === data.mode);
      if (mode) {
        savePrefs({ mode: mode.value });
        toast(`Plan approved. Mode is now ${mode.label}.`, { tone: "ok" });
      }
      break;
    }
    case "turn_complete": {
      // inputTokens counts the cached part too. The reply joins the context of the next request.
      const usage = data.usage as { inputTokens?: number; outputTokens?: number } | undefined;
      const size = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
      if (size > 0) setState("live", key, "tokens", size);
      if (data.stopReason !== "tool_use" && state.live[key]) setState("live", key, "ending", true);
      if (data.stopReason !== "tool_use" && !state.live[key]?.mine) {
        // A turn another client started has no promise here: its end is the last turn_complete.
        setTimeout(() => void finishForeign(root, sessionId, turnId), 300);
      }
      break;
    }
    case "compaction":
      setState("live", key, "compacting", data.phase === "start");
      break;
    case "fallback":
      setState(
        "live",
        key,
        "parts",
        produce((parts: Part[]) => {
          parts.push({ kind: "note", text: `Switched to ${String(data.to)}: ${String(data.reason ?? "")}` });
        }),
      );
      break;
  }
}

function addLiveTool(key: string, id: string, name: string, input: Record<string, unknown>): void {
  setState(
    "live",
    key,
    "parts",
    produce((parts: Part[]) => {
      const turn: Turn = { key: "", prompt: "", images: 0, parts, startedAt: Date.now() };
      addAssistant(
        turn,
        { role: "assistant", content: [{ type: "tool_call", id, name, input }] },
        Date.now(),
      );
    }),
  );
}

function setApproval(key: string, data: Record<string, unknown>): void {
  const requestId = String(data.requestId ?? data.id ?? "");
  if (!requestId || state.live[key]?.approval?.requestId === requestId) return;
  setState("live", key, "approval", {
    requestId,
    sessionId: String(data.sessionId ?? ""),
    turnId: typeof data.turnId === "string" ? data.turnId : undefined,
    request: data.request as Approval["request"],
  });
}

async function finishForeign(root: string, sessionId: string, turnId: string): Promise<void> {
  const key = keyOf(root, sessionId);
  if (state.live[key]?.turnId !== turnId || state.live[key]?.mine) return;
  await loadSession(root, sessionId);
  setState("live", key, undefined as never);
  endTurn(turnId);
  refreshSoon(root);
}

function onState(root: string, data: Record<string, unknown>): void {
  const turns = (data.turns as { turnId: string; sessionId: string }[] | undefined) ?? [];
  const approvals =
    (data.approvals as { id: string; sessionId: string; turnId?: string; request: unknown }[]) ?? [];
  batch(() => {
    const running = new Set(turns.map((t) => keyOf(root, t.sessionId)));
    for (const key of Object.keys(state.live)) {
      if (key.startsWith(`${root}\u0000`) && !running.has(key) && !state.live[key]?.mine) {
        endTurn(state.live[key]?.turnId ?? "");
        setState("live", key, undefined as never);
      }
    }
    for (const turn of turns) ensureLive(root, turn.sessionId, turn.turnId);
    for (const ask of approvals) {
      const key = keyOf(root, ask.sessionId);
      if (state.live[key]) setApproval(key, { ...ask, requestId: ask.id });
    }
  });
}

function onFrame(root: string, frame: DaemonFrame): void {
  if (frame.kind === "status") {
    const untrusted = frame.state === "down" && /trust/i.test(frame.error ?? "");
    patchProject(root, { conn: frame.state, error: frame.error ?? null, untrusted });
    if (frame.state === "up") void loadProject(root);
    return;
  }
  const data = (frame.data ?? {}) as Record<string, unknown>;
  if (frame.event === "state") {
    onState(root, data);
    return;
  }
  if (frame.event.startsWith("turn.")) {
    onTurnEvent(root, frame.event.slice(5), data);
    return;
  }
  if (frame.event.startsWith("session.")) {
    const sessionId = typeof data.sessionId === "string" ? data.sessionId : frame.event.slice(8);
    if (data.type === "approval_requested") {
      const key = keyOf(root, sessionId);
      if (state.live[key]) setApproval(key, data);
      return;
    }
    refreshSoon(root);
    return;
  }
  if (frame.event === "prompt.submit") {
    const sessionId = String(data.sessionId ?? "");
    const key = keyOf(root, sessionId);
    if (state.live[key] && !state.live[key]?.prompt)
      setState("live", key, "prompt", String(data.prompt ?? ""));
  }
}

/* ---------- loading ---------- */

export async function boot(): Promise<void> {
  const projects = await host.projects().catch(() => [] as Project[]);
  setState(
    "projects",
    projects.map((p) => blankProject(p)),
  );
  const last = state.prefs.last?.root;
  if (projects.length > 0) {
    setState({ view: "new", newRoot: projects.find((p) => p.path === last)?.path ?? projects[0]?.path });
  }
  setState("booted", true);
  for (const p of projects) void host.connect(p.path, (frame) => onFrame(p.path, frame));
  void host.onOpenPath((path) => void addProject(path));
  const launched = await host.launchPath().catch(() => null);
  if (launched) await addProject(launched);
}

function blankProject(p: Project): ProjectState {
  return {
    ...p,
    conn: "connecting",
    error: null,
    untrusted: false,
    rows: [],
    git: null,
    providers: null,
    config: null,
    commands: [],
  };
}

async function loadProject(root: string): Promise<void> {
  await Promise.all([
    refreshRows(root),
    refreshGit(root),
    host
      .rpc<ProvidersList>(root, "providers_list", { models: "connected" })
      .then((r) => patchProject(root, { providers: r }))
      .catch(() => {}),
    host
      .rpc<{ config: Record<string, unknown> }>(root, "config_get")
      .then((r) => patchProject(root, { config: r.config }))
      .catch(() => {}),
    host
      .rpc<{ config: Record<string, unknown> }>(root, "config_user")
      .then((r) => patchProject(root, { userConfig: r.config }))
      .catch(() => {}),
    host
      .rpc<{ commands: ProjectState["commands"] }>(root, "commands_list")
      .then((r) => patchProject(root, { commands: r.commands }))
      .catch(() => {}),
  ]);
  if (state.current?.root === root) void loadSession(root, state.current.id);
}

export async function refreshRows(root: string): Promise<void> {
  try {
    const { sessions } = await host.rpc<{ sessions: SessionRow[] }>(root, "session_list");
    sessions.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    patchProject(root, { rows: sessions.filter((s) => s.entries > 0 || state.live[keyOf(root, s.id)]) });
  } catch {
    // The status frame says when the daemon is down.
  }
}

export async function refreshGit(root: string): Promise<void> {
  const git = await host.gitStatus(root).catch(() => ({ repo: false }) as GitStatus);
  patchProject(root, { git });
}

export async function loadSession(root: string, id: string): Promise<void> {
  const key = keyOf(root, id);
  if (!state.sessions[key]) setState("sessions", key, { view: null, loading: true, failure: null });
  else setState("sessions", key, "loading", true);
  try {
    const view = await host.rpc<SessionView>(root, "session_show", { sessionId: id });
    setState("sessions", key, "view", reconcile(view, { key: "id" }));
  } catch (error) {
    if (errorCode(error) !== "DAEMON_DOWN" && !/unknown session/.test(errorText(error))) {
      toast(errorText(error), { tone: "err" });
    }
  } finally {
    setState("sessions", key, "loading", false);
  }
}

/* ---------- navigation ---------- */

export function openSession(root: string, id: string): void {
  const current = { root, id };
  setState({ current, view: "session" });
  savePrefs({ last: current });
  const key = keyOf(root, id);
  if (!state.sessions[key]?.view) void loadSession(root, id);
}

export function goNew(root?: string): void {
  if (state.projects.length === 0) {
    setState({ view: "welcome" });
    return;
  }
  setState({
    view: "new",
    newRoot: root ?? state.current?.root ?? state.newRoot ?? state.projects[0]?.path ?? null,
  });
}

/** `envId`: the environment of a new project, else `defaultEnv`, written before its daemon starts and reads it. */
export async function addProject(path: string, envId?: string): Promise<void> {
  try {
    const p = await host.addProject(path);
    const known = state.projects.some((x) => x.path === p.path);
    // A folder opened again keeps its environment; a new one gets the given one, else the default.
    const env = known ? undefined : state.prefs.envs.find((e) => e.id === (envId ?? state.prefs.defaultEnv));
    if (env) {
      await host.setEnvironment(p.path, environmentLayer(env));
      savePrefs({ envOf: { ...state.prefs.envOf, [p.path]: env.id } });
    }
    if (!known) {
      setState("projects", state.projects.length, blankProject(p));
      void host.connect(p.path, (frame) => onFrame(p.path, frame));
    }
    setState({ view: "new", newRoot: p.path });
    toast(`Opened ${p.name}`);
  } catch (error) {
    toast(errorText(error), { tone: "err" });
  }
}

export async function newWorktree(root: string): Promise<void> {
  toast("Creating a worktree");
  const path = await host
    .worktreeCreate(root)
    .catch((error) => void toast(errorText(error), { tone: "err" }));
  // A worktree is the same project on another branch: it keeps the environment.
  if (path) await addProject(path, state.prefs.envOf[root]);
}

/* ---------- session actions ---------- */

export async function renameSession(root: string, id: string, title: string): Promise<void> {
  const text = title.trim();
  if (!text) return;
  try {
    await rpcWhenUp(root, "session_title_set", { sessionId: id, title: text });
    if (state.sessions[keyOf(root, id)]) setState("sessions", keyOf(root, id), "title", text);
    await refreshRows(root);
  } catch (error) {
    toast(errorText(error), { tone: "err" });
  }
}

export async function duplicateSession(root: string, id: string): Promise<void> {
  try {
    const { sessionId } = await rpcWhenUp<{ sessionId: string }>(root, "session_clone", { sessionId: id });
    const row = project(root)?.rows.find((r) => r.id === id);
    await rpcWhenUp(root, "session_title_set", { sessionId, title: `${sessionTitle(root, row, id)} (copy)` });
    await refreshRows(root);
    openSession(root, sessionId);
  } catch (error) {
    toast(errorText(error), { tone: "err" });
  }
}

export function archiveSession(root: string, id: string, on: boolean): void {
  const key = keyOf(root, id);
  const rest = state.prefs.archived.filter((k) => k !== key);
  savePrefs({ archived: on ? [...rest, key] : rest });
  toast(
    on ? "Archived" : "Moved back to sessions",
    on ? { act: { label: "Undo", run: () => archiveSession(root, id, false) } } : {},
  );
}

export async function deleteSession(root: string, id: string): Promise<void> {
  try {
    await rpcWhenUp(root, "session_delete", { sessionId: id });
  } catch (error) {
    toast(errorText(error), { tone: "err" });
    return;
  }
  const key = keyOf(root, id);
  savePrefs({ archived: state.prefs.archived.filter((k) => k !== key) });
  if (state.current?.root === root && state.current.id === id) goNew(root);
  setState("sessions", key, undefined as never);
  await refreshRows(root);
  toast("Deleted");
}

export async function removeProject(root: string): Promise<void> {
  await host.removeProject(root);
  setState(
    "projects",
    state.projects.filter((p) => p.path !== root),
  );
  if (state.current?.root === root) setState({ current: null });
  goNew();
}

export async function trustProject(root: string): Promise<void> {
  try {
    await host.trust(root);
    if (project(root)?.conn === "down") {
      patchProject(root, { untrusted: false, conn: "connecting", error: null });
      await host.restart(root);
      return;
    }
    // A daemon that runs, or still starts, read the trust at its start: it leaves once idle, and the host starts a
    // new one. A restart of the host during a start did nothing, and the folder stayed untrusted.
    await rpcWhenUp(root, "daemon_restart").catch(() => {});
  } catch (error) {
    toast(errorText(error), { tone: "err" });
  }
}

export async function restartDaemon(root: string): Promise<void> {
  patchProject(root, { conn: "connecting", error: null });
  await host.restart(root);
}

/* ---------- environments ---------- */

/** Writes the project's environment layer and restarts its daemon, which reads the layer at start. */
export async function applyEnvironment(root: string, id: string): Promise<void> {
  const env = state.prefs.envs.find((e) => e.id === id);
  try {
    await host.setEnvironment(root, environmentLayer(env));
    savePrefs({ envOf: { ...state.prefs.envOf, [root]: env ? env.id : "" } });
    if (project(root)?.conn === "up") await host.rpc(root, "daemon_restart");
  } catch (error) {
    toast(errorText(error), { tone: "err" });
  }
}

/* ---------- models ---------- */

export interface ModelChoice {
  ref: string;
  provider: string;
  model: string;
  label: string;
  desc: string;
  contextWindow: number;
  thinking: boolean;
  efforts?: Effort[];
  free: boolean;
  /** Dollars for a million input tokens, when the catalog knows it. */
  inputPerMTok?: number;
}

type CatalogModel = ProvidersList["all"][number]["models"][number];

/** The levels the catalog lists for the model. Without a list, the levels the provider's API distinguishes:
 *  OpenAI-style APIs stop at high, so max would send high. */
export function effortsOf(m: ModelChoice | undefined): Effort[] {
  if (!m?.thinking) return [];
  if (m.efforts) return m.efforts;
  return m.provider === "anthropic" || m.provider === "google"
    ? ["low", "medium", "high", "max"]
    : ["low", "medium", "high"];
}

/** The saved effort, else the nearest lower level the model has, else its lowest. */
export function effortFor(m: ModelChoice | undefined): Effort | undefined {
  const levels = effortsOf(m);
  const at = EFFORT_ORDER.indexOf(state.prefs.effort);
  return levels.filter((l) => EFFORT_ORDER.indexOf(l) <= at).at(-1) ?? levels[0];
}

const choiceCache = new WeakMap<object, { config: unknown; list: ModelChoice[] }>();

/** Models of connected providers, the configured default first, then each provider's default and newest.
 *  From providers_list: models_list holds only a built-in few, with no OpenRouter model. */
export function modelChoices(root: string | null | undefined): ModelChoice[] {
  const p = project(root);
  if (!p?.providers) return [];
  const hit = choiceCache.get(p.providers);
  if (hit && hit.config === p.config) return hit.list;
  const connected = new Set(p.providers.connected);
  const all = p.providers.all;
  const names = new Map(all.map((x) => [x.id, x.name]));
  const custom = (p.config?.provider ?? {}) as Record<
    string,
    { models?: Record<string, { contextWindow?: number }> }
  >;
  const out = new Map<string, ModelChoice>();
  const add = (provider: string, m: CatalogModel) => {
    const ref = `${provider}/${m.id}`;
    if (out.has(ref)) return;
    out.set(ref, {
      ref,
      provider,
      model: m.id,
      label: m.name || m.id,
      desc: names.get(provider) ?? provider,
      contextWindow: m.contextWindow,
      thinking: m.capabilities?.thinking ?? false,
      efforts: m.efforts,
      // A model of the user config has no price in the catalog: zero there means unknown, not free.
      free:
        m.id.endsWith(":free") ||
        (m.pricing?.inputPerMTok === 0 &&
          m.pricing?.outputPerMTok === 0 &&
          !custom[provider]?.models?.[m.id]),
      ...(m.pricing?.inputPerMTok ? { inputPerMTok: m.pricing.inputPerMTok } : {}),
    });
  };
  const configured = typeof p.config?.model === "string" ? p.config.model : undefined;
  if (configured?.includes("/")) {
    const [provider = "", ...rest] = configured.split("/");
    const model = rest.join("/");
    const known = all.find((x) => x.id === provider)?.models.find((m) => m.id === model);
    add(
      provider,
      known ?? { id: model, name: model, contextWindow: 200_000, capabilities: { thinking: true } },
    );
  }
  for (const x of all) {
    if (!connected.has(x.id)) continue;
    const live = x.models
      .filter((m) => m.status !== "deprecated")
      .sort((a, b) => (b.releaseDate ?? "").localeCompare(a.releaseDate ?? ""));
    const first = p.providers.default[x.id];
    for (const m of [...live.filter((m) => m.id === first), ...live]) add(x.id, m);
  }
  for (const [provider, def] of Object.entries(custom)) {
    for (const [model, meta] of Object.entries(def.models ?? {}))
      add(provider, { id: model, name: model, contextWindow: meta.contextWindow ?? 128_000 });
  }
  const list = [...out.values()];
  choiceCache.set(p.providers, { config: p.config, list });
  return list;
}

export function currentModel(root: string | null | undefined): ModelChoice | undefined {
  const choices = modelChoices(root);
  return choices.find((c) => c.ref === state.prefs.model) ?? choices[0];
}

export function pickModel(ref: string): void {
  savePrefs({ model: ref, recent: [ref, ...state.prefs.recent.filter((r) => r !== ref)].slice(0, 5) });
}

/* ---------- turns ---------- */

function blocksOf(attachments: Attachment[]): {
  text: string;
  images: { type: "image"; mimeType: string; data: string }[];
} {
  const files = attachments.filter((a) => a.kind === "text");
  const text = files.map((a) => `\n\n<file name="${a.name}">\n${a.data}\n</file>`).join("");
  const images = attachments
    .filter((a) => a.kind === "image")
    .map((a) => ({ type: "image" as const, mimeType: a.mimeType, data: a.data }));
  return { text, images };
}

/** Sends a prompt: a new turn, or steering text when the session already runs one. */
/** The end of each turn this window started, by session key. */
const settling = new Map<string, Promise<void>>();

export async function send(
  root: string,
  sessionId: string | null,
  text: string,
  attachments: Attachment[],
): Promise<void> {
  const model = currentModel(root);
  if (!model) {
    toast("Connect a provider in Settings to send.", { tone: "err" });
    return;
  }
  let id = sessionId;
  if (id === null) {
    try {
      id = (await host.rpc<{ sessionId: string }>(root, "session_create")).sessionId;
    } catch (error) {
      toast(errorText(error), { tone: "err" });
      return;
    }
    setState("sessions", keyOf(root, id), {
      view: null,
      loading: false,
      failure: null,
      title: text.slice(0, 80),
    });
    openSession(root, id);
  }
  const key = keyOf(root, id);
  // After the last answer a queued message would wait in the inbox for the next turn: start that turn instead.
  if (state.live[key]?.ending) await (settling.get(key) ?? new Promise((r) => setTimeout(r, 400)));
  const live = state.live[key];
  if (live) {
    const steer = await host
      .rpc<{ queued: boolean }>(root, "session_message", { sessionId: id, text })
      .catch((e) => {
        toast(errorText(e), { tone: "err" });
        return null;
      });
    if (steer?.queued === false) {
      // The turn already read its inbox for the last time: this text starts the next turn.
      await (settling.get(key) ?? new Promise((r) => setTimeout(r, 400)));
      if (!state.live[key]) return send(root, id, text, attachments);
    }
    if (!steer?.queued) return;
    setState(
      "live",
      key,
      "parts",
      produce((parts: Part[]) => {
        parts.push({ kind: "said", text });
      }),
    );
    return;
  }
  const turnId = crypto.randomUUID();
  const { text: files, images } = blocksOf(attachments);
  turnSessions.set(turnId, { root, id });
  let settled = () => {};
  settling.set(key, new Promise<void>((r) => (settled = r)));
  const view = state.sessions[key]?.view;
  batch(() => {
    setState("sessions", key, "failure", null);
    setState("live", key, {
      turnId,
      prompt: text,
      note: attachments.length ? `With ${attachments.map((a) => a.name).join(", ")}` : undefined,
      startedAt: Date.now(),
      baseTurns: view ? buildTurns(history(view.entries, view.tipId)).length : 0,
      parts: [],
      approval: null,
      tokens: 0,
      mine: true,
    });
  });
  refreshSoon(root, 600);
  try {
    const result = await host.rpc<SendResult>(root, "session_send", {
      sessionId: id,
      turnId,
      provider: model.provider,
      model: model.model,
      userText: text + files,
      ...(images.length ? { images } : {}),
      ...(effortFor(model) ? { thinkingLevel: effortFor(model) } : {}),
      permissionMode: state.prefs.mode,
    });
    if (result.error && !result.cancelled) {
      setState("sessions", key, "failure", {
        message: result.error.message,
        code: result.error.code,
        retry: { text, attachments },
      });
    }
  } catch (error) {
    setState("sessions", key, "failure", {
      message: errorText(error),
      code: errorCode(error),
      retry: { text, attachments },
    });
  } finally {
    flushDeltas();
    await loadSession(root, id);
    setState("live", key, undefined as never);
    endTurn(turnId);
    settling.delete(key);
    settled();
    refreshSoon(root);
    void refreshGit(root);
  }
}

export async function stop(root: string, sessionId: string): Promise<void> {
  const live = state.live[keyOf(root, sessionId)];
  if (!live) return;
  await host
    .rpc(root, "cancel_turn", { turnId: live.turnId })
    .catch((e) => toast(errorText(e), { tone: "err" }));
}

export async function respond(
  root: string,
  approval: Approval,
  decision: "once" | "always" | "reject",
): Promise<void> {
  const key = keyOf(root, approval.sessionId);
  setState("live", key, "approval", null);
  try {
    await host.rpc(root, "approval_respond", {
      requestId: approval.requestId,
      decision,
      sessionId: approval.sessionId,
    });
    if (decision === "always") toast(`Always allowed ${approval.request.tool} for this session`);
  } catch (error) {
    // The answer did not arrive: the ask still waits, so it comes back to be answered again.
    if (state.live[key] && !state.live[key].approval) setState("live", key, "approval", approval);
    toast(errorText(error), { tone: "err" });
  }
}

/** Rewinds to before a prompt (the last one when `entryId` is absent). `retry` sends the prompt again; else it goes
 *  back into the composer. */
export async function rewind(
  root: string,
  sessionId: string,
  entryId?: string,
  opts: { force?: boolean; retry?: boolean } = {},
): Promise<void> {
  let resend: string | undefined;
  try {
    const result = await host.rpc<{
      rewound: boolean;
      conflicts: string[];
      files?: string[];
      prompt?: string;
    }>(root, "session_rewind", {
      sessionId,
      ...(entryId ? { entryId } : {}),
      ...(opts.force ? { force: true } : {}),
    });
    if (!result.rewound) {
      const names = result.conflicts.map((f) => f.split(/[\\/]/).pop()).join(", ");
      toast(`You changed ${names} after the agent. Rewinding loses that change.`, {
        tone: "err",
        act: {
          label: "Rewind anyway",
          run: () => void rewind(root, sessionId, entryId, { ...opts, force: true }),
        },
      });
      return;
    }
    const n = result.files?.length ?? 0;
    if (opts.retry) resend = result.prompt ?? "";
    else {
      setState("composer", keyOf(root, sessionId), { draft: result.prompt ?? "", attachments: [] });
      toast(n ? `Rewound. ${n} file${n === 1 ? "" : "s"} put back.` : "Rewound.");
    }
  } catch (error) {
    toast(errorText(error), { tone: "err" });
  }
  await loadSession(root, sessionId);
  void refreshGit(root);
  refreshSoon(root);
  if (resend) await send(root, sessionId, resend, []);
}

/* ---------- derived ---------- */

export type RowState = "running" | "needs" | "failed" | "idle";

export function rowState(root: string, id: string): RowState {
  const key = keyOf(root, id);
  const live = state.live[key];
  if (live?.approval) return "needs";
  if (live) return "running";
  if (state.sessions[key]?.failure) return "failed";
  return "idle";
}

export function sessionTitle(root: string, row: SessionRow | undefined, id: string): string {
  return row?.title || state.sessions[keyOf(root, id)]?.title || "New session";
}

export function todosOf(view: SessionView | null): Todo[] {
  if (!view) return [];
  const entries = chain(view.entries, view.tipId);
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as Entry;
    if (e.type === "todo_state" && Array.isArray(e.todos)) return e.todos;
  }
  return [];
}

export function usageOf(view: SessionView | null): {
  tokens: number;
  costUsd: number;
  cached: number;
  input: number;
} {
  const out = { tokens: 0, costUsd: 0, cached: 0, input: 0 };
  if (!view) return out;
  for (const e of chain(view.entries, view.tipId)) {
    if (e.type !== "usage" || !e.usage) continue;
    // A cancelled or failed turn reports nothing: the context is still that of the turn before.
    // Entries older than contextTokens hold only the sum of the turn's requests.
    const size = e.contextTokens ?? e.usage.inputTokens;
    if (size > 0) out.tokens = size;
    out.input += e.usage.inputTokens;
    out.cached += e.usage.cachedInputTokens ?? 0;
    out.costUsd += typeof e.costUsd === "number" ? e.costUsd : (e.usage.costUsd ?? 0);
  }
  return out;
}

import { batch } from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import { type DaemonFrame, errorCode, errorText, type GitStatus, host, type Project } from "./host.ts";
import { addAssistant, chain, type Part, type Turn } from "./transcript.ts";
import type {
  Approval,
  Effort,
  Entry,
  ModelInfo,
  PermissionMode,
  ProvidersList,
  SendResult,
  SessionRow,
  SessionView,
  Todo,
} from "./types.ts";

export type ConnState = "connecting" | "up" | "down";
export type View = "welcome" | "new" | "session" | "review" | "skills" | "workflows";
export type Filter = "all" | "running" | "needs" | "done";
export type Theme = "light" | "dark" | "system";

export interface ProjectState extends Project {
  conn: ConnState;
  error: string | null;
  untrusted: boolean;
  rows: SessionRow[];
  git: GitStatus | null;
  models: ModelInfo[];
  providers: ProvidersList | null;
  config: Record<string, unknown> | null;
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
  parts: Part[];
  approval: Approval | null;
  tokens: number;
  mine: boolean;
  /** The model gave its last answer; the turn settles soon. */
  ending?: boolean;
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
  last: { root: string; id: string } | null;
}

const PREFS_KEY = "agency.prefs";

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
  };
  try {
    return { ...defaults, ...(JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<Prefs>) };
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

/** A write sent while the daemon restarts (after a config change) waits for it and goes once more. */
export async function rpcWhenUp<T>(
  root: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  try {
    return await host.rpc<T>(root, method, params);
  } catch (error) {
    if (errorCode(error) !== "DAEMON_DOWN") throw error;
    const end = Date.now() + 15_000;
    while (project(root)?.conn !== "up" && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    return host.rpc<T>(root, method, params);
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
            const last = parts.at(-1);
            if (last?.kind === "work") last.thinking.push(delta.thinking);
            else parts.push({ kind: "work", steps: [], thinking: [delta.thinking], startedAt: Date.now() });
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
            const step = part.steps.find((s) => s.id === data.id);
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
    case "turn_complete": {
      const usage = data.usage as { inputTokens?: number; cachedInputTokens?: number } | undefined;
      if (usage) setState("live", key, "tokens", (usage.inputTokens ?? 0) + (usage.cachedInputTokens ?? 0));
      if (data.stopReason !== "tool_use" && state.live[key]) setState("live", key, "ending", true);
      if (data.stopReason !== "tool_use" && !state.live[key]?.mine) {
        // A turn another client started has no promise here: its end is the last turn_complete.
        setTimeout(() => void finishForeign(root, sessionId, turnId), 300);
      }
      break;
    }
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
  const last = state.prefs.last;
  if (last && projects.some((p) => p.path === last.root)) {
    setState({ current: last, view: "session" });
  } else if (projects.length > 0) {
    setState({ view: "new", newRoot: projects[0]?.path ?? null });
  }
  setState("booted", true);
  for (const p of projects) void host.connect(p.path, (frame) => onFrame(p.path, frame));
  if (state.current) void loadSession(state.current.root, state.current.id);
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
    models: [],
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
      .rpc<{ models: ModelInfo[] }>(root, "models_list")
      .then((r) => patchProject(root, { models: r.models }))
      .catch(() => {}),
    host
      .rpc<ProvidersList>(root, "providers_list")
      .then((r) => patchProject(root, { providers: r }))
      .catch(() => {}),
    host
      .rpc<{ config: Record<string, unknown> }>(root, "config_get")
      .then((r) => patchProject(root, { config: r.config }))
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

export async function addProject(path: string): Promise<void> {
  try {
    const p = await host.addProject(path);
    if (!state.projects.some((x) => x.path === p.path)) {
      setState("projects", state.projects.length, blankProject(p));
      void host.connect(p.path, (frame) => onFrame(p.path, frame));
    }
    setState({ view: "new", newRoot: p.path });
    toast(`Opened ${p.name}`);
  } catch (error) {
    toast(errorText(error), { tone: "err" });
  }
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
    // A running daemon read the trust at start: it leaves once idle, and the host starts a new one.
    if (project(root)?.conn === "up") await host.rpc(root, "daemon_restart").catch(() => {});
    else {
      patchProject(root, { untrusted: false, conn: "connecting", error: null });
      await host.restart(root);
    }
  } catch (error) {
    toast(errorText(error), { tone: "err" });
  }
}

export async function restartDaemon(root: string): Promise<void> {
  patchProject(root, { conn: "connecting", error: null });
  await host.restart(root);
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
}

/** Models of connected providers, the configured default first. */
export function modelChoices(root: string | null | undefined): ModelChoice[] {
  const p = project(root);
  if (!p) return [];
  const connected = new Set(p.providers?.connected ?? []);
  const names = new Map((p.providers?.all ?? []).map((x) => [x.id, x.name]));
  const out = new Map<string, ModelChoice>();
  const add = (provider: string, model: string, label: string, contextWindow: number, thinking: boolean) => {
    const ref = `${provider}/${model}`;
    if (!out.has(ref)) {
      out.set(ref, {
        ref,
        provider,
        model,
        label,
        desc: names.get(provider) ?? provider,
        contextWindow,
        thinking,
      });
    }
  };
  const configured = typeof p.config?.model === "string" ? p.config.model : undefined;
  if (configured?.includes("/")) {
    const [provider, ...rest] = configured.split("/");
    const model = rest.join("/");
    const hit = p.models.find((m) => m.id === model);
    add(
      provider as string,
      model,
      hit?.name ?? model,
      hit?.contextWindow ?? 200_000,
      hit?.capabilities?.thinking ?? true,
    );
  }
  for (const m of p.models) {
    if (connected.has(m.family))
      add(m.family, m.id, m.name, m.contextWindow, m.capabilities?.thinking ?? false);
  }
  const custom = (p.config?.provider ?? {}) as Record<
    string,
    { models?: Record<string, { contextWindow?: number }> }
  >;
  for (const [provider, def] of Object.entries(custom)) {
    for (const [model, meta] of Object.entries(def.models ?? {}))
      add(provider, model, model, meta.contextWindow ?? 128_000, false);
  }
  return [...out.values()];
}

export function currentModel(root: string | null | undefined): ModelChoice | undefined {
  const choices = modelChoices(root);
  return choices.find((c) => c.ref === state.prefs.model) ?? choices[0];
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
        parts.push({ kind: "note", text: `You: ${text}` });
      }),
    );
    return;
  }
  const turnId = crypto.randomUUID();
  const { text: files, images } = blocksOf(attachments);
  turnSessions.set(turnId, { root, id });
  let settled = () => {};
  settling.set(key, new Promise<void>((r) => (settled = r)));
  batch(() => {
    setState("sessions", key, "failure", null);
    setState("live", key, {
      turnId,
      prompt: text,
      note: attachments.length ? `With ${attachments.map((a) => a.name).join(", ")}` : undefined,
      startedAt: Date.now(),
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
      ...(model.thinking ? { thinkingLevel: state.prefs.effort } : {}),
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
    toast(errorText(error), { tone: "err" });
  }
}

export async function undoTurn(root: string, sessionId: string): Promise<void> {
  try {
    const result = await host.rpc<{ undone: boolean; reason?: string }>(root, "undo_run", {
      sessionId,
      mode: "both",
    });
    if (!result.undone) {
      toast(result.reason ?? "Nothing to undo.", { tone: "err" });
      return;
    }
    toast("Undid the last turn");
  } catch (error) {
    toast(errorText(error), { tone: "err" });
  }
  await loadSession(root, sessionId);
  void refreshGit(root);
  refreshSoon(root);
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
    out.tokens = e.usage.inputTokens + (e.usage.cachedInputTokens ?? 0);
    out.input += e.usage.inputTokens + (e.usage.cachedInputTokens ?? 0);
    out.cached += e.usage.cachedInputTokens ?? 0;
    out.costUsd += typeof e.costUsd === "number" ? e.costUsd : (e.usage.costUsd ?? 0);
  }
  return out;
}

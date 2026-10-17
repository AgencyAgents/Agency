import {
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js";
import { createStore, produce } from "solid-js/store";
import { errorText } from "../lib/host.ts";
import { keyOf, loadSession, openSession, state, toast } from "../lib/store.ts";
import {
  buildTurns,
  chain,
  describeStep,
  duration,
  stepIconPath,
  type ToolStep,
  toolsOf,
} from "../lib/transcript.ts";
import {
  agentInfo,
  agentsOf,
  deleteWorkflow,
  isLoaded,
  liveRunOf,
  loadWorkflows,
  type Run,
  type RunStatus,
  type RunStep,
  runsOf,
  type StepState,
  saveWorkflow,
  since,
  slug,
  startRun,
  startTriggers,
  stopRun,
  TRIGGERS,
  type Trigger,
  took,
  trigger,
  type Workflow,
  workflowsOf,
} from "../lib/workflows.ts";
import { I, P, Spinner } from "./icons.tsx";
import { Markdown } from "./Markdown.tsx";
import {
  Box,
  EditFrame,
  Empty,
  Group,
  ItemHead,
  NoProject,
  PageBar,
  PageHead,
  Row,
  titleStyle,
} from "./page.tsx";
import { Toast } from "./SessionView.tsx";

/* ---------- navigation and shared state ---------- */

type Nav =
  | { page: "home" }
  | { page: "wf"; id: string }
  | { page: "run"; id: string; runId: string }
  | { page: "edit"; id: string | null };

// Module level: leaving the view for a session and coming back lands on the same page.
const [nav, go] = createSignal<Nav>({ page: "home" });
const [picked, setPicked] = createSignal<string | null>(null);
const [query, setQuery] = createSignal("");
const [now, setNow] = createSignal(Date.now());
const ago = (ms: number) => since(ms, now());

const root = (): string | null => {
  const p = picked();
  if (p && state.projects.some((x) => x.path === p)) return p;
  return state.current?.root ?? state.newRoot ?? state.projects[0]?.path ?? null;
};

interface Draft {
  id: string | null;
  name: string;
  desc: string;
  trigger: Trigger;
  steps: { agent: string; text: string }[];
  tried: boolean;
}
const [draft, setDraft] = createStore<Draft>({
  id: null,
  name: "",
  desc: "",
  trigger: "manual",
  steps: [],
  tried: false,
});

function openEditor(r: string, w: Workflow | null): void {
  setDraft({
    id: w?.id ?? null,
    name: w?.name ?? "",
    desc: w?.desc ?? "",
    trigger: w?.trigger ?? "manual",
    steps: w ? w.steps.map((s) => ({ ...s })) : [{ agent: agentsOf(r)[0]?.name ?? "default", text: "" }],
    tried: false,
  });
  go({ page: "edit", id: w?.id ?? null });
}

/* ---------- small pieces ---------- */

const statusWord: Record<RunStatus, string> = {
  running: "Running",
  passed: "Passed",
  failed: "Failed",
  stopped: "Stopped",
};
const statusColor = (s: RunStatus | undefined): string =>
  s === "running"
    ? "var(--accent)"
    : s === "passed"
      ? "var(--green-fill)"
      : s === "failed"
        ? "var(--red-fill)"
        : s === "stopped"
          ? "var(--faint)"
          : "var(--track)";

function Dot(props: { status?: RunStatus; size?: number }) {
  const size = () => `${props.size ?? 7}px`;
  return (
    <span
      role="img"
      aria-label={props.status ? statusWord[props.status] : "Not run"}
      style={{
        width: size(),
        height: size(),
        flex: "none",
        "border-radius": "50%",
        background: statusColor(props.status),
      }}
    />
  );
}

function RunIcon(props: { status: RunStatus }) {
  return (
    <Switch>
      <Match when={props.status === "passed"}>
        <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" style={{ flex: "none" }}>
          <circle cx="12" cy="12" r="10" fill="var(--green-fill)" />
          <path
            d="m7.5 12.5 3 3 6-6.5"
            fill="none"
            stroke="#FFFFFF"
            stroke-width="2.4"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </Match>
      <Match when={props.status === "failed"}>
        <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" style={{ flex: "none" }}>
          <circle cx="12" cy="12" r="10" fill="var(--red-fill)" />
          <path d="M8.5 8.5l7 7M15.5 8.5l-7 7" stroke="#FFFFFF" stroke-width="2.4" stroke-linecap="round" />
        </svg>
      </Match>
      <Match when={props.status === "stopped"}>
        <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" style={{ flex: "none" }}>
          <circle cx="12" cy="12" r="9.2" fill="none" stroke="var(--faint)" stroke-width="1.6" />
          <rect x="9" y="9" width="6" height="6" rx="1" fill="var(--faint)" />
        </svg>
      </Match>
      <Match when={props.status === "running"}>
        <Spinner size={14} />
      </Match>
    </Switch>
  );
}

const stepDot = (s: StepState): JSX.CSSProperties => {
  const fill = s === "done" ? "var(--green-fill)" : s === "fail" ? "var(--red-fill)" : undefined;
  return {
    width: "24px",
    height: "24px",
    "border-radius": "12px",
    display: "flex",
    "align-items": "center",
    "justify-content": "center",
    flex: "none",
    "box-sizing": "border-box",
    background: fill ?? "var(--bg)",
    border: `1px solid ${fill ?? (s === "now" ? "var(--accent-ring-2)" : "var(--line-strong)")}`,
  };
};

function StepMark(props: { state: StepState; n: number }) {
  return (
    <span style={stepDot(props.state)}>
      <Switch fallback={<span style={{ "font-size": "12px", color: "var(--text-2)" }}>{props.n}</span>}>
        <Match when={props.state === "done"}>
          <I d={P.check} size={12} sw={3} stroke="#FFFFFF" />
        </Match>
        <Match when={props.state === "fail"}>
          <I d="M7 7l10 10M17 7 7 17" size={12} sw={3} stroke="#FFFFFF" />
        </Match>
        <Match when={props.state === "now"}>
          <Spinner size={13} />
        </Match>
      </Switch>
    </span>
  );
}

function Rail(props: { show: boolean }) {
  return (
    <Show when={props.show}>
      <span
        style={{ flex: 1, width: "1px", "min-height": "16px", background: "var(--line)", margin: "4px 0" }}
      />
    </Show>
  );
}

const sectionBox: JSX.CSSProperties = {
  border: "1px solid var(--line-soft)",
  "border-radius": "12px",
  overflow: "hidden",
};
const Chev = () => <I d="m9 6 6 6-6 6" size={12} sw={2} stroke="var(--muted-2)" />;

/* ---------- home ---------- */

function Home(props: { root: string }) {
  const all = () => workflowsOf(props.root);
  const shown = createMemo(() => {
    const q = query().trim().toLowerCase();
    return all().filter((w) => !q || `${w.name} ${w.desc}`.toLowerCase().includes(q));
  });
  const groups = createMemo(() =>
    TRIGGERS.map((t) => ({ title: t.label, rows: shown().filter((w) => w.trigger === t.id) })).filter(
      (g) => g.rows.length > 0,
    ),
  );
  const create = () => openEditor(props.root, null);
  return (
    <div class="page pad">
      <PageHead
        title="Workflows"
        sub="A workflow chains agents into steps. Each step gets the report of the one before it."
        search="Search workflows"
        query={query()}
        setQuery={setQuery}
        add="New workflow"
        onAdd={create}
      />

      <Show when={isLoaded(props.root)}>
        <For each={groups()}>
          {(g) => (
            <Group title={g.title} count={g.rows.length}>
              <For each={g.rows}>{(w) => <Card root={props.root} w={w} />}</For>
            </Group>
          )}
        </For>
        <Show when={shown().length === 0}>
          <Empty
            title={all().length === 0 ? "No workflows yet" : "No workflow matches"}
            text={
              all().length === 0
                ? "Name the steps once, then run them by hand, on each commit or every night."
                : undefined
            }
          >
            <button type="button" class="ol" onClick={create} style={{ "margin-top": "4px" }}>
              New workflow
            </button>
          </Empty>
        </Show>
      </Show>
    </div>
  );
}

function Card(props: { root: string; w: Workflow }) {
  const live = () => liveRunOf(props.root, props.w.id);
  const last = () => runsOf(props.root, props.w.id).find((r) => r.status !== "running");
  const active = () => live()?.steps.findIndex((s) => s.state === "now") ?? -1;
  const text = () => {
    const l = live();
    if (l) return `Running step ${Math.max(0, active()) + 1} of ${l.steps.length}`;
    const r = last();
    return r ? `${statusWord[r.status]}, ${ago(r.endedAt ?? r.startedAt)}` : "Not run yet";
  };
  return (
    <Row
      icon={trigger(props.w.trigger).icon}
      name={props.w.name}
      line={props.w.desc || "No description yet."}
      open={() => go({ page: "wf", id: props.w.id })}
      note={
        <>
          <span
            class="hide-sm"
            style={{
              flex: "none",
              "max-width": "200px",
              display: "flex",
              "align-items": "center",
              "justify-content": "flex-end",
              gap: "4px",
              overflow: "hidden",
            }}
          >
            <For each={props.w.steps}>
              {(s, i) => (
                <>
                  <Show when={i() > 0}>
                    <I d="m9 6 6 6-6 6" size={10} sw={2.4} stroke="var(--disabled)" />
                  </Show>
                  <span
                    style={{
                      height: "22px",
                      display: "inline-flex",
                      "align-items": "center",
                      padding: "0 8px",
                      "border-radius": "6px",
                      "font-size": "12px",
                      background: i() === active() ? "var(--accent-soft)" : "var(--fill)",
                      color: i() === active() ? "var(--accent-text)" : "var(--text-2)",
                      "font-weight": i() === active() ? 600 : 400,
                    }}
                  >
                    {s.agent}
                  </span>
                </>
              )}
            </For>
          </span>
          <span
            style={{
              width: "172px",
              flex: "none",
              display: "flex",
              "align-items": "center",
              gap: "6px",
              color: "var(--muted-2)",
              "font-size": "12px",
            }}
          >
            <Dot status={live() ? "running" : last()?.status} />
            <span class="ell">{text()}</span>
          </span>
        </>
      }
    >
      <Show
        when={live()}
        fallback={
          <button
            type="button"
            class="ic"
            aria-label={`Run ${props.w.name}`}
            title="Run now"
            onClick={() => void startRun(props.root, props.w)}
          >
            <I d="M8 5.5v13l10-6.5Z" size={15} sw={1.7} />
          </button>
        }
      >
        {(l) => (
          <button
            type="button"
            class="ol"
            aria-label={`Stop ${props.w.name}`}
            disabled={l().stopping}
            onClick={() => stopRun(props.root, props.w.id)}
            style={{ height: "28px", padding: "0 10px", gap: "6px" }}
          >
            <Spinner size={12} />
            Stop
          </button>
        )}
      </Show>
    </Row>
  );
}

/* ---------- workflow page ---------- */

function Detail(props: { root: string; w: Workflow }) {
  const live = () => liveRunOf(props.root, props.w.id);
  const past = () => runsOf(props.root, props.w.id).filter((r) => r.status !== "running");
  const n = () => props.w.steps.length;
  const active = () => live()?.steps.findIndex((s) => s.state === "now") ?? -1;
  const progress = () =>
    live() ? `Step ${Math.max(0, active()) + 1} of ${n()}` : `${n()} ${n() === 1 ? "agent" : "agents"}`;
  const run = async () => {
    const id = await startRun(props.root, props.w);
    if (id) go({ page: "run", id: props.w.id, runId: id });
  };
  return (
    <div class="page pad">
      <ItemHead
        icon={trigger(props.w.trigger).icon}
        name={props.w.name}
        line={props.w.desc || "No description yet."}
        meta={trigger(props.w.trigger).line}
      >
        <button type="button" class="ol" disabled={!!live()} onClick={() => openEditor(props.root, props.w)}>
          Edit
        </button>
        <Show
          when={live()}
          fallback={
            <button type="button" class="pri" onClick={() => void run()}>
              Run now
            </button>
          }
        >
          {(l) => (
            <button
              type="button"
              class="pri"
              disabled={l().stopping}
              onClick={() => stopRun(props.root, props.w.id)}
            >
              Stop
            </button>
          )}
        </Show>
      </ItemHead>

      <Box title="Steps" right={progress()}>
        <ol
          style={{
            "list-style": "none",
            margin: 0,
            padding: "16px 16px 0",
            display: "flex",
            "flex-direction": "column",
          }}
        >
          <For each={props.w.steps}>
            {(s, i) => {
              const st = (): StepState => live()?.steps[i()]?.state ?? "wait";
              return (
                <li style={{ display: "flex", gap: "14px" }}>
                  <div
                    style={{
                      display: "flex",
                      "flex-direction": "column",
                      "align-items": "center",
                      width: "24px",
                      flex: "none",
                    }}
                  >
                    <StepMark state={st()} n={i() + 1} />
                    <Rail show={i() < n() - 1} />
                  </div>
                  <div
                    style={{
                      flex: 1,
                      "min-width": 0,
                      padding: "2px 0 20px",
                      display: "flex",
                      "flex-direction": "column",
                      gap: "2px",
                    }}
                  >
                    <div style={{ display: "flex", "align-items": "baseline", gap: "8px" }}>
                      <span style={{ "font-weight": 600 }}>{s.agent}</span>
                      <span style={{ color: "var(--muted)" }}>{agentInfo(props.root, s.agent).label}</span>
                      <span style={{ flex: 1 }} />
                      <Show when={live()}>
                        <span style={{ color: st() === "now" ? "var(--accent-text)" : "var(--muted)" }}>
                          {
                            {
                              done: "Done",
                              now: "Running",
                              wait: "Waiting",
                              skip: "Skipped",
                              stop: "Stopped",
                              fail: "Failed",
                            }[st()]
                          }
                        </span>
                      </Show>
                    </div>
                    <p style={{ margin: 0, color: "var(--text-2)", "white-space": "pre-wrap" }}>
                      {s.text || "No instruction yet."}
                    </p>
                  </div>
                </li>
              );
            }}
          </For>
        </ol>
      </Box>

      <Box title="Recent runs">
        <Show when={live()}>
          {(l) => (
            <RunRow
              onClick={() => go({ page: "run", id: props.w.id, runId: l().id })}
              label="Open the running run"
              status="running"
              word={`Running step ${Math.max(0, active()) + 1} of ${n()}`}
              when="Now"
              took=""
            />
          )}
        </Show>
        <For each={past()}>
          {(r) => (
            <RunRow
              onClick={() => go({ page: "run", id: props.w.id, runId: r.id })}
              label={`Open run, ${statusWord[r.status]}, ${ago(r.startedAt)}`}
              status={r.status}
              word={statusWord[r.status]}
              when={ago(r.startedAt)}
              took={took(r)}
            />
          )}
        </For>
        <Show when={!live() && past().length === 0}>
          <p style={{ margin: 0, padding: "14px 16px", color: "var(--muted)" }}>Not run yet.</p>
        </Show>
      </Box>
    </div>
  );
}

function RunRow(props: {
  onClick: () => void;
  label: string;
  status: RunStatus;
  word: string;
  when: string;
  took: string;
}) {
  return (
    <button
      type="button"
      class="hov-row"
      onClick={props.onClick}
      aria-label={props.label}
      style={{
        width: "100%",
        display: "flex",
        "align-items": "center",
        gap: "10px",
        height: "40px",
        padding: "0 16px",
        border: 0,
        "border-bottom": "1px solid var(--line-soft)",
        background: "transparent",
        font: "inherit",
        color: "inherit",
        "text-align": "left",
      }}
    >
      <RunIcon status={props.status} />
      <span style={{ "font-weight": 500 }}>{props.word}</span>
      <span style={{ flex: 1 }} />
      <span style={{ color: "var(--muted)" }}>{props.when}</span>
      <span style={{ color: "var(--muted)", width: "56px", "text-align": "right" }}>{props.took}</span>
      <Chev />
    </button>
  );
}

/* ---------- run page ---------- */

const tried = new Set<string>();

function workOf(r: string, sessionId: string | undefined): ToolStep[] {
  if (!sessionId) return [];
  const key = keyOf(r, sessionId);
  const live = state.live[key];
  const view = state.sessions[key]?.view;
  const parts = live
    ? live.parts
    : view
      ? buildTurns(chain(view.entries, view.tipId)).flatMap((t) => t.parts)
      : [];
  return parts.flatMap((p) => (p.kind === "work" ? toolsOf(p) : []));
}

function RunPage(props: { root: string; w: Workflow; run: Run }) {
  const live = () => props.run.status === "running";
  const active = () => props.run.steps.findIndex((s) => s.state === "now");
  const again = async () => {
    const id = await startRun(props.root, props.w);
    const next = id ?? liveRunOf(props.root, props.w.id)?.id;
    if (next) go({ page: "run", id: props.w.id, runId: next });
  };
  const summary = () => {
    const r = props.run;
    if (live()) return `Running step ${Math.max(0, active()) + 1} of ${r.steps.length}`;
    const t = took(r);
    return `${statusWord[r.status]}, ${ago(r.startedAt)}${t ? `. Took ${t}.` : "."}`;
  };
  return (
    <div class="page pad">
      <div style={{ display: "flex", "align-items": "flex-start", gap: "16px", "flex-wrap": "wrap" }}>
        <div
          style={{ flex: 1, "min-width": "220px", display: "flex", "flex-direction": "column", gap: "6px" }}
        >
          <h2 style={titleStyle}>{props.w.name}</h2>
          <span style={{ display: "flex", "align-items": "center", gap: "8px", color: "var(--muted)" }}>
            <Dot status={props.run.status} size={8} />
            {summary()}
          </span>
        </div>
        <Show
          when={live()}
          fallback={
            <button type="button" class="ol" onClick={() => void again()}>
              Run again
            </button>
          }
        >
          <button
            type="button"
            class="ol"
            disabled={props.run.stopping}
            onClick={() => stopRun(props.root, props.w.id)}
          >
            Stop
          </button>
        </Show>
      </div>
      <ol
        aria-label="Steps of this run"
        style={{ "list-style": "none", margin: 0, padding: 0, display: "flex", "flex-direction": "column" }}
      >
        <For each={props.run.steps}>
          {(s, i) => <RunStepItem root={props.root} run={props.run} step={s} i={i()} />}
        </For>
      </ol>
    </div>
  );
}

function RunStepItem(props: { root: string; run: Run; step: RunStep; i: number }) {
  const s = () => props.step;
  const last = () => props.i === props.run.steps.length - 1;
  const ran = () => s().state === "done" || s().state === "fail";
  const elapsed = () => {
    const { startedAt, endedAt } = s();
    return startedAt !== undefined && endedAt !== undefined ? duration(endedAt - startedAt) : "";
  };

  createEffect(() => {
    const sid = s().sessionId;
    if (!sid || s().state === "now" || s().state === "wait") return;
    const key = keyOf(props.root, sid);
    if (state.sessions[key]?.view || state.live[key] || tried.has(key)) return;
    tried.add(key);
    void loadSession(props.root, sid);
  });

  const work = createMemo(() => workOf(props.root, s().sessionId));
  const doing = () => {
    const sid = s().sessionId;
    if (sid && state.live[keyOf(props.root, sid)]?.approval) return "Waiting for your approval";
    if (props.run.stopping) return "Stopping";
    const tool = work().at(-1);
    return tool ? describeStep(tool).text : "Working on the instruction";
  };
  const label = () =>
    ({
      done: elapsed() || "Done",
      now: props.run.stopping ? "Stopping" : "Running",
      wait: "Waiting",
      skip: "Skipped",
      stop: "Stopped",
      fail: "Failed",
    })[s().state];

  return (
    <li style={{ display: "flex", gap: "14px" }}>
      <div
        style={{
          display: "flex",
          "flex-direction": "column",
          "align-items": "center",
          width: "24px",
          flex: "none",
        }}
      >
        <StepMark state={s().state} n={props.i + 1} />
        <Rail show={!last()} />
      </div>
      <div
        style={{
          flex: 1,
          "min-width": 0,
          "padding-bottom": last() ? 0 : "28px",
          display: "flex",
          "flex-direction": "column",
          gap: "12px",
        }}
      >
        <div style={{ display: "flex", "align-items": "center", gap: "8px", "min-height": "24px" }}>
          <span style={{ "font-weight": 600 }}>{s().agent}</span>
          <span style={{ color: "var(--muted)" }}>{s().model}</span>
          <span style={{ flex: 1 }} />
          <Show when={s().sessionId}>
            {(sid) => (
              <button type="button" class="link" onClick={() => openSession(props.root, sid())}>
                Open session
              </button>
            )}
          </Show>
          <span
            style={{
              "font-size": "13px",
              color:
                s().state === "now"
                  ? "var(--accent-text)"
                  : s().state === "fail"
                    ? "var(--red)"
                    : "var(--muted)",
            }}
          >
            {label()}
          </span>
        </div>
        <div
          style={{
            "font-size": "13px",
            "line-height": 1.5,
            color: "var(--text-2)",
            background: "var(--fill-2)",
            "border-radius": "10px",
            padding: "8px 12px",
            "white-space": "pre-wrap",
          }}
        >
          {s().text || "No instruction yet."}
        </div>
        <Show when={ran() || s().state === "stop"}>
          <div style={{ display: "flex", "flex-direction": "column", gap: "12px" }}>
            <Show when={work().length > 0}>
              <details>
                <summary
                  style={{
                    display: "inline-flex",
                    "align-items": "center",
                    gap: "4px",
                    color: "var(--muted)",
                    "font-size": "13px",
                  }}
                >
                  {elapsed() ? `Worked for ${elapsed()}` : "Worked"}
                  <I class="chev" d="m9 6 6 6-6 6" size={11} sw={2.2} />
                </summary>
                <ul
                  style={{
                    "list-style": "none",
                    margin: "10px 0 0",
                    padding: 0,
                    display: "flex",
                    "flex-direction": "column",
                    gap: "6px",
                    color: "var(--muted)",
                    "font-size": "13px",
                  }}
                >
                  <For each={work()}>
                    {(tool) => {
                      const d = describeStep(tool);
                      return (
                        <li style={{ display: "flex", "align-items": "center", gap: "10px" }}>
                          <I d={stepIconPath(d.icon)} size={15} />
                          <span class="ell">{d.text}</span>
                        </li>
                      );
                    }}
                  </For>
                </ul>
              </details>
            </Show>
            <Show when={s().reply}>
              {(reply) => (
                <div style={{ "font-size": "15px", "line-height": 1.6 }}>
                  <Markdown text={reply()} />
                </div>
              )}
            </Show>
            <Show when={s().state === "fail"}>
              <fieldset
                aria-label="Step failed"
                style={{
                  margin: 0,
                  "min-width": 0,
                  border: "1px solid var(--line)",
                  "border-radius": "12px",
                  padding: "12px 14px",
                  display: "flex",
                  gap: "10px",
                  "font-size": "13px",
                }}
              >
                <RunIcon status="failed" />
                <div style={{ display: "flex", "flex-direction": "column", gap: "2px", "min-width": 0 }}>
                  <span style={{ "font-weight": 600 }}>The step failed</span>
                  <span style={{ color: "var(--muted)", "overflow-wrap": "anywhere" }}>
                    {s().error || "The agent stopped with an error."}
                  </span>
                </div>
              </fieldset>
            </Show>
          </div>
        </Show>
        <Show when={s().state === "now"}>
          <span class="shimmer" style={{ "align-self": "flex-start", "font-size": "13px" }}>
            {doing()}
          </span>
        </Show>
      </div>
    </li>
  );
}

/* ---------- editor ---------- */

function Editor(props: { root: string }) {
  const [saving, setSaving] = createSignal(false);
  const bad = () => draft.tried && !draft.name.trim();
  const agents = () => {
    const names = agentsOf(props.root).map((a) => a.name);
    for (const s of draft.steps) if (!names.includes(s.agent)) names.push(s.agent);
    return names;
  };
  const existing = () => (draft.id ? workflowsOf(props.root).find((w) => w.id === draft.id) : undefined);
  const back = () => go(draft.id ? { page: "wf", id: draft.id } : { page: "home" });

  const move = (i: number, by: number) =>
    setDraft(
      "steps",
      produce((a) => {
        const other = a[i + by];
        const mine = a[i];
        if (other && mine) {
          a[i] = other;
          a[i + by] = mine;
        }
      }),
    );

  const save = async (e: SubmitEvent) => {
    e.preventDefault();
    if (!draft.name.trim()) {
      setDraft("tried", true);
      return;
    }
    const w: Workflow = {
      id:
        draft.id ??
        slug(
          draft.name,
          workflowsOf(props.root).map((x) => x.id),
        ),
      name: draft.name.trim(),
      desc: draft.desc.trim(),
      trigger: draft.trigger,
      steps: draft.steps.map((s) => ({ agent: s.agent, text: s.text.trim() })),
    };
    setSaving(true);
    try {
      await saveWorkflow(props.root, w);
      toast(`Saved ${w.name}`);
      go({ page: "wf", id: w.id });
    } catch (error) {
      toast(errorText(error), { tone: "err" });
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    const old = existing();
    if (!old) return;
    const copy = JSON.parse(JSON.stringify(old)) as Workflow;
    try {
      await deleteWorkflow(props.root, old.id);
    } catch (error) {
      toast(errorText(error), { tone: "err" });
      return;
    }
    go({ page: "home" });
    toast(`Deleted ${old.name}`, {
      act: {
        label: "Undo",
        run: () =>
          void saveWorkflow(props.root, copy).catch((error) => toast(errorText(error), { tone: "err" })),
      },
    });
  };

  return (
    <EditFrame
      title={draft.id ? "Edit workflow" : "New workflow"}
      submit={(e) => void save(e)}
      preview={
        <Box title="Preview" right={`${draft.steps.length} ${draft.steps.length === 1 ? "step" : "steps"}`}>
          <div style={{ padding: "16px", display: "flex", "flex-direction": "column", gap: "4px" }}>
            <span style={{ "font-weight": 600, "overflow-wrap": "anywhere" }}>
              {draft.name.trim() || "Untitled workflow"}
            </span>
            <span style={{ color: "var(--muted)" }}>{trigger(draft.trigger).line}</span>
          </div>
          <ol
            style={{
              "list-style": "none",
              margin: 0,
              padding: "0 16px 6px",
              display: "flex",
              "flex-direction": "column",
            }}
          >
            <For each={draft.steps}>
              {(st, i) => (
                <li style={{ display: "flex", gap: "12px" }}>
                  <div
                    style={{
                      display: "flex",
                      "flex-direction": "column",
                      "align-items": "center",
                      width: "22px",
                      flex: "none",
                    }}
                  >
                    <span
                      style={{
                        width: "22px",
                        height: "22px",
                        "border-radius": "11px",
                        border: "1px solid var(--line-strong)",
                        display: "flex",
                        "align-items": "center",
                        "justify-content": "center",
                        "font-size": "11.5px",
                        "box-sizing": "border-box",
                      }}
                    >
                      {i() + 1}
                    </span>
                    <Show when={i() < draft.steps.length - 1}>
                      <span
                        style={{
                          flex: 1,
                          width: "1px",
                          "min-height": "12px",
                          background: "var(--line)",
                          margin: "3px 0",
                        }}
                      />
                    </Show>
                  </div>
                  <div
                    style={{
                      flex: 1,
                      "min-width": 0,
                      padding: "1px 0 14px",
                      display: "flex",
                      "flex-direction": "column",
                      gap: "1px",
                    }}
                  >
                    <span>
                      <span style={{ "font-weight": 600 }}>{st.agent}</span>{" "}
                      <span style={{ color: "var(--muted)" }}>{agentInfo(props.root, st.agent).label}</span>
                    </span>
                    <span
                      style={{
                        color: "var(--muted)",
                        display: "-webkit-box",
                        "-webkit-line-clamp": 2,
                        "-webkit-box-orient": "vertical",
                        overflow: "hidden",
                        "overflow-wrap": "anywhere",
                      }}
                    >
                      {st.text.trim() || "No instruction yet."}
                    </span>
                  </div>
                </li>
              )}
            </For>
          </ol>
        </Box>
      }
    >
      <label style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
        <span style={{ "font-weight": 500 }}>Name</span>
        <input
          type="text"
          class="field"
          value={draft.name}
          placeholder="Fix failing checks"
          aria-invalid={bad()}
          onInput={(e) => setDraft("name", e.currentTarget.value)}
        />
        <Show when={bad()}>
          <span style={{ color: "var(--red)" }}>Give the workflow a name.</span>
        </Show>
      </label>
      <label style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
        <span style={{ "font-weight": 500 }}>Description</span>
        <input
          type="text"
          class="field"
          value={draft.desc}
          placeholder="What the workflow does, in one line"
          onInput={(e) => setDraft("desc", e.currentTarget.value)}
        />
      </label>
      <div style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
        <span style={{ "font-weight": 500 }}>Runs</span>
        <div class="seg" role="radiogroup" aria-label="Trigger" style={{ "align-self": "flex-start" }}>
          <For each={TRIGGERS}>
            {(t) => (
              // biome-ignore lint/a11y/useSemanticElements: .seg styles button[aria-checked]
              <button
                type="button"
                role="radio"
                aria-checked={draft.trigger === t.id}
                onClick={() => setDraft("trigger", t.id)}
              >
                {t.label}
              </button>
            )}
          </For>
        </div>
        <Show when={draft.trigger !== "manual"}>
          <span style={{ color: "var(--muted)" }}>Runs while Agency is open.</span>
        </Show>
      </div>
      <div style={{ display: "flex", "flex-direction": "column", gap: "10px" }}>
        <span style={{ "font-weight": 500 }}>Steps</span>
        <For each={draft.steps}>
          {(st, i) => (
            <div style={sectionBox}>
              <div
                style={{
                  display: "flex",
                  "align-items": "center",
                  gap: "8px",
                  padding: "8px 8px 8px 12px",
                  background: "var(--fill-3)",
                  "border-bottom": "1px solid var(--line-soft)",
                }}
              >
                <span
                  style={{
                    width: "22px",
                    height: "22px",
                    flex: "none",
                    "border-radius": "11px",
                    background: "var(--bg)",
                    border: "1px solid var(--line)",
                    display: "flex",
                    "align-items": "center",
                    "justify-content": "center",
                    "font-size": "12px",
                    "font-weight": 600,
                  }}
                >
                  {i() + 1}
                </span>
                <span style={{ position: "relative", display: "inline-flex" }}>
                  <select
                    aria-label={`Agent for step ${i() + 1}`}
                    onChange={(e) => setDraft("steps", i(), "agent", e.currentTarget.value)}
                    style={{
                      appearance: "none",
                      height: "28px",
                      padding: "0 26px 0 10px",
                      border: "1px solid var(--line)",
                      "border-radius": "8px",
                      background: "var(--bg)",
                      font: "inherit",
                      "font-weight": 500,
                      color: "var(--text)",
                    }}
                  >
                    <For each={agents()}>
                      {(name) => (
                        <option value={name} selected={name === st.agent}>
                          {name}
                        </option>
                      )}
                    </For>
                  </select>
                  <I
                    d="m6 9 6 6 6-6"
                    size={10}
                    sw={2.4}
                    stroke="var(--muted)"
                    style={{ position: "absolute", right: "9px", top: "9px", "pointer-events": "none" }}
                  />
                </span>
                <span class="ell" style={{ color: "var(--muted)" }}>
                  {agentInfo(props.root, st.agent).label}
                </span>
                <span style={{ flex: 1 }} />
                <button
                  type="button"
                  class="ic"
                  aria-label={`Move step ${i() + 1} up`}
                  disabled={i() === 0}
                  onClick={() => move(i(), -1)}
                >
                  <I d="m6 15 6-6 6 6" size={13} sw={2} />
                </button>
                <button
                  type="button"
                  class="ic"
                  aria-label={`Move step ${i() + 1} down`}
                  disabled={i() === draft.steps.length - 1}
                  onClick={() => move(i(), 1)}
                >
                  <I d="m6 9 6 6 6-6" size={13} sw={2} />
                </button>
                <button
                  type="button"
                  class="ic"
                  aria-label={`Remove step ${i() + 1}`}
                  disabled={draft.steps.length === 1}
                  onClick={() =>
                    setDraft(
                      "steps",
                      draft.steps.filter((_, k) => k !== i()),
                    )
                  }
                >
                  <I d={P.trash} size={13} sw={1.8} />
                </button>
              </div>
              <textarea
                rows="2"
                aria-label={`Instruction for step ${i() + 1}`}
                value={st.text}
                placeholder="What this agent does in this step"
                onInput={(e) => setDraft("steps", i(), "text", e.currentTarget.value)}
                style={{
                  display: "block",
                  width: "100%",
                  "box-sizing": "border-box",
                  resize: "vertical",
                  padding: "10px 12px",
                  border: 0,
                  outline: "none",
                  font: "inherit",
                  "line-height": 1.5,
                  background: "var(--bg)",
                }}
              />
            </div>
          )}
        </For>
        <button
          type="button"
          class="ol"
          style={{ "align-self": "flex-start" }}
          onClick={() =>
            setDraft("steps", draft.steps.length, {
              agent:
                agentsOf(props.root).find((a) => a.name !== draft.steps.at(-1)?.agent)?.name ??
                draft.steps.at(-1)?.agent ??
                "default",
              text: "",
            })
          }
        >
          <I d={P.plus} size={13} sw={2.2} />
          Add step
        </button>
      </div>
      <div style={{ display: "flex", gap: "6px", "align-items": "center", "padding-top": "4px" }}>
        <Show when={existing()}>
          <button
            type="button"
            class="gh"
            onClick={() => void remove()}
            style={{ "margin-left": "-8px", color: "var(--red)" }}
          >
            Delete workflow
          </button>
        </Show>
        <div style={{ flex: 1 }} />
        <button type="button" class="gh" onClick={back}>
          Cancel
        </button>
        <button type="submit" class="pri" disabled={saving()}>
          Save
        </button>
      </div>
    </EditFrame>
  );
}

/* ---------- shell ---------- */

/** The workflow and run the current page shows. */
const pageWf = (r: string | null): Workflow | undefined => {
  const c = nav();
  return r && (c.page === "wf" || c.page === "run" || c.page === "edit") && c.id
    ? workflowsOf(r).find((w) => w.id === c.id)
    : undefined;
};
const pageRun = (r: string | null): Run | undefined => {
  const c = nav();
  return r && c.page === "run" ? runsOf(r, c.id).find((x) => x.id === c.runId) : undefined;
};

/** The breadcrumb after "Workflows" for the page shown. */
function trail(r: string | null): { label: string; go?: () => void }[] {
  const c = nav();
  if (c.page === "home") return [];
  if (c.page === "edit") return [{ label: c.id ? "Edit workflow" : "New workflow" }];
  const w = pageWf(r);
  if (c.page !== "run") return [{ label: w?.name ?? "" }];
  const run = pageRun(r);
  const label = run?.status === "running" ? "Running now" : run ? `Run ${ago(run.startedAt)}` : "Run";
  return w ? [{ label: w.name, go: () => go({ page: "wf", id: w.id }) }, { label }] : [{ label }];
}

export default function Workflows(_props: { onClose?: () => void }) {
  onMount(() => {
    startTriggers();
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    onCleanup(() => clearInterval(timer));
  });
  createEffect(() => {
    const r = root();
    if (r) void loadWorkflows(r);
  });
  createEffect(on(root, () => go({ page: "home" }), { defer: true }));

  const wf = createMemo(() => pageWf(root()));
  const run = createMemo(() => pageRun(root()));

  return (
    <main class="view">
      <PageBar
        home="Workflows"
        goHome={() => go({ page: "home" })}
        trail={trail(root())}
        root={root()}
        pick={setPicked}
        menu="wf-project"
      />
      <Toast />
      <div style={{ flex: 1, "min-height": 0, overflow: "auto" }}>
        <Show
          when={root()}
          fallback={<NoProject title="Workflows" text="Open a project to create workflows." />}
        >
          {(r) => (
            <Switch fallback={<Home root={r()} />}>
              <Match when={nav().page === "edit"}>
                <Editor root={r()} />
              </Match>
              <Match when={nav().page === "run" && wf()}>
                <Show when={run()} fallback={<Missing text="This run is gone." />}>
                  {(x) => <RunPage root={r()} w={wf() as Workflow} run={x()} />}
                </Show>
              </Match>
              <Match when={nav().page === "wf" && wf()}>
                <Detail root={r()} w={wf() as Workflow} />
              </Match>
              <Match when={nav().page !== "home"}>
                <Show when={isLoaded(r())}>
                  <Missing text="This workflow is gone." />
                </Show>
              </Match>
            </Switch>
          )}
        </Show>
      </div>
    </main>
  );
}

function Missing(props: { text: string }) {
  return (
    <div class="page pad">
      <span style={{ color: "var(--muted)" }}>{props.text}</span>
      <button
        type="button"
        class="ol"
        style={{ "align-self": "flex-start" }}
        onClick={() => go({ page: "home" })}
      >
        Back to workflows
      </button>
    </div>
  );
}

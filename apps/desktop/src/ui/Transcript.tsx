import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js";
import { tokens } from "../lib/format.ts";
import {
  type Failure,
  keyOf,
  type LiveTurn,
  modelChoices,
  respond,
  send,
  state,
  toast,
} from "../lib/store.ts";
import {
  activeLabel,
  buildTurns,
  type DiffLine,
  describeStep,
  diffLines,
  duration,
  history,
  type Part,
  peek,
  stepIconPath,
  summarize,
  type ToolStep,
  type Turn,
  toolsOf,
  type Work,
} from "../lib/transcript.ts";
import type { Approval } from "../lib/types.ts";
import { I, P, Spinner } from "./icons.tsx";
import { Markdown } from "./Markdown.tsx";
import { setOpenMenu } from "./menu.tsx";

/** Disclosures the reader opened, by keys that outlive a reload of the session. */
const opened = new Set<string>();

function useOpen(key: string, initial = false) {
  const [open, setOpen] = createSignal(initial || opened.has(key));
  const toggle = () => {
    const next = !open();
    setOpen(next);
    if (next) opened.add(key);
    else opened.delete(key);
  };
  return [open, toggle] as const;
}

function Chevron() {
  return <I d={P.chevR} size={11} sw={2.2} class="chev" />;
}

function Counts(props: { added: number; removed: number }) {
  return (
    <Show when={props.added || props.removed}>
      <span class="chips">
        <span class="chip add">+{props.added}</span>
        <span class="chip del">−{props.removed}</span>
      </span>
    </Show>
  );
}

function Diff(props: { lines: DiffLine[]; path?: string }) {
  return (
    <div class="mono diff">
      <Show when={props.path}>
        <div class="diff-path">{props.path}</div>
      </Show>
      <For each={props.lines.slice(0, 120)}>
        {(l) => (
          <div class={l.k === "+" ? "dl dl-add" : "dl dl-del"}>
            <span class="dl-k">{l.k === "-" ? "−" : "+"}</span>
            <span class="dl-t">{l.text}</span>
          </div>
        )}
      </For>
    </div>
  );
}

function ToolRow(props: { step: ToolStep; live: boolean }) {
  const d = createMemo(() => describeStep(props.step));
  const lines = createMemo(() => diffLines(props.step.name, props.step.input));
  const output = () => (props.step.result ?? "").trim();
  const showDiff = () => lines().length > 0 && !props.step.isError;
  const canOpen = () => showDiff() || output() !== "";
  const [open, toggle] = useOpen(`tool:${props.step.id}`);
  return (
    <li class={props.live ? "act fade" : "act"}>
      <button
        type="button"
        class="act-row"
        aria-expanded={canOpen() ? open() : undefined}
        disabled={!canOpen()}
        onClick={toggle}
      >
        <I d={stepIconPath(d().icon)} size={14} />
        <span class={props.step.isError ? "ell err" : "ell"}>{d().text}</span>
        <Show when={showDiff()}>
          <Counts
            added={lines().filter((l) => l.k === "+").length}
            removed={lines().filter((l) => l.k === "-").length}
          />
        </Show>
        <Show when={props.live && props.step.result === undefined}>
          <Spinner size={11} />
        </Show>
        <Show when={canOpen()}>
          <Chevron />
        </Show>
      </button>
      <Show when={open() && canOpen()}>
        <Show when={showDiff()} fallback={<div class="act-out mono">{output().slice(0, 20_000)}</div>}>
          <div class="act-body">
            <Diff lines={lines()} />
          </div>
        </Show>
      </Show>
    </li>
  );
}

function ThoughtRow(props: { text: string; id: string; streaming: boolean }) {
  const [open, toggle] = useOpen(props.id);
  return (
    <li class="act">
      <button type="button" class="act-row" aria-expanded={open()} onClick={toggle}>
        <I d={P.bulb} size={14} />
        <span class={props.streaming ? "shimmer" : ""}>{props.streaming ? "Thinking" : "Thought"}</span>
        <Show when={!open()}>
          <span class="act-peek ell">{peek(props.text, props.streaming)}</span>
        </Show>
        <Chevron />
      </button>
      <Show when={open()}>
        <div class="act-thought">
          <Markdown text={props.text} />
        </div>
      </Show>
    </li>
  );
}

/** One collapsed line per group of steps: what it did when done, the step that runs now while live. */
function WorkGroup(props: {
  work: Work;
  id: string;
  live: boolean;
  running: boolean;
  waiting: boolean;
  elapsed: string;
}) {
  const sum = createMemo(() => summarize(props.work));
  const [open, toggle] = useOpen(props.id);
  const active = () => {
    if (props.waiting) return "Waiting for your approval";
    const last = props.work.items.at(-1);
    if (last?.kind === "tool" && last.result === undefined) return activeLabel(last);
    return last?.kind === "thought" ? "Thinking" : "Working";
  };
  return (
    <div class={props.live ? "work fade" : "work"}>
      <button type="button" class="work-head" aria-expanded={open()} onClick={toggle}>
        <Show
          when={props.running}
          fallback={
            <>
              <span class="ell">{sum().text}</span>
              <Counts added={sum().added} removed={sum().removed} />
            </>
          }
        >
          <Spinner size={12} />
          <span class={props.waiting ? "ell" : "ell shimmer"}>{active()}</span>
          <span class="work-time">{props.elapsed}</span>
        </Show>
        <Chevron />
      </button>
      <Show when={open()}>
        <ol class="acts">
          <For each={props.work.items}>
            {(a, i) => (
              <Show
                when={a.kind === "tool" && a}
                fallback={
                  <ThoughtRow
                    id={`${props.id}:${i()}`}
                    text={a.kind === "thought" ? a.text : ""}
                    streaming={props.running && i() === props.work.items.length - 1}
                  />
                }
              >
                {(t) => <ToolRow step={t()} live={props.live} />}
              </Show>
            )}
          </For>
        </ol>
      </Show>
    </div>
  );
}

function Parts(props: { parts: Part[]; id: string; live?: LiveTurn; elapsed?: string }) {
  return (
    <For each={props.parts}>
      {(part, i) => (
        <Switch>
          <Match when={part.kind === "text"}>
            <div class={props.live ? "fade" : ""}>
              <Markdown text={(part as Extract<Part, { kind: "text" }>).text} />
            </div>
          </Match>
          <Match when={part.kind === "work"}>
            <WorkGroup
              work={part as Work}
              id={`${props.id}:${i()}`}
              live={!!props.live}
              running={!!props.live && !props.live.ending && i() === props.parts.length - 1}
              waiting={!!props.live?.approval}
              elapsed={props.elapsed ?? ""}
            />
          </Match>
          <Match when={part.kind === "note"}>
            <div class="divider">{(part as Extract<Part, { kind: "note" }>).text}</div>
          </Match>
          <Match when={part.kind === "aside"}>
            <div class="aside">
              <span>{(part as Extract<Part, { kind: "aside" }>).label}</span>
              {(part as Extract<Part, { kind: "aside" }>).text}
            </div>
          </Match>
          <Match when={part.kind === "said"}>
            <div class="bubble-wrap said">
              <div class="bubble">{(part as Extract<Part, { kind: "said" }>).text}</div>
            </div>
          </Match>
        </Switch>
      )}
    </For>
  );
}

const secs = (ms: number): string => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

/** Model, time to first token, output speed, tokens and duration of a finished turn. */
function Footer(props: { root: string; turn: Turn }) {
  const s = () => props.turn.stats;
  const label = () => {
    const m = s()?.model;
    return m ? (modelChoices(props.root).find((c) => c.model === m)?.label ?? m) : undefined;
  };
  const rate = () => {
    const x = s();
    return x?.streamMs && x.outputTokens ? Math.round(x.outputTokens / (x.streamMs / 1000)) : undefined;
  };
  const took = () => {
    const t = props.turn;
    return t.startedAt && t.endedAt && t.endedAt > t.startedAt
      ? duration(t.endedAt - t.startedAt)
      : undefined;
  };
  const text = () =>
    props.turn.parts
      .flatMap((p) => (p.kind === "text" ? [p.text] : []))
      .join("\n\n")
      .trim();
  const [copied, setCopied] = createSignal(false);
  const copy = () =>
    void navigator.clipboard.writeText(text()).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      },
      () => toast("Could not copy to the clipboard.", { tone: "err" }),
    );
  return (
    <div class="turn-foot">
      <Show when={text()}>
        <button type="button" class="ic" aria-label={copied() ? "Copied" : "Copy response"} onClick={copy}>
          <I d={copied() ? P.check : P.copy} size={13} sw={1.7} />
        </button>
      </Show>
      <Show when={label()}>
        <span>{label()}</span>
      </Show>
      <Show when={s()?.ttftMs}>
        {(ms) => <span title="Time from the request to the first streamed token">{secs(ms())} latency</span>}
      </Show>
      <Show when={rate()}>
        <span title="Output tokens per second while the model streamed">{rate()} tok/s</span>
      </Show>
      <Show when={s()}>
        {(x) => (
          <span
            title={`${x().inputTokens.toLocaleString()} input and ${x().outputTokens.toLocaleString()} output tokens`}
          >
            {tokens(x().outputTokens)} tokens out
          </span>
        )}
      </Show>
      <Show when={took()}>
        <span>{took()}</span>
      </Show>
    </div>
  );
}

function Prompt(props: { id: string; text: string; note?: string; anim?: boolean }) {
  return (
    <div id={props.id} class={props.anim ? "pmt bubble-wrap msg-in" : "pmt bubble-wrap"}>
      <div class="bubble">{props.text}</div>
      <Show when={props.note}>
        <span class="note">{props.note}</span>
      </Show>
    </div>
  );
}

/** plan_exit in plan mode: the plan arrives as the request title. "always" would approve later plans unseen. */
function PlanCard(props: { root: string; approval: Approval }) {
  return (
    <section aria-label="Plan approval" class="card msg-in">
      <div style={{ display: "flex", "flex-direction": "column", gap: "2px" }}>
        <span style={{ "font-weight": 600 }}>Carry out this plan?</span>
        <span style={{ color: "var(--muted)" }}>Approving switches the mode to Accept edits.</span>
      </div>
      <div class="plan-body">
        <Markdown text={props.approval.request.title} />
      </div>
      <div style={{ display: "flex", gap: "6px", "flex-wrap": "wrap" }}>
        <button type="button" class="pri" onClick={() => void respond(props.root, props.approval, "once")}>
          Approve plan
        </button>
        <button type="button" class="ol" onClick={() => void respond(props.root, props.approval, "reject")}>
          Keep planning
        </button>
      </div>
    </section>
  );
}

function ApprovalCard(props: { root: string; approval: Approval; input?: Record<string, unknown> }) {
  const r = () => props.approval.request;
  const lines = () => (props.input ? diffLines(r().tool, props.input) : []);
  const isEdit = () => ["edit", "write", "notebook_edit"].includes(r().tool);
  const command = () =>
    r().command ?? (typeof props.input?.command === "string" ? props.input.command : undefined);
  const title = () =>
    isEdit()
      ? r().tool === "write"
        ? "Create this file?"
        : "Edit this file?"
      : command()
        ? "Run this command?"
        : `Allow ${r().tool}?`;
  const why = () => {
    const source = r().source ?? "";
    if (source.startsWith("rule") || source.includes("permission"))
      return `It matches the rule ${source.replace(/^rule:/, "")}, which asks first.`;
    if (state.prefs.mode === "ask") return "Manual mode asks before each edit and command.";
    if (state.prefs.mode === "allow-edits") return "Accept edits mode still asks before commands.";
    return `This ${r().riskTier ?? ""} tool asks first.`.replace("  ", " ");
  };
  return (
    <section aria-label="Approval request" class="card msg-in">
      <div style={{ display: "flex", "flex-direction": "column", gap: "2px" }}>
        <span style={{ "font-weight": 600 }}>{title()}</span>
        <span style={{ color: "var(--muted)" }}>{why()}</span>
      </div>
      <Show when={isEdit()}>
        <Diff lines={lines()} path={r().path ?? r().title} />
      </Show>
      <Show when={!isEdit() && (command() || r().argsSummary)}>
        <div class="mono cmdline">{command() ?? r().argsSummary}</div>
      </Show>
      <div style={{ display: "flex", gap: "6px", "flex-wrap": "wrap" }}>
        <button type="button" class="pri" onClick={() => void respond(props.root, props.approval, "once")}>
          Allow once
        </button>
        <button type="button" class="ol" onClick={() => void respond(props.root, props.approval, "always")}>
          {isEdit() ? "Always allow edits" : `Always allow ${r().tool}`}
        </button>
        <div style={{ flex: 1 }} />
        <button type="button" class="gh" onClick={() => void respond(props.root, props.approval, "reject")}>
          Deny
        </button>
      </div>
    </section>
  );
}

function FailureCard(props: { root: string; id: string; failure: Failure }) {
  return (
    <section aria-label="Turn failed" class="card msg-in" style={{ "flex-direction": "row", gap: "10px" }}>
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        aria-hidden="true"
        style={{ flex: "none", "margin-top": "1px" }}
      >
        <circle cx="12" cy="12" r="10" fill="var(--red-fill)" />
        <path d="m8.5 8.5 7 7M15.5 8.5l-7 7" stroke="#FFFFFF" stroke-width="2.4" stroke-linecap="round" />
      </svg>
      <div style={{ flex: 1, "min-width": 0, display: "flex", "flex-direction": "column", gap: "12px" }}>
        <div style={{ display: "flex", "flex-direction": "column", gap: "2px" }}>
          <span style={{ "font-weight": 600 }}>The turn stopped</span>
          <span style={{ color: "var(--muted)", "overflow-wrap": "anywhere" }}>{props.failure.message}</span>
        </div>
        <div style={{ display: "flex", gap: "6px", "flex-wrap": "wrap" }}>
          <button
            type="button"
            class="pri"
            onClick={() =>
              void send(props.root, props.id, props.failure.retry.text, props.failure.retry.attachments)
            }
          >
            Retry
          </button>
          <button type="button" class="ol" onClick={() => setOpenMenu("model")}>
            Change model
          </button>
        </div>
      </div>
    </section>
  );
}

export function Transcript(props: { root: string; id: string }) {
  const key = () => keyOf(props.root, props.id);
  const session = () => state.sessions[key()];
  const live = () => state.live[key()];
  const turns = createMemo<Turn[]>(() => {
    const view = session()?.view;
    const all = view ? buildTurns(history(view.entries, view.tipId)) : [];
    // The file already holds the running turn's prompt: the live view below shows it with its steps.
    const l = live();
    return l?.mine && l.baseTurns !== undefined ? all.slice(0, l.baseTurns) : all;
  });
  const prompts = createMemo(() => [
    ...turns().map((t) => t.prompt),
    ...(live()?.mine && live()?.prompt ? [live()?.prompt ?? ""] : []),
  ]);
  const [navAt, setNavAt] = createSignal<number | null>(null);

  const [now, setNow] = createSignal(Date.now());
  createEffect(() => {
    if (!live()) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(timer));
  });
  const elapsed = () => {
    const l = live();
    return l ? duration(Math.max(0, now() - l.startedAt)) : "";
  };

  const pendingInput = () => {
    const l = live();
    if (!l?.approval) return undefined;
    for (const part of [...l.parts].reverse()) {
      if (part.kind !== "work") continue;
      const step = toolsOf(part)
        .reverse()
        .find((s) => s.result === undefined);
      if (step) return step.input;
    }
    return undefined;
  };

  let scroller: HTMLDivElement | undefined;
  let content: HTMLDivElement | undefined;
  // Follows new output while the reader is at the end; scrolling up stops it until they come back.
  let stick = true;
  const [away, setAway] = createSignal(false);
  const atEnd = () => !scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
  const toEnd = (smooth = false) =>
    scroller?.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  onMount(() => {
    const grown = new ResizeObserver(() => {
      if (stick) toEnd();
      else setAway(!atEnd());
    });
    if (content) grown.observe(content);
    onCleanup(() => grown.disconnect());
  });
  // Another session, or a prompt of mine, starts at the end.
  createEffect(
    on([key, () => (live()?.mine ? live()?.turnId : undefined)], () => {
      stick = true;
      setAway(false);
      queueMicrotask(() => toEnd());
    }),
  );
  const onScroll = () => {
    if (!scroller) return;
    stick = atEnd();
    setAway(!stick);
    const els = scroller.querySelectorAll<HTMLElement>("[id^='prompt-']");
    if (els.length < 2) return;
    const line = scroller.getBoundingClientRect().top + 80;
    let k = 0;
    els.forEach((el, i) => {
      if (el.getBoundingClientRect().top <= line) k = i;
    });
    if (stick) k = els.length - 1;
    setNavAt(k);
  };
  const current = () => {
    const n = navAt();
    return n === null || n >= prompts().length ? prompts().length - 1 : n;
  };

  return (
    <div
      style={{ flex: 1, "min-height": 0, display: "flex", "flex-direction": "column", position: "relative" }}
    >
      <div class="tx-scroll" ref={scroller} onScroll={onScroll}>
        <div class="pad col tx" ref={content}>
          <Show when={session()?.loading && turns().length === 0 && !live()}>
            <div class="status">
              <Spinner />
              Loading the session
            </div>
          </Show>
          <For each={turns()}>
            {(turn, i) => (
              <article class="turn">
                <Prompt
                  id={`prompt-${i()}`}
                  text={turn.prompt}
                  note={turn.images ? `With ${turn.images} image${turn.images > 1 ? "s" : ""}` : undefined}
                />
                <div class="reply">
                  <Parts parts={turn.parts} id={turn.key} />
                  <Show when={turn.stats || turn.parts.length > 0}>
                    <Footer root={props.root} turn={turn} />
                  </Show>
                </div>
              </article>
            )}
          </For>
          <Show when={live()}>
            {(l) => (
              <article class="turn">
                <Show when={l().mine && l().prompt}>
                  <Prompt id={`prompt-${turns().length}`} text={l().prompt} note={l().note} anim />
                </Show>
                <div class="reply">
                  <Parts parts={l().parts} id={`live:${l().turnId}`} live={l()} elapsed={elapsed()} />
                  <Show when={l().approval}>
                    {(a) => (
                      <Show
                        when={a().request.tool === "plan_exit"}
                        fallback={<ApprovalCard root={props.root} approval={a()} input={pendingInput()} />}
                      >
                        <PlanCard root={props.root} approval={a()} />
                      </Show>
                    )}
                  </Show>
                  <Show when={!l().ending && l().parts.at(-1)?.kind !== "work"}>
                    <div class="status">
                      <Spinner size={12} />
                      <span class="shimmer">Working</span>
                      <span class="work-time">{elapsed()}</span>
                    </div>
                  </Show>
                </div>
              </article>
            )}
          </Show>
          <Show when={!live() && session()?.failure}>
            {(f) => <FailureCard root={props.root} id={props.id} failure={f()} />}
          </Show>
        </div>
      </div>
      <Show when={away()}>
        <button
          type="button"
          class="jump"
          aria-label="Jump to the latest message"
          onClick={() => {
            stick = true;
            setAway(false);
            toEnd(true);
          }}
        >
          <I d={P.down} size={15} sw={1.9} />
        </button>
      </Show>
      <Show when={prompts().length > 1}>
        <nav aria-label="Prompts in this session" class="pn">
          <For each={prompts()}>
            {(text, k) => (
              <button
                type="button"
                class={k() === current() ? "pn-item on" : "pn-item"}
                aria-label={`Prompt ${k() + 1} of ${prompts().length}: ${text}`}
                aria-current={k() === current() ? "true" : undefined}
                onClick={() => {
                  document
                    .getElementById(`prompt-${k()}`)
                    ?.scrollIntoView({ block: "start", behavior: "smooth" });
                  setNavAt(k());
                }}
              >
                <span class="pn-tick" aria-hidden="true" />
                <span class="pn-tip" aria-hidden="true">
                  {text}
                </span>
              </button>
            )}
          </For>
        </nav>
      </Show>
    </div>
  );
}

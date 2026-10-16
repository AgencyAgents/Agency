import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js";
import { type Failure, keyOf, type LiveTurn, respond, send, state } from "../lib/store.ts";
import {
  buildTurns,
  chain,
  describeStep,
  type Part,
  stepIconPath,
  type ToolStep,
  type Turn,
  workLabel,
} from "../lib/transcript.ts";
import type { Approval } from "../lib/types.ts";
import { I, P, Spinner } from "./icons.tsx";
import { Markdown } from "./Markdown.tsx";
import { setOpenMenu } from "./menu.tsx";

const ING: Record<string, string> = {
  Read: "Reading",
  Wrote: "Writing",
  Edited: "Editing",
  Ran: "Running",
  Searched: "Searching",
  Listed: "Listing",
  Fetched: "Fetching",
  Used: "Using",
  Updated: "Updating",
  Started: "Starting",
};

function statusOf(live: LiveTurn): { text: string; streaming: boolean } {
  if (live.approval) return { text: "Waiting for your approval", streaming: false };
  const last = live.parts.at(-1);
  if (last?.kind === "text") return { text: "", streaming: true };
  if (last?.kind === "work") {
    const step = [...last.steps].reverse().find((s) => s.result === undefined);
    if (step) {
      const [verb, ...rest] = describeStep(step).text.split(" ");
      return { text: `${ING[verb as string] ?? verb} ${rest.join(" ")}`, streaming: false };
    }
  }
  return { text: live.parts.length ? "Thinking" : "Reading the codebase", streaming: false };
}

function Step(props: { step: ToolStep }) {
  const d = createMemo(() => describeStep(props.step));
  const output = () => (props.step.result ?? "").trim();
  return (
    <li>
      <Show
        when={output()}
        fallback={
          <span class="step">
            <I d={stepIconPath(d().icon)} size={15} />
            <span class="ell">{d().text}</span>
            <Show when={props.step.result === undefined}>
              <Spinner size={11} />
            </Show>
          </span>
        }
      >
        <details>
          <summary>
            <I d={stepIconPath(d().icon)} size={15} />
            <span class="ell" style={props.step.isError ? { color: "var(--red)" } : {}}>
              {d().text}
            </span>
            <I d={P.chevR} size={11} sw={2.2} class="chev" />
          </summary>
          <div class={props.step.isError ? "step-out mono err" : "step-out mono"}>
            {output().slice(0, 20_000)}
          </div>
        </details>
      </Show>
    </li>
  );
}

function Work(props: { part: Extract<Part, { kind: "work" }>; running: boolean }) {
  return (
    <details class="work" open={props.running}>
      <summary>
        {workLabel(props.part, props.running)}
        <I d={P.chevR} size={11} sw={2.2} class="chev" />
      </summary>
      <For each={props.part.thinking}>{(t) => <div class="thinking">{t.trim()}</div>}</For>
      <Show when={props.part.steps.length > 0}>
        <ul class="steps">
          <For each={props.part.steps}>{(s) => <Step step={s} />}</For>
        </ul>
      </Show>
    </details>
  );
}

function Parts(props: { parts: Part[]; live: boolean }) {
  return (
    <For each={props.parts}>
      {(part, i) => (
        <Switch>
          <Match when={part.kind === "text"}>
            <Markdown text={(part as Extract<Part, { kind: "text" }>).text} />
          </Match>
          <Match when={part.kind === "work"}>
            <Work
              part={part as Extract<Part, { kind: "work" }>}
              running={props.live && i() === props.parts.length - 1}
            />
          </Match>
          <Match when={part.kind === "note"}>
            <p style={{ margin: 0, color: "var(--muted)", "font-size": "13px" }}>
              {(part as Extract<Part, { kind: "note" }>).text}
            </p>
          </Match>
        </Switch>
      )}
    </For>
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

function diffLines(input: Record<string, unknown>): { k: "+" | "-" | " "; text: string }[] {
  const hunks = Array.isArray(input.hunks)
    ? (input.hunks as { oldText?: string; newText?: string }[])
    : [{ oldText: String(input.oldText ?? ""), newText: String(input.newText ?? "") }];
  const out: { k: "+" | "-" | " "; text: string }[] = [];
  for (const h of hunks) {
    for (const line of (h.oldText ?? "").split("\n")) if (h.oldText) out.push({ k: "-", text: line });
    for (const line of (h.newText ?? "").split("\n")) if (h.newText) out.push({ k: "+", text: line });
  }
  if (typeof input.content === "string")
    for (const line of input.content.split("\n").slice(0, 40)) out.push({ k: "+", text: line });
  return out.slice(0, 80);
}

function ApprovalCard(props: { root: string; approval: Approval; input?: Record<string, unknown> }) {
  const r = () => props.approval.request;
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
    return state.prefs.mode === "ask"
      ? "Ask before edits is on."
      : `This ${r().riskTier ?? ""} tool asks first.`.replace("  ", " ");
  };
  const lines = () => (isEdit() && props.input ? diffLines(props.input) : []);
  return (
    <section aria-label="Approval request" class="card msg-in">
      <div style={{ display: "flex", "flex-direction": "column", gap: "2px" }}>
        <span style={{ "font-weight": 600 }}>{title()}</span>
        <span style={{ color: "var(--muted)" }}>{why()}</span>
      </div>
      <Show when={isEdit()}>
        <div class="mono diff">
          <div class="diff-path">{r().path ?? r().title}</div>
          <For each={lines()}>
            {(l) => (
              <div
                class="dl"
                style={{
                  background: l.k === "+" ? "var(--diff-add)" : l.k === "-" ? "var(--diff-del)" : "var(--bg)",
                }}
              >
                <span
                  style={{
                    width: "28px",
                    flex: "none",
                    "text-align": "center",
                    color: l.k === "+" ? "var(--green)" : l.k === "-" ? "var(--red)" : "var(--disabled)",
                  }}
                >
                  {l.k === " " ? "" : l.k === "-" ? "−" : "+"}
                </span>
                <span style={{ "padding-right": "12px" }}>{l.text}</span>
              </div>
            )}
          </For>
        </div>
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
    return view ? buildTurns(chain(view.entries, view.tipId)) : [];
  });
  const prompts = createMemo(() => [
    ...turns().map((t) => t.prompt),
    ...(live()?.mine && live()?.prompt ? [live()?.prompt ?? ""] : []),
  ]);
  const [navAt, setNavAt] = createSignal<number | null>(null);

  const pendingInput = () => {
    const l = live();
    if (!l?.approval) return undefined;
    for (const part of [...l.parts].reverse()) {
      if (part.kind !== "work") continue;
      const step = [...part.steps].reverse().find((s) => s.result === undefined);
      if (step) return step.input;
    }
    return undefined;
  };

  let scroller: HTMLDivElement | undefined;
  const onScroll = () => {
    if (!scroller) return;
    const els = scroller.querySelectorAll<HTMLElement>("[id^='prompt-']");
    if (els.length < 2) return;
    const line = scroller.getBoundingClientRect().top + 80;
    let k = 0;
    els.forEach((el, i) => {
      if (el.getBoundingClientRect().top <= line) k = i;
    });
    if (Math.abs(scroller.scrollTop) < 2) k = els.length - 1;
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
        <div class="pad col tx">
          <Show when={session()?.loading && turns().length === 0 && !live()}>
            <div class="status">
              <Spinner />
              Loading the session
            </div>
          </Show>
          <For each={turns()}>
            {(turn, i) => (
              <>
                <Prompt
                  id={`prompt-${i()}`}
                  text={turn.prompt}
                  note={turn.images ? `With ${turn.images} image${turn.images > 1 ? "s" : ""}` : undefined}
                />
                <Parts parts={turn.parts} live={false} />
              </>
            )}
          </For>
          <Show when={live()}>
            {(l) => (
              <>
                <Show when={l().mine && l().prompt}>
                  <Prompt id={`prompt-${turns().length}`} text={l().prompt} note={l().note} anim />
                </Show>
                <Parts parts={l().parts} live />
                <Show when={l().approval}>
                  {(a) => <ApprovalCard root={props.root} approval={a()} input={pendingInput()} />}
                </Show>
                <Show when={!statusOf(l()).streaming}>
                  <div class="status">
                    <Spinner />
                    <span class={l().approval ? "" : "shimmer"}>{statusOf(l()).text}</span>
                  </div>
                </Show>
              </>
            )}
          </Show>
          <Show when={!live() && session()?.failure}>
            {(f) => <FailureCard root={props.root} id={props.id} failure={f()} />}
          </Show>
        </div>
      </div>
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

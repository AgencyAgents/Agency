import { createMemo, For, Show } from "solid-js";
import { tokens, usd } from "../lib/format.ts";
import { currentModel, keyOf, project, savePrefs, setState, state, todosOf, usageOf } from "../lib/store.ts";
import { I, P, Spinner } from "./icons.tsx";

export function Details() {
  const cur = () => state.current;
  const shown = () => state.prefs.panel && (state.view === "session" || state.view === "review") && !!cur();
  const view = () => {
    const c = cur();
    return c ? (state.sessions[keyOf(c.root, c.id)]?.view ?? null) : null;
  };
  const live = () => {
    const c = cur();
    return c ? state.live[keyOf(c.root, c.id)] : undefined;
  };
  const todos = createMemo(() => todosOf(view()));
  const usage = createMemo(() => usageOf(view()));
  const model = () => currentModel(cur()?.root);
  const files = () => project(cur()?.root)?.git?.files ?? [];
  const used = () => live()?.tokens || usage().tokens;
  const window = () => model()?.contextWindow ?? 200_000;
  const pct = () => Math.min(100, (used() / window()) * 100);
  const config = () => project(cur()?.root)?.config ?? {};
  const compactAt = () => {
    const limit =
      typeof config().compactionLimit === "number" ? (config().compactionLimit as number) : undefined;
    return limit ? Math.min(limit, window()) : Math.round(window() * 0.9);
  };
  const sandbox = () => {
    const s = (config().sandbox ?? {}) as { backend?: string; allowNetwork?: boolean };
    const backend =
      { software: "Software", docker: "Docker", os: "OS" }[s.backend ?? "software"] ?? s.backend;
    return `${backend}, ${s.allowNetwork ? "network on" : "no network"}`;
  };

  return (
    <aside
      aria-label="Session details"
      class={`insp${shown() ? " on" : ""}${state.panelAnim ? " anim" : ""}`}
      onAnimationEnd={() => setState("panelAnim", false)}
    >
      <div style={{ display: "flex", "align-items": "center", height: "24px" }}>
        <h2 style={{ margin: 0, "font-size": "13px", "font-weight": 600, flex: 1 }}>Details</h2>
        <button
          type="button"
          class="ic"
          aria-label="Close details"
          onClick={() => savePrefs({ panel: false })}
          style={{ "margin-right": "-8px" }}
        >
          <I d={P.x} size={13} sw={2} />
        </button>
      </div>

      <section>
        <div class="sec-row">
          <h3 class="sec-h">Tasks</h3>
          <Show when={todos().length > 0}>
            <span
              style={{ color: "var(--muted)" }}
            >{`${todos().filter((t) => t.status === "completed").length} of ${todos().length} done`}</span>
          </Show>
        </div>
        <Show
          when={todos().length > 0}
          fallback={
            <p style={{ margin: 0, color: "var(--muted)" }}>
              No task list yet. The agent writes one for longer work.
            </p>
          }
        >
          <ol
            style={{
              "list-style": "none",
              margin: 0,
              padding: 0,
              display: "flex",
              "flex-direction": "column",
              gap: "8px",
            }}
          >
            <For each={todos()}>
              {(t) => (
                <li
                  style={{
                    display: "flex",
                    gap: "10px",
                    color: t.status === "completed" ? "var(--muted)" : "var(--text)",
                  }}
                >
                  <Show when={t.status === "completed"}>
                    <svg
                      width="15"
                      height="15"
                      viewBox="0 0 24 24"
                      style={{ flex: "none", "margin-top": "2px" }}
                      aria-hidden="true"
                    >
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
                  </Show>
                  <Show when={t.status === "in_progress"}>
                    <span style={{ "margin-top": "2px" }}>
                      <Spinner size={15} />
                    </span>
                  </Show>
                  <Show when={t.status === "pending" || t.status === "ready_for_review"}>
                    <svg
                      width="15"
                      height="15"
                      viewBox="0 0 24 24"
                      style={{ flex: "none", "margin-top": "2px" }}
                      aria-hidden="true"
                    >
                      <circle cx="12" cy="12" r="9.2" fill="none" stroke="var(--track)" stroke-width="1.6" />
                    </svg>
                  </Show>
                  <span>{t.content}</span>
                </li>
              )}
            </For>
          </ol>
        </Show>
      </section>

      <section>
        <div class="sec-row">
          <h3 class="sec-h">Context</h3>
          <span style={{ color: "var(--muted)" }}>{`${tokens(used())} of ${tokens(window())} tokens`}</span>
        </div>
        <div class="meter">
          <span style={{ width: `${pct()}%`, background: "var(--ctx1)" }} />
          <span />
        </div>
        <span style={{ color: "var(--muted)" }}>{`Compacts at ${tokens(compactAt())}`}</span>
      </section>

      <section>
        <div class="sec-row">
          <h3 class="sec-h">Changes</h3>
          <Show when={files().length > 0}>
            <button
              type="button"
              class="link"
              onClick={() => setState("view", state.view === "review" ? "session" : "review")}
            >
              {state.view === "review" ? "Chat" : "Review"}
            </button>
          </Show>
        </div>
        <Show
          when={files().length > 0}
          fallback={
            <p style={{ margin: 0, color: "var(--muted)" }}>
              {project(cur()?.root)?.git?.repo === false ? "Not a git repository." : "No changes."}
            </p>
          }
        >
          <div style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
            <For each={files().slice(0, 40)}>
              {(f) => (
                <button
                  type="button"
                  class="hov-row"
                  onClick={() => {
                    setState("view", "review");
                    setTimeout(
                      () =>
                        document
                          .getElementById(`diff-${f.path}`)
                          ?.scrollIntoView({ block: "start", behavior: "smooth" }),
                      300,
                    );
                  }}
                  style={{
                    display: "flex",
                    gap: "8px",
                    "align-items": "center",
                    margin: "0 -8px",
                    padding: "3px 8px",
                    border: 0,
                    "border-radius": "6px",
                    background: "transparent",
                    "text-align": "left",
                  }}
                  title={f.path}
                >
                  <span class="ell" style={{ flex: 1 }}>
                    {f.path.split("/").pop()}
                  </span>
                  <Show when={f.added}>
                    <span class="add">+{f.added}</span>
                  </Show>
                  <Show when={f.deleted}>
                    <span class="del">−{f.deleted}</span>
                  </Show>
                </button>
              )}
            </For>
          </div>
        </Show>
      </section>

      <section>
        <h3 class="sec-h">Run</h3>
        <dl class="kv">
          <dt>Model</dt>
          <dd>{model()?.label ?? "None"}</dd>
          <dt>Sandbox</dt>
          <dd>{sandbox()}</dd>
          <dt>Cost</dt>
          <dd>
            {usage().input
              ? `${usd(usage().costUsd)}, ${Math.round((usage().cached / usage().input) * 100)}% cached`
              : usd(usage().costUsd)}
          </dd>
          <Show when={project(cur()?.root)?.git?.branch}>
            <dt>Branch</dt>
            <dd>{project(cur()?.root)?.git?.branch}</dd>
          </Show>
        </dl>
      </section>
    </aside>
  );
}

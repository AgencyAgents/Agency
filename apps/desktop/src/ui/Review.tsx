import { createResource, For, Show } from "solid-js";
import { type DiffFile, newFile, parseDiff } from "../lib/diff.ts";
import { host } from "../lib/host.ts";
import { project, rewind, setState, state } from "../lib/store.ts";
import { I, P, Spinner } from "./icons.tsx";

export async function loadDiff(root: string): Promise<DiffFile[]> {
  const out = await host.gitDiff(root);
  return [...parseDiff(out.diff), ...out.untracked.map((u) => newFile(u.path, u.text))];
}

export function Review(props: { root: string; id: string }) {
  const [files, { refetch }] = createResource(
    () =>
      [
        props.root,
        project(props.root)?.git?.files?.length ?? 0,
        state.live[`${props.root}\u0000${props.id}`] ? 1 : 0,
      ] as const,
    ([root]) => loadDiff(root),
  );
  const added = () => (files() ?? []).reduce((n, f) => n + f.added, 0);
  const deleted = () => (files() ?? []).reduce((n, f) => n + f.deleted, 0);
  const git = () => project(props.root)?.git;
  return (
    <div style={{ flex: 1, "min-height": 0, display: "flex", "flex-direction": "column" }}>
      <div
        class="pad"
        style={{
          height: "44px",
          flex: "none",
          display: "flex",
          "align-items": "center",
          gap: "10px",
          padding: "0 14px 0 20px",
          "border-top": "1px solid var(--line-soft)",
          "border-bottom": "1px solid var(--line-soft)",
        }}
      >
        <button
          type="button"
          class="gh"
          onClick={() => setState("view", "session")}
          style={{ "margin-left": "-6px", color: "var(--muted)" }}
        >
          <I d={P.chevL} size={13} sw={2} />
          Chat
        </button>
        <span aria-hidden="true" style={{ width: "1px", height: "16px", background: "var(--line)" }} />
        <span
          style={{ "font-weight": 500 }}
        >{`${files()?.length ?? 0} file${files()?.length === 1 ? "" : "s"} changed`}</span>
        <span class="add">+{added()}</span>
        <span class="del">−{deleted()}</span>
        <Show when={git()?.branch}>
          <span class="hide-sm" style={{ color: "var(--muted)" }}>
            on {git()?.branch}
          </span>
        </Show>
        <div style={{ flex: 1 }} />
        <button type="button" class="gh" onClick={() => void refetch()}>
          Refresh
        </button>
        <button
          type="button"
          class="gh"
          onClick={() => void rewind(props.root, props.id).then(() => refetch())}
        >
          Undo turn
        </button>
      </div>
      <div style={{ flex: 1, "min-height": 0, overflow: "auto" }}>
        <Show
          when={!files.loading || files()}
          fallback={
            <p class="status" style={{ "justify-content": "center", margin: "48px auto" }}>
              <Spinner />
              Reading the changes
            </p>
          }
        >
          <Show
            when={(files() ?? []).length > 0}
            fallback={
              <p style={{ margin: "48px auto", "text-align": "center", color: "var(--muted)" }}>
                No changes. The working tree matches HEAD.
              </p>
            }
          >
            <div
              class="pad col"
              style={{
                margin: "0 auto",
                padding: "16px 32px 40px",
                display: "flex",
                "flex-direction": "column",
                gap: "14px",
              }}
            >
              <For each={files()}>
                {(f) => {
                  const dir = f.path.includes("/") ? `${f.path.slice(0, f.path.lastIndexOf("/"))}/` : "";
                  const name = f.path.slice(dir.length);
                  return (
                    <section
                      id={`diff-${f.path}`}
                      aria-label={f.path}
                      style={{
                        border: "1px solid var(--line-soft)",
                        "border-radius": "12px",
                        overflow: "hidden",
                      }}
                    >
                      <details open>
                        <summary
                          style={{
                            height: "40px",
                            display: "flex",
                            "align-items": "center",
                            gap: "8px",
                            padding: "0 14px",
                            background: "var(--fill-3)",
                          }}
                        >
                          <I d={P.chevR} size={11} sw={2.2} class="chev" stroke="var(--muted)" />
                          <span class="ell" style={{ flex: 1 }}>
                            <span style={{ color: "var(--muted)" }}>{dir}</span>
                            <span style={{ "font-weight": 500 }}>{name}</span>
                          </span>
                          <Show when={f.added}>
                            <span class="add">+{f.added}</span>
                          </Show>
                          <Show when={f.deleted}>
                            <span class="del">−{f.deleted}</span>
                          </Show>
                        </summary>
                        <div
                          class="mono"
                          style={{
                            "border-top": "1px solid var(--line-soft)",
                            "font-size": "12.5px",
                            "line-height": "21px",
                            "overflow-x": "auto",
                          }}
                        >
                          <Show
                            when={!f.binary}
                            fallback={
                              <div style={{ padding: "8px 14px", color: "var(--muted)" }}>Binary file</div>
                            }
                          >
                            <For each={f.hunks}>
                              {(h) => (
                                <>
                                  <div
                                    style={{
                                      padding: "2px 14px",
                                      background: "var(--hunk)",
                                      color: "var(--muted)",
                                    }}
                                  >
                                    {h.head}
                                  </div>
                                  <For each={h.lines}>
                                    {(l) => (
                                      <div
                                        class="dl"
                                        style={{
                                          background:
                                            l.k === "+"
                                              ? "var(--diff-add)"
                                              : l.k === "-"
                                                ? "var(--diff-del)"
                                                : "var(--bg)",
                                        }}
                                      >
                                        <span
                                          style={{
                                            width: "52px",
                                            flex: "none",
                                            "padding-right": "12px",
                                            "text-align": "right",
                                            color:
                                              l.k === " "
                                                ? "var(--muted-2)"
                                                : l.k === "+"
                                                  ? "var(--diff-add-n)"
                                                  : "var(--diff-del-n)",
                                            "user-select": "none",
                                          }}
                                        >
                                          {l.n}
                                        </span>
                                        <span
                                          style={{
                                            width: "18px",
                                            flex: "none",
                                            color:
                                              l.k === "+"
                                                ? "var(--green)"
                                                : l.k === "-"
                                                  ? "var(--red)"
                                                  : "var(--disabled)",
                                          }}
                                        >
                                          {l.k === "-" ? "−" : l.k}
                                        </span>
                                        <span style={{ "padding-right": "16px" }}>{l.text}</span>
                                      </div>
                                    )}
                                  </For>
                                </>
                              )}
                            </For>
                          </Show>
                        </div>
                      </details>
                    </section>
                  );
                }}
              </For>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  );
}

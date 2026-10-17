import { open } from "@tauri-apps/plugin-dialog";
import { createMemo, createSignal, For, Show } from "solid-js";
import { ago } from "../lib/format.ts";
import {
  addProject,
  archiveSession,
  deleteSession,
  duplicateSession,
  type Filter,
  goNew,
  keyOf,
  openSession,
  type RowState,
  renameSession,
  restartDaemon,
  rowState,
  savePrefs,
  sessionTitle,
  setState,
  state,
  toast,
  trustProject,
} from "../lib/store.ts";
import { I, P, Spinner } from "./icons.tsx";
import { Choices, closeMenu, openMenu, Pop, setOpenMenu, toggleMenu } from "./menu.tsx";
import { UpdateBanner } from "./Updater.tsx";

interface Row {
  root: string;
  id: string;
  title: string;
  state: RowState;
  meta: string;
  archived: boolean;
}

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All sessions" },
  { value: "running", label: "Running" },
  { value: "needs", label: "Needs you" },
  { value: "done", label: "Done" },
  { value: "archived", label: "Archived" },
];

function matches(row: Row, filter: Filter): boolean {
  if (filter === "archived" || row.archived) return filter === "archived" && row.archived;
  if (filter === "all") return true;
  if (filter === "needs") return row.state === "needs" || row.state === "failed";
  if (filter === "done") return row.state === "idle";
  return row.state === "running";
}

export async function pickFolder(): Promise<void> {
  const path = await open({ directory: true, multiple: false, title: "Open a project folder" });
  if (typeof path === "string") await addProject(path);
}

export function Sidebar() {
  const rows = createMemo<Row[]>(() =>
    state.projects.flatMap((p) => {
      const known = new Set(p.rows.map((r) => r.id));
      const extra = Object.keys(state.live)
        .filter((k) => k.startsWith(`${p.path}\u0000`))
        .map((k) => k.slice(p.path.length + 1))
        .filter((id) => !known.has(id))
        .map((id) => ({ id, title: null, tipId: null, entries: 0, updatedAt: new Date().toISOString() }));
      return [...extra, ...p.rows].map((r) => ({
        root: p.path,
        id: r.id,
        title: sessionTitle(p.path, r, r.id),
        state: rowState(p.path, r.id),
        meta: ago(r.updatedAt),
        archived: state.prefs.archived.includes(keyOf(p.path, r.id)),
      }));
    }),
  );
  const q = () => state.q.trim().toLowerCase();
  const shown = createMemo(() =>
    rows().filter((r) => matches(r, state.filter) && (!q() || r.title.toLowerCase().includes(q()))),
  );
  const narrowed = () => !!q() || state.filter !== "all";
  const [menuAt, setMenuAt] = createSignal<{ row: Row; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = createSignal<string | null>(null);
  // The row's input is made again when the list refreshes: the draft and the one select outlive it.
  const [draft, setDraft] = createSignal("");
  let selected: string | null = null;
  const [doomed, setDoomed] = createSignal<Row | null>(null);
  const openRowMenu = (row: Row, e: MouseEvent) => {
    e.preventDefault();
    // A keyboard context key reports 0,0: open beside the row instead.
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX || box.left + 24;
    const y = e.clientY || box.bottom;
    setMenuAt({ row, x: Math.min(x, window.innerWidth - 216), y: Math.min(y, window.innerHeight - 200) });
    setOpenMenu("row-menu");
  };
  const act = (run: (row: Row) => void) => () => {
    const m = menuAt();
    closeMenu();
    if (m) run(m.row);
  };
  const byStatus = () => state.prefs.layout === "status";

  const groups = createMemo(() => {
    if (byStatus()) {
      const defs: [string, string, string, (r: Row) => boolean][] = [
        ["needs", "Needs you", P.alert, (r) => r.state === "needs" || r.state === "failed"],
        ["running", "Running", P.ring, (r) => r.state === "running"],
        ["idle", "Recent", P.clock, (r) => r.state === "idle"],
      ];
      return defs
        .map(([key, name, icon, test]) => ({
          key,
          name,
          icon,
          root: null as string | null,
          rows: shown().filter(test),
        }))
        .filter((g) => g.rows.length > 0);
    }
    return state.projects
      .map((p) => ({
        key: p.path,
        name: p.name,
        icon: P.folder,
        root: p.path as string | null,
        rows: shown().filter((r) => r.root === p.path),
      }))
      .filter((g) => g.rows.length > 0 || !narrowed());
  });

  const isOpen = (key: string) => narrowed() || !state.prefs.fold[key];
  const down = createMemo(() => state.projects.find((p) => p.conn === "down"));
  const isOn = (r: Row) =>
    (state.view === "session" || state.view === "review") &&
    state.current?.root === r.root &&
    state.current.id === r.id;
  const nav = (on: boolean) => ({
    class: on ? "side-row on" : "side-row",
    "aria-current": on ? ("page" as const) : undefined,
  });

  return (
    <nav aria-label="Sessions" class={state.prefs.side ? "sb on" : "sb off"}>
      <div
        style={{
          display: "flex",
          "align-items": "center",
          "justify-content": "space-between",
          height: "32px",
          padding: "0 4px 0 10px",
          "margin-bottom": "8px",
        }}
      >
        <span style={{ "font-weight": 600 }}>Agency</span>
        <button type="button" class="ic" aria-label="Hide sidebar" onClick={() => savePrefs({ side: false })}>
          <I d={P.sidebar} />
        </button>
      </div>

      <button
        type="button"
        {...nav(state.view === "new" || state.view === "welcome")}
        onClick={() => goNew()}
      >
        <I d={P.compose} />
        <span style={{ flex: 1 }}>New session</span>
      </button>
      <button type="button" {...nav(state.view === "skills")} onClick={() => setState({ view: "skills" })}>
        <I d={P.skill} />
        <span style={{ flex: 1 }}>Skills</span>
      </button>
      <button
        type="button"
        {...nav(state.view === "workflows")}
        onClick={() => setState({ view: "workflows" })}
      >
        <I d={P.workflow} />
        <span style={{ flex: 1 }}>Workflows</span>
      </button>

      <Show when={rows().length > 0}>
        <div
          style={{
            display: "flex",
            "align-items": "center",
            gap: "2px",
            height: "28px",
            padding: "0 2px 0 10px",
            "margin-top": "18px",
            color: "var(--muted)",
          }}
        >
          <span style={{ flex: 1 }}>
            {state.filter === "all" ? "Sessions" : FILTERS.find((f) => f.value === state.filter)?.label}
          </span>
          <div style={{ position: "relative" }}>
            <button
              type="button"
              class="ic"
              aria-label="Filter sessions"
              aria-haspopup="menu"
              onClick={() => toggleMenu("filter")}
              style={
                state.filter === "all"
                  ? {}
                  : { color: "var(--accent-text)", background: "var(--accent-tint)" }
              }
            >
              <I d={P.filter} size={15} />
            </button>
            <Pop id="filter" label="Filter sessions" style={{ top: "32px", right: 0, width: "220px" }}>
              <Choices
                items={FILTERS.map((f) => ({
                  ...f,
                  desc: String(rows().filter((r) => matches(r, f.value)).length),
                }))}
                current={state.filter}
                pick={(v) => setState("filter", v)}
              />
              <div class="mi-sep" />
              <div class="mi-head">Group by</div>
              <Choices
                items={[
                  { value: "project" as const, label: "Project" },
                  { value: "status" as const, label: "Status" },
                ]}
                current={state.prefs.layout}
                pick={(v) => savePrefs({ layout: v })}
              />
            </Pop>
          </div>
        </div>
        <label
          style={{
            display: "flex",
            "align-items": "center",
            gap: "8px",
            height: "30px",
            padding: "0 10px",
            margin: "2px 0 8px",
            "border-radius": "8px",
            background: "var(--raised)",
            border: "1px solid var(--line)",
            "box-sizing": "border-box",
            color: "var(--muted)",
            flex: "none",
          }}
        >
          <I d={P.search} size={14} sw={1.7} />
          <span class="sr">Search sessions</span>
          <input
            type="search"
            placeholder="Search"
            value={state.q}
            onInput={(e) => setState("q", e.currentTarget.value)}
            style={{ flex: 1, "min-width": 0, border: 0, outline: "none", padding: 0 }}
          />
        </label>
      </Show>
      <Show when={rows().length === 0 && state.projects.length > 0}>
        <p style={{ margin: "18px 10px 0", color: "var(--muted)" }}>No sessions yet.</p>
      </Show>
      <Show when={rows().length > 0 && shown().length === 0}>
        <p style={{ margin: "6px 10px", color: "var(--muted)" }}>
          No sessions match.{" "}
          <button type="button" class="link" onClick={() => setState({ q: "", filter: "all" })}>
            Clear
          </button>
        </p>
      </Show>

      <For each={groups()}>
        {(g) => (
          <section
            aria-label={g.name}
            style={{ "margin-bottom": "4px", display: "flex", "flex-direction": "column" }}
          >
            <button
              type="button"
              class="side-row grp"
              aria-expanded={isOpen(g.key)}
              style={{ "font-weight": 600, "font-size": "14px" }}
              onClick={() => {
                if (!narrowed()) savePrefs({ fold: { ...state.prefs.fold, [g.key]: isOpen(g.key) } });
              }}
            >
              <I d={g.icon} class="grp-ic" />
              <I
                d={P.chevR}
                class="grp-chev"
                sw={1.8}
                style={isOpen(g.key) ? { transform: "rotate(90deg)" } : {}}
              />
              <span class="ell" style={{ flex: 1 }} title={g.root ?? undefined}>
                {g.name}
              </span>
              <span style={{ color: "var(--muted)", "font-weight": 400 }}>
                {isOpen(g.key) ? "" : String(g.rows.length)}
              </span>
            </button>
            <For each={isOpen(g.key) ? g.rows : []}>
              {(r) => (
                <Show
                  when={renaming() !== keyOf(r.root, r.id)}
                  fallback={
                    <input
                      class="side-rename"
                      aria-label="Session name"
                      value={draft()}
                      onInput={(e) => setDraft(e.currentTarget.value)}
                      ref={(el) =>
                        setTimeout(() => {
                          el.focus();
                          if (selected === renaming()) return;
                          selected = renaming();
                          el.select();
                        })
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter") e.currentTarget.blur();
                        if (e.key === "Escape") setRenaming(null);
                      }}
                      onBlur={() => {
                        if (renaming() !== keyOf(r.root, r.id)) return;
                        setRenaming(null);
                        if (draft().trim() !== r.title) void renameSession(r.root, r.id, draft());
                      }}
                    />
                  }
                >
                  <button
                    type="button"
                    class={isOn(r) ? "side-row sess on" : "side-row sess"}
                    aria-current={isOn(r) ? "page" : undefined}
                    onClick={() => openSession(r.root, r.id)}
                    onContextMenu={(e) => openRowMenu(r, e)}
                  >
                    <span class="ell" style={{ flex: 1 }}>
                      {r.title}
                    </span>
                    <Show when={r.state === "running"}>
                      <Spinner label="Running" />
                    </Show>
                    <Show when={r.state === "needs"}>
                      <I d={P.alert} size={14} sw={2} stroke="var(--amber)" label="Needs approval" />
                    </Show>
                    <Show when={r.state === "failed"}>
                      <I d={P.fail} size={14} sw={2} stroke="var(--red)" label="Turn failed" />
                    </Show>
                    <Show when={r.state === "idle"}>
                      <span style={{ color: "var(--muted)" }}>{r.meta}</span>
                    </Show>
                  </button>
                </Show>
              )}
            </For>
          </section>
        )}
      </For>

      <div style={{ flex: 1, "min-height": "16px" }} />
      <UpdateBanner />
      <Show when={down()}>
        {(p) => (
          <div role="alert" class="down">
            <div style={{ display: "flex", "flex-direction": "column", gap: "2px" }}>
              <span style={{ display: "flex", "align-items": "center", gap: "8px", "font-weight": 600 }}>
                <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true" style={{ flex: "none" }}>
                  <circle cx="12" cy="12" r="10" fill="var(--red-fill)" />
                  <path d="M12 7v6M12 16.5h.01" stroke="#FFFFFF" stroke-width="2.4" stroke-linecap="round" />
                </svg>
                {p().untrusted ? `${p().name} is not trusted` : "Daemon stopped"}
              </span>
              <span style={{ color: "var(--muted)", "padding-left": "23px", "overflow-wrap": "anywhere" }}>
                {p().untrusted
                  ? "Trust the folder to load its instructions and tools."
                  : p().error || "Sessions are paused."}
              </span>
            </div>
            <Show
              when={p().untrusted}
              fallback={
                <button
                  type="button"
                  class="pri"
                  style={{ height: "30px", "justify-content": "center" }}
                  onClick={() => void restartDaemon(p().path)}
                >
                  Restart daemon
                </button>
              }
            >
              <button
                type="button"
                class="pri"
                style={{ height: "30px", "justify-content": "center" }}
                onClick={() => void trustProject(p().path)}
              >
                Trust {p().name}
              </button>
            </Show>
          </div>
        )}
      </Show>
      <button type="button" class="side-row" onClick={() => void pickFolder()}>
        <I d={P.folder} />
        <span style={{ flex: 1 }}>Open folder</span>
      </button>
      <button type="button" class="side-row" onClick={() => setState("settings", true)}>
        <I d={P.gear} />
        <span style={{ flex: 1 }}>Settings</span>
      </button>

      <Show when={openMenu() === "row-menu" && menuAt()}>
        {(m) => (
          <div
            role="menu"
            aria-label={`Actions for ${m().row.title}`}
            class="pop"
            style={{ position: "fixed", left: `${m().x}px`, top: `${m().y}px`, width: "200px" }}
            ref={(el) => setTimeout(() => el.querySelector<HTMLElement>("button")?.focus())}
          >
            <button
              type="button"
              role="menuitem"
              class="mi"
              onClick={act((r) => {
                setDraft(r.title);
                selected = null;
                setRenaming(keyOf(r.root, r.id));
              })}
            >
              Rename
            </button>
            <button
              type="button"
              role="menuitem"
              class="mi"
              onClick={act((r) => void duplicateSession(r.root, r.id))}
            >
              Duplicate
            </button>
            <button
              type="button"
              role="menuitem"
              class="mi"
              onClick={act((r) => archiveSession(r.root, r.id, !r.archived))}
            >
              {m().row.archived ? "Unarchive" : "Archive"}
            </button>
            <button
              type="button"
              role="menuitem"
              class="mi"
              onClick={act(
                (r) =>
                  void navigator.clipboard
                    .writeText(r.id)
                    .then(() => toast("Copied the session ID"))
                    .catch(() => toast("Could not copy to the clipboard.", { tone: "err" })),
              )}
            >
              Copy session ID
            </button>
            <div class="mi-sep" />
            <button
              type="button"
              role="menuitem"
              class="mi"
              style={{ color: "var(--red)" }}
              disabled={!!state.live[keyOf(m().row.root, m().row.id)]}
              title={state.live[keyOf(m().row.root, m().row.id)] ? "Stop the turn first" : undefined}
              onClick={act((r) => setDoomed(r))}
            >
              Delete
            </button>
          </div>
        )}
      </Show>

      <Show when={doomed()}>
        {(r) => (
          // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: Escape and a click outside close it
          <div
            class="dialog-scrim"
            onClick={(e) => {
              if (e.target === e.currentTarget) setDoomed(null);
            }}
          >
            <div
              class="confirm"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="del-title"
              onKeyDown={(e) => {
                if (e.key === "Escape") setDoomed(null);
              }}
            >
              <h2 id="del-title">Delete this session?</h2>
              <p>"{r().title}" and its history are removed from this computer. This cannot be undone.</p>
              <div style={{ display: "flex", gap: "6px", "justify-content": "flex-end" }}>
                <button
                  type="button"
                  class="gh"
                  ref={(el) => setTimeout(() => el.focus())}
                  onClick={() => setDoomed(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  class="pri danger"
                  onClick={() => {
                    setDoomed(null);
                    void deleteSession(r().root, r().id);
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        )}
      </Show>
    </nav>
  );
}

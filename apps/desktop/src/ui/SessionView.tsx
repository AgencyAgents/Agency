import { createMemo, createSignal, For, Show } from "solid-js";
import { errorText, host } from "../lib/host.ts";
import {
  project,
  refreshGit,
  savePrefs,
  sessionTitle,
  setState,
  state,
  toast,
  undoTurn,
} from "../lib/store.ts";
import { Composer } from "./Composer.tsx";
import { I, P } from "./icons.tsx";
import { Choices, closeMenu, openMenu, Pop, toggleMenu } from "./menu.tsx";
import { Review } from "./Review.tsx";
import { pickFolder } from "./Sidebar.tsx";
import { Transcript } from "./Transcript.tsx";

export function SideToggle() {
  return (
    <Show when={!state.prefs.side}>
      <button
        type="button"
        class="ic"
        aria-label="Show sidebar"
        onClick={() => savePrefs({ side: true })}
        style={{ "margin-left": "-12px" }}
      >
        <I d={P.sidebar} />
      </button>
    </Show>
  );
}

export function Toast() {
  return (
    <Show when={state.toast}>
      {(t) => (
        <div role="status" class="toast">
          <Show
            when={t().tone === "err"}
            fallback={
              <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" style={{ flex: "none" }}>
                <circle cx="12" cy="12" r="10" fill="#34C759" />
                <path
                  d="m7.5 12.5 3 3 6-6.5"
                  fill="none"
                  stroke="#FFFFFF"
                  stroke-width="2.4"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            }
          >
            <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" style={{ flex: "none" }}>
              <circle cx="12" cy="12" r="10" fill="#E5484D" />
              <path d="M12 7v6M12 16.5h.01" stroke="#FFFFFF" stroke-width="2.4" stroke-linecap="round" />
            </svg>
          </Show>
          <span class="ell" style={{ "max-width": "60vw" }}>
            {t().text}
          </span>
          <Show when={t().act}>
            {(a) => (
              <button
                type="button"
                class="toast-act"
                onClick={() => {
                  a().run();
                  setState("toast", null);
                }}
              >
                {a().label}
              </button>
            )}
          </Show>
          <button type="button" class="toast-x" aria-label="Dismiss" onClick={() => setState("toast", null)}>
            <I d={P.x} size={13} sw={2} />
          </button>
        </div>
      )}
    </Show>
  );
}

function changes(root: string | null | undefined) {
  const files = project(root)?.git?.files ?? [];
  return {
    files,
    added: files.reduce((n, f) => n + (f.added ?? 0), 0),
    deleted: files.reduce((n, f) => n + (f.deleted ?? 0), 0),
  };
}

function Header(props: { root: string; id: string }) {
  const p = () => project(props.root);
  const title = () =>
    sessionTitle(
      props.root,
      p()?.rows.find((r) => r.id === props.id),
      props.id,
    );
  const diff = () => changes(props.root);
  const inReview = () => state.view === "review";
  const [message, setMessage] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  const run = async (label: string, work: () => Promise<string | undefined>) => {
    closeMenu();
    setBusy(true);
    try {
      const out = await work();
      toast(typeof out === "string" && out ? out : label);
    } catch (error) {
      toast(errorText(error), { tone: "err" });
    } finally {
      setBusy(false);
      void refreshGit(props.root);
    }
  };
  const commit = (push: boolean) =>
    run(push ? "Committed and pushed" : "Committed", async () => {
      const msg = message().trim() || title();
      const hash = await host.gitCommit(
        props.root,
        msg,
        diff().files.map((f) => f.path),
      );
      if (push) await host.gitPush(props.root);
      setMessage("");
      return `${push ? "Committed and pushed" : "Committed"} ${diff().files.length} file${diff().files.length === 1 ? "" : "s"} as ${hash}`;
    });

  return (
    <header class="pad bar">
      <SideToggle />
      <h1>{title()}</h1>
      <span class="hide-sm ell" style={{ color: "var(--muted)" }}>
        {p()?.name}
      </span>
      <div style={{ flex: 1 }} />

      <div class="hide-sm" style={{ position: "relative" }}>
        <button
          type="button"
          class="ol"
          aria-haspopup="menu"
          aria-expanded={openMenu() === "open"}
          onClick={() => toggleMenu("open")}
        >
          <I d={P.open} size={15} />
          Open
          <I d={P.chevD} size={10} sw={2.4} stroke="var(--muted)" />
        </button>
        <Pop id="open" label="Open the project in" style={{ top: "34px", right: 0, width: "200px" }}>
          <For
            each={
              [
                ["vscode", "VS Code"],
                ["zed", "Zed"],
                ["files", "File Explorer"],
                ["terminal", "Terminal"],
              ] as const
            }
          >
            {([target, label]) => (
              <button
                type="button"
                role="menuitem"
                class="mi"
                onClick={() => {
                  closeMenu();
                  host.openIn(props.root, target).catch((e) => toast(errorText(e), { tone: "err" }));
                }}
              >
                {label}
              </button>
            )}
          </For>
        </Pop>
      </div>

      <Show when={p()?.git?.repo}>
        <div style={{ position: "relative" }}>
          <div style={{ display: "flex" }}>
            <button
              type="button"
              class="ol"
              aria-haspopup="dialog"
              aria-expanded={openMenu() === "commit"}
              disabled={diff().files.length === 0 || busy()}
              onClick={() => toggleMenu("commit")}
              style={{ "border-radius": "8px 0 0 8px" }}
            >
              <I d={P.commit} size={15} />
              Commit
            </button>
            <button
              type="button"
              class="ol"
              aria-label="More commit options"
              aria-haspopup="menu"
              onClick={() => toggleMenu("more")}
              style={{ "border-left": 0, "border-radius": "0 8px 8px 0", padding: "0 7px" }}
            >
              <I d={P.chevD} size={10} sw={2.4} stroke="var(--muted)" />
            </button>
          </div>
          <Pop
            id="commit"
            role="dialog"
            label="Commit changes"
            style={{
              top: "34px",
              right: 0,
              width: "320px",
              padding: "14px",
              display: "flex",
              "flex-direction": "column",
              gap: "10px",
            }}
          >
            <div style={{ display: "flex", "justify-content": "space-between", color: "var(--muted)" }}>
              <span>{`${diff().files.length} file${diff().files.length === 1 ? "" : "s"} on ${p()?.git?.branch ?? "HEAD"}`}</span>
              <span style={{ "font-weight": 500 }}>
                <span class="add">+{diff().added}</span> <span class="del">−{diff().deleted}</span>
              </span>
            </div>
            <label for="commit-msg" class="sr">
              Commit message
            </label>
            <textarea
              id="commit-msg"
              rows={3}
              value={message()}
              placeholder={title()}
              onInput={(e) => setMessage(e.currentTarget.value)}
              style={{
                resize: "none",
                border: "1px solid var(--line)",
                "border-radius": "8px",
                padding: "8px 10px",
                outline: "none",
              }}
            />
            <div style={{ display: "flex", gap: "6px", "justify-content": "flex-end" }}>
              <button type="button" class="gh" onClick={closeMenu}>
                Cancel
              </button>
              <button type="button" class="pri" disabled={busy()} onClick={() => void commit(false)}>
                Commit
              </button>
            </div>
          </Pop>
          <Pop id="more" label="Commit options" style={{ top: "34px", right: 0, width: "220px" }}>
            <button
              type="button"
              role="menuitem"
              class="mi"
              disabled={diff().files.length === 0}
              onClick={() => void commit(true)}
            >
              Commit and push
            </button>
            <button
              type="button"
              role="menuitem"
              class="mi"
              onClick={() => void run("Pushed", () => host.gitPush(props.root).then(() => undefined))}
            >
              Push
            </button>
            <button
              type="button"
              role="menuitem"
              class="mi"
              onClick={() =>
                void run("Opened a pull request", async () => {
                  const url = await host.prCreate(props.root);
                  return url ? `Opened ${url}` : "Opened a pull request";
                })
              }
            >
              Create pull request
            </button>
            <div class="mi-sep" />
            <button
              type="button"
              role="menuitem"
              class="mi"
              onClick={() => {
                closeMenu();
                void undoTurn(props.root, props.id);
              }}
            >
              Undo last turn
            </button>
          </Pop>
        </div>
      </Show>

      <span aria-hidden="true" class="vsep" />
      <Show when={diff().files.length > 0}>
        <button
          type="button"
          class="gh"
          aria-label={`Review changes: ${diff().added} lines added, ${diff().deleted} removed`}
          aria-pressed={inReview()}
          onClick={() => setState("view", inReview() ? "session" : "review")}
          style={inReview() ? { background: "var(--pressed)" } : {}}
        >
          <span class="add">+{diff().added}</span>
          <span class="del">−{diff().deleted}</span>
        </button>
      </Show>
      <button
        type="button"
        class="ic"
        aria-label="Toggle details panel"
        aria-pressed={state.prefs.panel}
        onClick={() => {
          setState("panelAnim", true);
          savePrefs({ panel: !state.prefs.panel });
        }}
        style={state.prefs.panel ? { background: "var(--pressed)" } : {}}
      >
        <I d={P.panel} />
      </button>
    </header>
  );
}

function NewHero() {
  const root = () => state.newRoot;
  const p = () => project(root());
  const git = () => p()?.git;
  const projectState = () => {
    const g = git();
    if (!g) return "";
    if (!g.repo) return "Not a git repository. Changes are not tracked.";
    const dirty = g.files?.length ?? 0;
    const head = dirty === 0 ? "Nothing to commit." : `${dirty} uncommitted file${dirty === 1 ? "" : "s"}.`;
    return g.lastCommit?.hash ? `${head} Last commit ${g.lastCommit.hash}, ${g.lastCommit.when}.` : head;
  };
  const switchBranch = async (branch: string) => {
    const r = root();
    if (!r || branch === git()?.branch) return;
    try {
      await host.gitSwitch(r, branch);
      toast(`Switched to ${branch}`);
    } catch (error) {
      toast(errorText(error), { tone: "err" });
    }
    void refreshGit(r);
  };
  return (
    <div
      style={{
        flex: 1,
        "min-height": 0,
        display: "flex",
        "flex-direction": "column",
        position: "relative",
        "z-index": 5,
      }}
    >
      <div
        class="pad hero-in"
        style={{
          flex: 1,
          display: "flex",
          "flex-direction": "column",
          "align-items": "center",
          "justify-content": "flex-end",
          "text-align": "center",
          gap: "6px",
          padding: "32px 32px 28px",
        }}
      >
        <div
          style={{
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
            "flex-wrap": "wrap",
            gap: "0 2px",
          }}
        >
          <h2
            style={{
              margin: 0,
              "font-size": "24px",
              "line-height": 1.25,
              "font-weight": 600,
              "letter-spacing": "-0.4px",
            }}
          >
            What should we work on in
          </h2>
          <div style={{ position: "relative" }}>
            <button
              type="button"
              class="gh"
              aria-haspopup="menu"
              aria-expanded={openMenu() === "project"}
              onClick={() => toggleMenu("project")}
              style={{
                height: "38px",
                padding: "0 8px",
                "border-radius": "10px",
                "font-size": "24px",
                "font-weight": 600,
                "letter-spacing": "-0.4px",
                color: "var(--muted)",
              }}
            >
              {p()?.name ?? "a project"}
              <I d={P.chevD} size={14} sw={2.4} />
            </button>
            <Pop
              id="project"
              label="Project"
              style={{
                top: "44px",
                left: "50%",
                transform: "translateX(-50%)",
                width: "300px",
                "text-align": "left",
              }}
            >
              <Choices
                items={state.projects.map((x) => ({ value: x.path, label: x.name, desc: x.path }))}
                current={root() ?? ""}
                pick={(v) => setState("newRoot", v)}
                two
              />
              <div class="mi-sep" />
              <button
                type="button"
                role="menuitem"
                class="mi"
                onClick={() => {
                  closeMenu();
                  void pickFolder();
                }}
              >
                <span class="mi-check" />
                Open folder
              </button>
            </Pop>
          </div>
        </div>
        <div
          style={{
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
            "flex-wrap": "wrap",
            gap: "2px",
            color: "var(--muted)",
            "font-size": "14px",
          }}
        >
          <span>Runs</span>
          <span
            class="gh"
            style={{
              height: "30px",
              gap: "6px",
              color: "var(--text)",
              "font-weight": 500,
              cursor: "default",
              background: "transparent",
            }}
          >
            <I d={P.laptop} size={15} />
            Local
          </span>
          <Show when={git()?.repo}>
            <span>on</span>
            <div style={{ position: "relative" }}>
              <button
                type="button"
                class="gh"
                aria-haspopup="menu"
                aria-expanded={openMenu() === "branch"}
                onClick={() => toggleMenu("branch")}
                style={{ height: "30px", gap: "6px", color: "var(--text)", "font-weight": 500 }}
              >
                <I d={P.branch} size={15} />
                {git()?.branch || "detached HEAD"}
                <I d={P.chevD} size={10} sw={2.4} />
              </button>
              <Pop
                id="branch"
                label="Branches"
                style={{
                  top: "calc(100% + 6px)",
                  left: "50%",
                  transform: "translateX(-50%)",
                  width: "240px",
                  "text-align": "left",
                }}
              >
                <Choices
                  items={(git()?.branches ?? []).map((b) => ({ value: b, label: b }))}
                  current={git()?.branch ?? ""}
                  pick={(v) => void switchBranch(v)}
                />
              </Pop>
            </div>
          </Show>
        </div>
        <p style={{ margin: 0, "font-size": "12.5px", color: "var(--muted)" }}>{projectState()}</p>
      </div>
    </div>
  );
}

function Welcome() {
  return (
    <div
      class="pad"
      style={{
        flex: 1,
        "min-height": 0,
        display: "flex",
        "flex-direction": "column",
        "align-items": "center",
        "justify-content": "center",
        gap: "14px",
        padding: "32px 32px 84px",
        "text-align": "center",
      }}
    >
      <span
        style={{
          width: "48px",
          height: "48px",
          "border-radius": "13px",
          display: "flex",
          "align-items": "center",
          "justify-content": "center",
          background: "var(--fill)",
          color: "var(--text-2)",
        }}
      >
        <I d={P.folder} size={22} sw={1.6} />
      </span>
      <h2
        style={{
          margin: 0,
          "font-size": "22px",
          "line-height": 1.25,
          "font-weight": 600,
          "letter-spacing": "-0.3px",
        }}
      >
        Open a project to start
      </h2>
      <button
        type="button"
        class="pri"
        onClick={() => void pickFolder()}
        style={{ height: "34px", padding: "0 16px", "margin-top": "6px" }}
      >
        Open folder
      </button>
    </div>
  );
}

export function SessionView() {
  const isNew = () => state.view === "new";
  const cur = () => state.current;
  const root = () => (isNew() ? state.newRoot : (cur()?.root ?? null));
  const banner = createMemo(() => {
    const p = project(root());
    if (!p || p.conn === "up") return null;
    return p.conn === "connecting" ? "Connecting to the daemon" : null;
  });
  return (
    <main class="view">
      <Show
        when={!isNew() && state.view !== "welcome" && cur()}
        fallback={
          <header class="pad bar">
            <SideToggle />
            <Show when={isNew()}>
              <h1>New session</h1>
            </Show>
          </header>
        }
      >
        {(c) => <Header root={c().root} id={c().id} />}
      </Show>
      <Toast />
      <Show when={state.view === "welcome"}>
        <Welcome />
      </Show>
      <Show when={isNew()}>
        <NewHero />
      </Show>
      <Show when={state.view === "session" && cur()} keyed>
        {(c) => <Transcript root={c.root} id={c.id} />}
      </Show>
      <Show when={state.view === "review" && cur()} keyed>
        {(c) => <Review root={c.root} id={c.id} />}
      </Show>
      <Show when={state.view !== "welcome"}>
        <Show when={banner()}>
          {(text) => (
            <div class="pad" style={{ padding: "0 32px" }}>
              <div class="banner" role="status">
                <span class="shimmer">{text()}</span>
              </div>
            </div>
          )}
        </Show>
        <Composer
          root={root()}
          id={isNew() ? null : (cur()?.id ?? null)}
          isNew={isNew()}
          inReview={state.view === "review"}
        />
      </Show>
      <Show when={isNew()}>
        <div style={{ flex: 1 }} />
      </Show>
    </main>
  );
}

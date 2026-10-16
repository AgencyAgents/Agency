import { createEffect, createMemo, createSignal, For, type JSX, on, onCleanup, Show } from "solid-js";
import { createStore } from "solid-js/store";
import { errorText, host } from "../lib/host.ts";
import {
  goNew,
  keyOf,
  openSession,
  project,
  rpcWhenUp,
  setState,
  state,
  toast,
  trustProject,
} from "../lib/store.ts";
import { I, P, Spinner } from "./icons.tsx";
import { Choices, Pop, toggleMenu } from "./menu.tsx";
import { SideToggle, Toast } from "./SessionView.tsx";

interface Skill {
  name: string;
  description?: string;
  path: string;
  tier: "project" | "user";
  origin: string;
  allowedTools: string[];
  fork: boolean;
  userInvocable: boolean;
  modelInvocable: boolean;
  body: string;
  enabled: boolean;
}

const GROUPS = ["Your skills", "From other agents", "From plugins"];
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const NEW_DESC = "When Agency should use this skill";
const NEW_BODY = "The steps Agency follows when the skill runs.";

const groupOf = (s: Skill) =>
  s.origin === "This workspace" || s.origin === "Your user folder"
    ? 0
    : s.origin.startsWith("Plugin")
      ? 2
      : 1;

/** The SKILL.md a skill is stored as. */
const fileOf = (name: string, desc: string, tools: string[], fork: boolean, body: string) =>
  `---\nname: ${name}\ndescription: ${desc}${tools.length ? `\nallowed-tools: ${tools.join(", ")}` : ""}${
    fork ? "\ncontext: fork" : ""
  }\n---\n\n${body}`;

const tile = (size: number, on: boolean): JSX.CSSProperties => ({
  width: `${size}px`,
  height: `${size}px`,
  flex: "none",
  "border-radius": `${Math.round(size / 3.6)}px`,
  display: "flex",
  "align-items": "center",
  "justify-content": "center",
  background: "var(--fill)",
  color: "var(--text-2)",
  opacity: on ? 1 : 0.5,
});

const chip: JSX.CSSProperties = {
  height: "24px",
  display: "inline-flex",
  "align-items": "center",
  padding: "0 9px",
  background: "var(--fill)",
  "border-radius": "7px",
  "font-size": "12.5px",
};

const crumbSep = <I d="m9 6 6 6-6 6" size={11} sw={2.2} stroke="var(--disabled)" />;

function Switch(props: { on: boolean; label: string; flip: () => void; lg?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      class={props.lg ? "switch lg" : "switch"}
      aria-checked={props.on ? "true" : "false"}
      aria-label={props.label}
      onClick={props.flip}
    >
      <span />
    </button>
  );
}

function Fact(props: { label: string; last?: boolean; children: JSX.Element }) {
  const edge = () => (props.last ? "none" : "1px solid var(--line-soft)");
  return (
    <>
      <dt style={{ padding: "12px 16px", color: "var(--muted)", "border-bottom": edge() }}>{props.label}</dt>
      <dd
        style={{
          margin: 0,
          padding: "10px 16px",
          "min-height": "24px",
          display: "flex",
          "align-items": "center",
          gap: "6px",
          "flex-wrap": "wrap",
          "overflow-wrap": "anywhere",
          "border-bottom": edge(),
        }}
      >
        {props.children}
      </dd>
    </>
  );
}

function Preview(props: { title: string; right: JSX.Element; text: string }) {
  return (
    <div style={{ border: "1px solid var(--line-soft)", "border-radius": "12px", overflow: "hidden" }}>
      <div
        style={{
          height: "40px",
          display: "flex",
          "align-items": "center",
          gap: "8px",
          padding: "0 8px 0 16px",
          "border-bottom": "1px solid var(--line-soft)",
          background: "var(--fill-3)",
        }}
      >
        <span style={{ "font-weight": 500 }}>{props.title}</span>
        <div style={{ flex: 1, "min-width": 0, "text-align": "right" }}>{props.right}</div>
      </div>
      <pre
        class="mono"
        style={{
          margin: 0,
          padding: "16px",
          "font-size": "12.5px",
          "line-height": 1.7,
          "white-space": "pre-wrap",
          "overflow-wrap": "anywhere",
        }}
      >
        {props.text}
      </pre>
    </div>
  );
}

export default function Skills(_props: { onClose?: () => void }) {
  const [picked, setPicked] = createSignal<string | null>(null);
  const root = () => {
    const p = picked();
    return p && project(p) ? p : (state.current?.root ?? state.newRoot ?? state.projects[0]?.path ?? null);
  };
  const [skills, setSkills] = createSignal<Skill[] | null>(null);
  const [trusted, setTrusted] = createSignal(true);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [query, setQuery] = createSignal("");
  const [sel, setSel] = createSignal<string | null>(null);
  const [creating, setCreating] = createSignal(false);
  const [copied, setCopied] = createSignal(false);

  let seq = 0;
  /** Toggles not yet on disk, by skill name. */
  const wanted = new Map<string, boolean>();
  async function load(r: string | null, quiet = false) {
    const n = ++seq;
    if (!quiet) {
      setSkills(null);
      setError(null);
    }
    if (!r) {
      setLoading(false);
      return;
    }
    setLoading(!quiet);
    try {
      const res = await host.rpc<{ skills: Skill[]; trusted?: boolean }>(r, "skills_list");
      if (n !== seq) return;
      // A toggle still on its way to disk wins over what the file says now.
      setSkills(
        res.skills.map((s) => (wanted.has(s.name) ? { ...s, enabled: wanted.get(s.name) === true } : s)),
      );
      setTrusted(res.trusted !== false);
      setError(null);
    } catch (e) {
      if (n === seq && !quiet) setError(errorText(e));
    } finally {
      if (n === seq) setLoading(false);
    }
  }

  createEffect(
    on(root, (r) => {
      setSel(null);
      setCreating(false);
      void load(r);
    }),
  );
  // A daemon that comes back up (after a restart or a late start) refreshes the list in place.
  createEffect(
    on(
      () => project(root())?.conn,
      (conn) => {
        if (conn === "up") void load(root(), skills() !== null);
      },
      { defer: true },
    ),
  );

  const groups = createMemo(() => {
    const q = query().trim().toLowerCase();
    const list = (skills() ?? []).filter(
      (s) => !q || `${s.name} ${s.description ?? ""}`.toLowerCase().includes(q),
    );
    return GROUPS.map((title, i) => ({ title, rows: list.filter((s) => groupOf(s) === i) })).filter(
      (g) => g.rows.length > 0,
    );
  });
  const selected = createMemo(() => skills()?.find((s) => s.name === sel()) ?? null);
  const deep = () => creating() || selected() !== null;

  // Writes go out one at a time so the last toggle wins on disk.
  let queue: Promise<void> = Promise.resolve();
  function flip(name: string) {
    const r = root();
    const s = skills()?.find((x) => x.name === name);
    if (!r || !s) return;
    const next = !s.enabled;
    const setOn = (on: boolean) =>
      setSkills((l) => l?.map((x) => (x.name === name ? { ...x, enabled: on } : x)) ?? null);
    wanted.set(name, next);
    setOn(next);
    queue = queue.then(async () => {
      try {
        const value = (skills() ?? []).filter((x) => !x.enabled).map((x) => x.name);
        await rpcWhenUp(r, "config_write", { key: "skills.disabled", value });
        if (wanted.get(name) === next) wanted.delete(name);
      } catch (e) {
        wanted.delete(name);
        setOn(!next);
        toast(`Could not turn ${next ? "on" : "off"} ${name}. ${errorText(e)}`, { tone: "err" });
        return;
      }
      await Promise.allSettled(
        state.projects.filter((p) => p.conn === "up").map((p) => host.rpc(p.path, "daemon_restart")),
      );
      await load(r, true);
    });
  }

  function useInSession(name: string) {
    const r = root();
    if (!r) return;
    const cur = state.current;
    const here = cur && cur.root === r ? cur : null;
    const slot = here ? keyOf(here.root, here.id) : "new";
    const prev = state.composer[slot];
    setState("composer", slot, {
      draft: `/${name} ${prev?.draft ?? ""}`,
      attachments: prev?.attachments ?? [],
    });
    if (here) openSession(here.root, here.id);
    else goNew(r);
  }

  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(copyTimer));
  function copy(text: string) {
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        clearTimeout(copyTimer);
        copyTimer = setTimeout(() => setCopied(false), 1600);
      },
      () => toast("Could not copy to the clipboard.", { tone: "err" }),
    );
  }

  const blank = {
    name: "",
    desc: "",
    where: "project" as "project" | "user",
    fork: false,
    body: "",
    tried: false,
  };
  const [form, setForm] = createStore({ ...blank });
  const [saving, setSaving] = createSignal(false);
  const nameErr = () =>
    !form.name
      ? form.tried
        ? "Give the skill a name."
        : ""
      : !NAME_RE.test(form.name)
        ? "Use lowercase letters, digits and hyphens."
        : skills()?.some((s) => s.name === form.name)
          ? "A skill with this name already exists."
          : "";
  const newPath = () =>
    `${form.where === "project" ? ".agency/skills/" : "Agency user config/skills/"}${form.name || "name"}/SKILL.md`;
  const newFile = () =>
    fileOf(form.name || "name", form.desc.trim() || NEW_DESC, [], form.fork, form.body.trim() || NEW_BODY);

  function startCreate() {
    setForm({ ...blank });
    setCreating(true);
  }

  async function create(e: SubmitEvent) {
    e.preventDefault();
    const r = root();
    if (!r || saving()) return;
    if (!form.name || nameErr()) {
      setForm("tried", true);
      return;
    }
    const name = form.name;
    setSaving(true);
    try {
      await rpcWhenUp(r, "skill_write", {
        scope: form.where,
        name,
        description: form.desc.trim() || "No description yet.",
        fork: form.fork,
        body: form.body.trim() || "No instructions yet.",
      });
      await load(r, true);
      setQuery("");
      setCreating(false);
      setSel(name);
      toast(`Created ${name}`);
    } catch (err) {
      toast(`Could not create ${name}. ${errorText(err)}`, { tone: "err" });
    } finally {
      setSaving(false);
    }
  }

  const pageFrame: JSX.CSSProperties = { "padding-top": "20px" };
  const h = (size: number): JSX.CSSProperties => ({
    margin: 0,
    "font-size": `${size}px`,
    "line-height": 1.25,
    "font-weight": 600,
    "letter-spacing": size > 16 ? "-0.3px" : undefined,
  });

  const Home = () => (
    <div class="page pad" style={pageFrame}>
      <div style={{ display: "flex", "align-items": "center", gap: "16px", "flex-wrap": "wrap" }}>
        <h1 style={{ ...h(22), flex: 1, "min-width": "180px" }}>Skills</h1>
        <label class="search" style={{ width: "240px", "max-width": "100%" }}>
          <I d={P.search} size={14} sw={1.7} />
          <span class="sr">Search skills</span>
          <input
            type="search"
            placeholder="Search skills"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
        </label>
        <button type="button" class="pri" onClick={startCreate} disabled={!root()}>
          <I d={P.plus} size={13} sw={2.2} />
          New skill
        </button>
      </div>

      <Show when={!trusted() && root()}>
        {(r) => (
          <div class="banner" role="note" style={{ "justify-content": "space-between", gap: "12px" }}>
            <span>Skills in this folder load once you trust it.</span>
            <button type="button" class="ol" onClick={() => void trustProject(r())}>
              Trust folder
            </button>
          </div>
        )}
      </Show>

      <Show when={loading()}>
        <div
          role="status"
          style={{ display: "flex", "align-items": "center", gap: "8px", color: "var(--muted)" }}
        >
          <Spinner />
          Loading skills
        </div>
      </Show>
      <Show when={error()}>
        {(msg) => (
          <div
            role="alert"
            style={{ display: "flex", "align-items": "center", gap: "12px", "flex-wrap": "wrap" }}
          >
            <span style={{ color: "var(--red)", flex: "1 1 240px", "overflow-wrap": "anywhere" }}>
              Could not load skills. {msg()}
            </span>
            <button type="button" class="ol" onClick={() => void load(root())}>
              Retry
            </button>
          </div>
        )}
      </Show>

      <For each={groups()}>
        {(g) => (
          <section aria-label={g.title} style={{ display: "flex", "flex-direction": "column", gap: "10px" }}>
            <div style={{ display: "flex", "align-items": "baseline", gap: "8px" }}>
              <h2 style={h(13)}>{g.title}</h2>
              <span style={{ color: "var(--muted-2)", "font-size": "12px" }}>{g.rows.length}</span>
            </div>
            <div class="list">
              <For each={g.rows}>
                {(s) => (
                  <div class="lrow">
                    <button
                      type="button"
                      class="lrow-main"
                      aria-label={`Open ${s.name}`}
                      onClick={() => setSel(s.name)}
                    >
                      <span style={tile(32, s.enabled)}>
                        <I d={P.skill} sw={1.6} />
                      </span>
                      <span
                        style={{
                          flex: 1,
                          "min-width": 0,
                          display: "flex",
                          "flex-direction": "column",
                          gap: "1px",
                        }}
                      >
                        <span
                          class="ell"
                          style={{
                            "font-size": "13.5px",
                            "font-weight": 600,
                            color: s.enabled ? "var(--text)" : "var(--muted)",
                          }}
                        >
                          {s.name}
                        </span>
                        <span class="ell" style={{ color: "var(--muted)" }}>
                          {s.description || "No description"}
                        </span>
                      </span>
                      <span
                        class="hide-sm ell"
                        style={{
                          flex: "none",
                          "max-width": "180px",
                          color: "var(--muted-2)",
                          "font-size": "12px",
                          "text-align": "right",
                        }}
                      >
                        {s.origin}
                        {s.fork ? ", subagent" : ""}
                      </span>
                    </button>
                    <Switch
                      on={s.enabled}
                      label={`${s.enabled ? "Turn off" : "Turn on"} ${s.name}`}
                      flip={() => flip(s.name)}
                    />
                  </div>
                )}
              </For>
            </div>
          </section>
        )}
      </For>

      <Show when={skills() && groups().length === 0}>
        <div
          style={{
            padding: "40px 24px",
            border: "1px dashed var(--line-strong)",
            "border-radius": "14px",
            "text-align": "center",
            display: "flex",
            "flex-direction": "column",
            "align-items": "center",
            gap: "8px",
          }}
        >
          <span style={{ "font-weight": 600 }}>{query().trim() ? "No skill matches" : "No skills yet"}</span>
          <button type="button" class="ol" onClick={startCreate} style={{ "margin-top": "4px" }}>
            New skill
          </button>
        </div>
      </Show>
    </div>
  );

  const Detail = (props: { s: Skill }) => {
    const file = () =>
      fileOf(props.s.name, props.s.description ?? "", props.s.allowedTools, props.s.fork, props.s.body);
    return (
      <div class="page pad" style={pageFrame}>
        <div style={{ display: "flex", "align-items": "flex-start", gap: "16px", "flex-wrap": "wrap" }}>
          <span style={tile(48, props.s.enabled)}>
            <I d={P.skill} size={22} sw={1.6} />
          </span>
          <div
            style={{ flex: 1, "min-width": "220px", display: "flex", "flex-direction": "column", gap: "4px" }}
          >
            <h2 style={{ ...h(22), "overflow-wrap": "anywhere" }}>{props.s.name}</h2>
            <p style={{ margin: 0, "font-size": "14px", color: "var(--text-2)" }}>{props.s.description}</p>
            <span style={{ color: "var(--muted)" }}>{props.s.origin}</span>
          </div>
          <div style={{ display: "flex", gap: "6px", "align-items": "center" }}>
            <button type="button" class="ol" onClick={() => flip(props.s.name)}>
              {props.s.enabled ? "Turn off" : "Turn on"}
            </button>
            <button
              type="button"
              class="pri"
              disabled={!props.s.enabled}
              onClick={() => useInSession(props.s.name)}
            >
              Use in session
            </button>
          </div>
        </div>

        <dl
          style={{
            margin: 0,
            border: "1px solid var(--line-soft)",
            "border-radius": "12px",
            display: "grid",
            "grid-template-columns": "150px minmax(0, 1fr)",
          }}
        >
          <Show when={props.s.userInvocable}>
            <Fact label="Run it with">
              <span class="mono" style={chip}>
                /{props.s.name}
              </span>
            </Fact>
          </Show>
          <Fact label="Runs in">
            {props.s.fork ? "A subagent. Only its answer comes back." : "The current session"}
          </Fact>
          <Fact label="Allowed tools">
            <Show
              when={props.s.allowedTools.length > 0}
              fallback={<span style={{ color: "var(--muted)" }}>None. Each tool asks as usual.</span>}
            >
              <For each={props.s.allowedTools}>
                {(t) => (
                  <span class="mono" style={chip}>
                    {t}
                  </span>
                )}
              </For>
            </Show>
          </Fact>
          <Fact label="File" last>
            <span style={{ color: "var(--text-2)" }}>{props.s.path}</span>
          </Fact>
        </dl>

        <Preview
          title="SKILL.md"
          text={file()}
          right={
            <button
              type="button"
              class="gh"
              style={{ color: "var(--muted)", "margin-left": "auto" }}
              onClick={() => copy(file())}
            >
              {copied() ? "Copied" : "Copy"}
            </button>
          }
        />
      </div>
    );
  };

  const Form = () => (
    <form
      class="page pad"
      onSubmit={(e) => void create(e)}
      style={{
        ...pageFrame,
        "flex-direction": "row",
        "flex-wrap": "wrap",
        gap: "32px",
        "align-items": "flex-start",
      }}
    >
      <div
        style={{
          flex: "1 1 380px",
          "min-width": 0,
          display: "flex",
          "flex-direction": "column",
          gap: "22px",
        }}
      >
        <h2 style={h(22)}>New skill</h2>
        <label style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
          <span style={{ "font-weight": 500 }}>Name</span>
          <input
            class="field"
            type="text"
            value={form.name}
            onInput={(e) => setForm("name", e.currentTarget.value)}
            placeholder="release-notes"
            autocomplete="off"
            spellcheck={false}
            aria-invalid={nameErr() ? "true" : "false"}
            aria-describedby="skill-name-hint"
          />
          <Show when={nameErr()}>
            <span id="skill-name-hint" style={{ color: "var(--red)" }}>
              {nameErr()}
            </span>
          </Show>
        </label>
        <label style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
          <span style={{ "font-weight": 500 }}>Description</span>
          <input
            class="field"
            type="text"
            value={form.desc}
            onInput={(e) => setForm("desc", e.currentTarget.value)}
            placeholder={NEW_DESC}
          />
        </label>
        <div style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
          <span style={{ "font-weight": 500 }}>Location</span>
          <div role="radiogroup" aria-label="Location" class="seg" style={{ "align-self": "flex-start" }}>
            <For
              each={
                [
                  ["project", "This workspace"],
                  ["user", "All workspaces"],
                ] as const
              }
            >
              {([id, label]) => (
                // biome-ignore lint/a11y/useSemanticElements: .seg styles button[aria-checked]
                <button
                  type="button"
                  role="radio"
                  aria-checked={form.where === id ? "true" : "false"}
                  onClick={() => setForm("where", id)}
                >
                  {label}
                </button>
              )}
            </For>
          </div>
        </div>
        <div
          style={{
            display: "flex",
            "align-items": "center",
            gap: "16px",
            padding: "12px 14px",
            border: "1px solid var(--line-soft)",
            "border-radius": "12px",
          }}
        >
          <span style={{ flex: 1, "font-weight": 500 }}>Run in a subagent</span>
          <Switch lg on={form.fork} label="Run in a subagent" flip={() => setForm("fork", !form.fork)} />
        </div>
        <label style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
          <span style={{ "font-weight": 500 }}>Instructions</span>
          <textarea
            rows={7}
            value={form.body}
            onInput={(e) => setForm("body", e.currentTarget.value)}
            placeholder="The steps Agency follows when the skill runs"
            style={{
              resize: "none",
              padding: "10px 12px",
              border: "1px solid var(--line)",
              "border-radius": "9px",
              "line-height": 1.55,
            }}
          />
        </label>
        <div style={{ display: "flex", gap: "6px", "justify-content": "flex-end" }}>
          <button type="button" class="gh" onClick={() => setCreating(false)}>
            Cancel
          </button>
          <button type="submit" class="pri" disabled={saving()}>
            <Show when={saving()}>
              <Spinner />
            </Show>
            Create skill
          </button>
        </div>
      </div>
      <aside aria-label="Preview" style={{ flex: "1 1 300px", "min-width": 0, position: "sticky", top: 0 }}>
        <Preview
          title="SKILL.md"
          text={newFile()}
          right={
            <span class="ell" style={{ display: "block", color: "var(--muted)" }}>
              {newPath()}
            </span>
          }
        />
      </aside>
    </form>
  );

  return (
    <main class="view">
      <header class="pad bar">
        <SideToggle />
        <nav
          aria-label="Breadcrumb"
          style={{ display: "flex", "align-items": "center", gap: "4px", "min-width": 0 }}
        >
          <Show when={deep()}>
            <button
              type="button"
              class="gh"
              onClick={() => {
                setSel(null);
                setCreating(false);
              }}
              style={{ "margin-left": "-8px", color: "var(--muted)" }}
            >
              Skills
            </button>
            {crumbSep}
            <h1 style={{ "margin-left": "4px", "font-size": "13px" }}>{creating() ? "New skill" : sel()}</h1>
          </Show>
        </nav>
        <div style={{ flex: 1 }} />
        <Show when={state.projects.length > 1}>
          <div style={{ position: "relative" }}>
            <button
              type="button"
              class="gh"
              aria-haspopup="menu"
              aria-label={`Project: ${project(root())?.name ?? "none"}`}
              onClick={() => toggleMenu("skills-root")}
            >
              <I d={P.folder} size={15} />
              <span class="ell" style={{ "max-width": "160px" }}>
                {project(root())?.name}
              </span>
              <I d={P.chevD} size={12} sw={2} />
            </button>
            <Pop id="skills-root" label="Project" style={{ top: "32px", right: 0, width: "240px" }}>
              <Choices
                items={state.projects.map((p) => ({ value: p.path, label: p.name }))}
                current={root()}
                pick={setPicked}
              />
            </Pop>
          </div>
        </Show>
      </header>
      <Toast />
      <div style={{ flex: 1, "min-height": 0, "overflow-y": "auto" }}>
        <Show
          when={root()}
          fallback={
            <div class="page pad" style={{ ...pageFrame, color: "var(--muted)" }}>
              Add a project to see its skills.
            </div>
          }
        >
          <Show when={!creating()} fallback={<Form />}>
            <Show when={selected()} fallback={<Home />}>
              {(s) => <Detail s={s()} />}
            </Show>
          </Show>
        </Show>
      </div>
    </main>
  );
}

import { For, type JSX, Show } from "solid-js";
import { project, setState, state } from "../lib/store.ts";
import { I, P } from "./icons.tsx";
import { Choices, openMenu, Pop, toggleMenu } from "./menu.tsx";
import { SideToggle } from "./SessionView.tsx";

/* The frame of the Skills and Workflows pages. Both build from these parts, so they keep one structure. */

export const titleStyle: JSX.CSSProperties = {
  margin: 0,
  "font-size": "22px",
  "line-height": 1.25,
  "font-weight": 600,
  "letter-spacing": "-0.3px",
};

const chev = () => <I d="m9 6 6 6-6 6" size={11} sw={2.2} stroke="var(--disabled)" />;

/** The top bar: the trail back to the page's home, and the project the page shows. */
export function PageBar(props: {
  home: string;
  goHome: () => void;
  trail: { label: string; go?: () => void }[];
  root: string | null;
  pick: (path: string) => void;
  menu: string;
}) {
  return (
    <header class="pad bar">
      <SideToggle />
      <Show when={props.trail.length > 0}>
        <nav
          aria-label="Breadcrumb"
          class="crumb"
          style={{ display: "flex", "align-items": "center", gap: "4px", "min-width": 0 }}
        >
          <button
            type="button"
            class="gh"
            onClick={props.goHome}
            style={{ "margin-left": "-8px", color: "var(--muted)" }}
          >
            {props.home}
          </button>
          <For each={props.trail}>
            {(t, i) => (
              <>
                {chev()}
                <Show
                  when={i() < props.trail.length - 1}
                  fallback={<h1 style={{ margin: "0 0 0 4px" }}>{t.label}</h1>}
                >
                  <button
                    type="button"
                    class="gh"
                    onClick={() => t.go?.()}
                    style={{ color: "var(--muted)", "white-space": "nowrap" }}
                  >
                    {t.label}
                  </button>
                </Show>
              </>
            )}
          </For>
        </nav>
      </Show>
      <div style={{ flex: 1 }} />
      <Show when={state.projects.length > 1 && props.root}>
        {(r) => (
          <div style={{ position: "relative" }}>
            <button
              type="button"
              class="gh"
              aria-haspopup="menu"
              aria-expanded={openMenu() === props.menu}
              aria-label={`Project: ${project(r())?.name ?? "none"}`}
              onClick={() => toggleMenu(props.menu)}
            >
              <I d={P.folder} size={15} />
              <span class="ell" style={{ "max-width": "160px" }}>
                {project(r())?.name}
              </span>
              <I d={P.chevD} size={10} sw={2.4} stroke="var(--muted)" />
            </button>
            <Pop id={props.menu} label="Project" style={{ top: "34px", right: 0, width: "240px" }}>
              <Choices
                items={state.projects.map((p) => ({ value: p.path, label: p.name }))}
                current={r()}
                pick={props.pick}
              />
            </Pop>
          </div>
        )}
      </Show>
    </header>
  );
}

/** A page's home head: its name and what it is for, a search, and the button that makes a new one. */
export function PageHead(props: {
  title: string;
  sub: string;
  search: string;
  query: string;
  setQuery: (q: string) => void;
  add: string;
  onAdd: () => void;
  addOff?: boolean;
}) {
  return (
    <div style={{ display: "flex", "align-items": "center", gap: "16px", "flex-wrap": "wrap" }}>
      <div style={{ flex: 1, "min-width": "260px", display: "flex", "flex-direction": "column", gap: "4px" }}>
        <h1 style={titleStyle}>{props.title}</h1>
        <span style={{ color: "var(--muted)" }}>{props.sub}</span>
      </div>
      <label class="search" style={{ width: "240px", "max-width": "100%" }}>
        <I d={P.search} size={14} sw={1.7} />
        <span class="sr">{props.search}</span>
        <input
          type="search"
          placeholder={props.search}
          value={props.query}
          onInput={(e) => props.setQuery(e.currentTarget.value)}
        />
      </label>
      <button type="button" class="pri" onClick={props.onAdd} disabled={props.addOff}>
        <I d={P.plus} size={13} sw={2.2} />
        {props.add}
      </button>
    </div>
  );
}

export function Tile(props: { icon: string; big?: boolean; dim?: boolean }) {
  const size = () => (props.big ? 48 : 32);
  return (
    <span
      style={{
        width: `${size()}px`,
        height: `${size()}px`,
        flex: "none",
        "border-radius": props.big ? "13px" : "9px",
        display: "flex",
        "align-items": "center",
        "justify-content": "center",
        background: "var(--fill)",
        color: "var(--text-2)",
        opacity: props.dim ? 0.5 : 1,
      }}
    >
      <I d={props.icon} size={props.big ? 22 : 16} sw={1.6} />
    </span>
  );
}

/** One group of a home list, under its name and count. */
export function Group(props: { title: string; count: number; children: JSX.Element }) {
  return (
    <section aria-label={props.title} style={{ display: "flex", "flex-direction": "column", gap: "10px" }}>
      <div style={{ display: "flex", "align-items": "baseline", gap: "8px" }}>
        <h2 style={{ margin: 0, "font-size": "13px", "line-height": 1.25, "font-weight": 600 }}>
          {props.title}
        </h2>
        <span style={{ color: "var(--muted-2)", "font-size": "12px" }}>{props.count}</span>
      </div>
      <div class="list">{props.children}</div>
    </section>
  );
}

/** One row of a home list. The control after it acts on the item without opening it. */
export function Row(props: {
  icon: string;
  dim?: boolean;
  name: string;
  line: string;
  note: JSX.Element;
  open: () => void;
  children: JSX.Element;
}) {
  return (
    <div class="lrow">
      <button type="button" class="lrow-main" aria-label={`Open ${props.name}`} onClick={props.open}>
        <Tile icon={props.icon} dim={props.dim} />
        <span style={{ flex: 1, "min-width": 0, display: "flex", "flex-direction": "column", gap: "1px" }}>
          <span
            class="ell"
            style={{
              "font-size": "13.5px",
              "font-weight": 600,
              color: props.dim ? "var(--muted)" : "var(--text)",
            }}
          >
            {props.name}
          </span>
          <span class="ell" style={{ color: "var(--muted)" }}>
            {props.line}
          </span>
        </span>
        {props.note}
      </button>
      {props.children}
    </div>
  );
}

/** The box a home list shows when it has nothing to list. */
export function Empty(props: { title: string; text?: string; children: JSX.Element }) {
  return (
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
      <span style={{ "font-weight": 600 }}>{props.title}</span>
      <Show when={props.text}>
        <span style={{ color: "var(--muted)", "max-width": "380px" }}>{props.text}</span>
      </Show>
      {props.children}
    </div>
  );
}

/** The head of an item page: tile, name, what it does, a line of facts, and its actions. */
export function ItemHead(props: {
  icon: string;
  dim?: boolean;
  name: string;
  line: string;
  meta: string;
  children: JSX.Element;
}) {
  return (
    <div style={{ display: "flex", "align-items": "flex-start", gap: "16px", "flex-wrap": "wrap" }}>
      <Tile icon={props.icon} dim={props.dim} big />
      <div style={{ flex: 1, "min-width": "220px", display: "flex", "flex-direction": "column", gap: "4px" }}>
        <h2 style={{ ...titleStyle, "overflow-wrap": "anywhere" }}>{props.name}</h2>
        <p style={{ margin: 0, "font-size": "14px", color: "var(--text-2)" }}>{props.line}</p>
        <span style={{ color: "var(--muted)" }}>{props.meta}</span>
      </div>
      <div style={{ display: "flex", gap: "6px", "align-items": "center" }}>{props.children}</div>
    </div>
  );
}

/** A bordered block under a head row. Item pages and editor previews are made of these. */
export function Box(props: { title: string; right?: JSX.Element; children: JSX.Element }) {
  return (
    <section
      aria-label={props.title}
      style={{ border: "1px solid var(--line-soft)", "border-radius": "12px", overflow: "hidden" }}
    >
      <div
        style={{
          height: "40px",
          display: "flex",
          "align-items": "center",
          gap: "8px",
          padding: "0 16px",
          "border-bottom": "1px solid var(--line-soft)",
          background: "var(--fill-3)",
        }}
      >
        <span style={{ "font-weight": 500 }}>{props.title}</span>
        <div
          style={{
            flex: 1,
            "min-width": 0,
            display: "flex",
            "justify-content": "flex-end",
            color: "var(--muted)",
          }}
        >
          {props.right}
        </div>
      </div>
      {props.children}
    </section>
  );
}

/** An editor page: the form, and beside it a live preview of what it makes. */
export function EditFrame(props: {
  title: string;
  submit: (e: SubmitEvent) => void;
  preview: JSX.Element;
  children: JSX.Element;
}) {
  return (
    <form
      class="page pad"
      onSubmit={(e) => props.submit(e)}
      style={{ "flex-direction": "row", "flex-wrap": "wrap", gap: "32px", "align-items": "flex-start" }}
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
        <h2 style={titleStyle}>{props.title}</h2>
        {props.children}
      </div>
      <aside aria-label="Preview" style={{ flex: "1 1 280px", "min-width": 0, position: "sticky", top: 0 }}>
        {props.preview}
      </aside>
    </form>
  );
}

/** What a page shows before any project is open. */
export function NoProject(props: { title: string; text: string }) {
  return (
    <div class="page pad">
      <h1 style={titleStyle}>{props.title}</h1>
      <span style={{ color: "var(--muted)" }}>{props.text}</span>
      <button
        type="button"
        class="ol"
        style={{ "align-self": "flex-start" }}
        onClick={() => setState({ view: "welcome" })}
      >
        Open a project
      </button>
    </div>
  );
}

import { getVersion } from "@tauri-apps/api/app";
import { createMemo, createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { reconcile, unwrap } from "solid-js/store";
import { errorText, host } from "../lib/host.ts";
import { modelChoices, project, rpcWhenUp, savePrefs, setState, state, toast } from "../lib/store.ts";
import type { Effort, PermissionMode, ProvidersList } from "../lib/types.ts";
import { I, P } from "./icons.tsx";
import { type Choice, Choices, closeMenu, openMenu, Pop, toggleMenu } from "./menu.tsx";

type Json = Record<string, unknown>;

const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const tf = (b: boolean) => (b ? "true" : "false");
const dig = (c: Json, key: string): unknown => key.split(".").reduce<unknown>((a, k) => obj(a)[k], c);
const cap = (s: string) => (s ? s[0]?.toUpperCase() + s.slice(1) : s);
const plain = <T,>(v: T): T => JSON.parse(JSON.stringify(v ?? null)) as T;

const ICONS = {
  general:
    "M4 7h9M17 7h3M4 17h3M11 17h9M15 9.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4ZM9 19.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4Z",
  models:
    "M8.5 6h7A2.5 2.5 0 0 1 18 8.5v7a2.5 2.5 0 0 1-2.5 2.5h-7A2.5 2.5 0 0 1 6 15.5v-7A2.5 2.5 0 0 1 8.5 6ZM9.5 2.5V6M14.5 2.5V6M9.5 18v3.5M14.5 18v3.5M2.5 9.5H6M2.5 14.5H6M18 9.5h3.5M18 14.5h3.5",
  permissions: `${P.shield}m9 12 2 2 4-4`,
  sandbox: "M12 2.5 20.5 7v10L12 21.5 3.5 17V7ZM3.5 7 12 11.5 20.5 7M12 11.5v10",
  context: "M3.5 18a9 9 0 1 1 17 0ZM12 14l3.5-4",
  tools: "M7 11h10v3a5 5 0 0 1-10 0ZM9 3v8M15 3v8M12 19v2.5",
  hooks:
    "M6 4h12a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3ZM7.5 10l2.5 2-2.5 2M12.5 15h4",
  team: "M9 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6",
  instructions: `${P.file}M9 13h6M9 17h4`,
};

const BACKEND_HINT: Record<string, string> = {
  software: "Checks paths inside the process. No isolation from the OS.",
  docker: "Runs each shell command in a container.",
  os: "Bubblewrap on Linux, Seatbelt on macOS, a restricted token on Windows.",
};

const TONES: Record<string, string> = {
  Connected: "var(--green)",
  "Not connected": "var(--muted)",
  Failed: "var(--red)",
  Configured: "var(--text-2)",
  Allow: "var(--green)",
  Ask: "var(--amber)",
  Deny: "var(--red)",
};

/* ---------- list editor state (one editor open at a time) ---------- */

interface Edit {
  list: string;
  i: number | null;
  draft: string[];
}
const [edit, setEdit] = createSignal<Edit | null>(null);
const [busy, setBusy] = createSignal(false);

interface Item {
  name: string;
  cells: string[];
  tone?: string;
  act?: string;
  canEdit: boolean;
  canRemove: boolean;
}

interface FieldSpec {
  label: string;
  kind: "text" | "password" | "choice" | "select";
  placeholder?: string;
  required?: boolean;
  options?: [string, string][];
  show?: (draft: string[]) => boolean;
  valid?: (value: string) => boolean;
}

interface ListProps {
  id: string;
  label: string;
  hint: string;
  head: string[];
  cols: string;
  items: Item[];
  empty: string;
  disabled: boolean;
  addLabel?: string;
  newDraft?: () => string[];
  fields?: FieldSpec[];
  draftOf?: (i: number) => string[];
  editTitle?: (i: number | null) => string;
  save?: (i: number | null, draft: string[]) => Promise<boolean>;
  remove?: (i: number) => void;
  act?: (i: number) => void;
}

const btnBox = {
  width: "26px",
  height: "26px",
  color: "var(--muted)",
} as const;

function Switch(p: { label: string; on: boolean; disabled: boolean; set: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      class="switch lg"
      aria-checked={tf(p.on)}
      aria-label={p.label}
      disabled={p.disabled}
      onClick={() => p.set(!p.on)}
    >
      <span />
    </button>
  );
}

function Seg(p: {
  label: string;
  value: string;
  opts: [string, string][];
  disabled: boolean;
  set: (v: string) => void;
}) {
  return (
    <div class="seg" role="radiogroup" aria-label={p.label}>
      <For each={p.opts}>
        {([id, text]) => (
          // biome-ignore lint/a11y/useSemanticElements: .seg styles button[aria-checked]
          <button
            type="button"
            role="radio"
            aria-checked={tf(p.value === id)}
            disabled={p.disabled}
            style={{ height: "28px", "font-size": "12.5px" }}
            onClick={() => p.set(id)}
          >
            {text}
          </button>
        )}
      </For>
    </div>
  );
}

function Sel(p: {
  id: string;
  label: string;
  value: string;
  items: Choice<string>[];
  disabled: boolean;
  set: (v: string) => void;
}) {
  const [up, setUp] = createSignal(false);
  const menu = () => `st:${p.id}`;
  const current = () => p.items.find((c) => c.value === p.value);
  const shown = () => {
    const c = current();
    return c ? (c.desc ? `${c.label} · ${c.desc}` : c.label) : p.value || "Not set";
  };
  return (
    <div data-menu style={{ position: "relative", width: "250px", "max-width": "100%" }}>
      <button
        type="button"
        class="ol"
        aria-haspopup="menu"
        aria-expanded={tf(openMenu() === menu())}
        aria-label={p.label}
        disabled={p.disabled}
        style={{ width: "100%", gap: "8px", "text-align": "left" }}
        onClick={(e) => {
          const b = e.currentTarget.getBoundingClientRect();
          const d = e.currentTarget.closest(".dialog")?.getBoundingClientRect();
          setUp(d ? d.bottom - b.bottom < Math.min(240, p.items.length * 30 + 10) + 64 : false);
          toggleMenu(menu());
        }}
      >
        <span class="ell" style={{ flex: 1, "font-size": "12.5px" }}>
          {shown()}
        </span>
        <I d={P.chevD} size={11} sw={2.2} stroke="var(--muted)" />
      </button>
      <Pop
        id={menu()}
        label={p.label}
        up={up()}
        style={{
          [up() ? "bottom" : "top"]: "36px",
          right: 0,
          width: "100%",
          "min-width": "220px",
          "max-height": "240px",
        }}
      >
        <Choices items={p.items} current={p.value} pick={p.set} two={false} />
      </Pop>
    </div>
  );
}

function FieldInput(p: {
  label: string;
  value: string;
  placeholder?: string;
  disabled: boolean;
  width?: string;
  onCommit: (el: HTMLInputElement) => void;
}) {
  return (
    <input
      type="text"
      class="field"
      aria-label={p.label}
      value={p.value}
      placeholder={p.placeholder}
      disabled={p.disabled}
      spellcheck={false}
      style={{ width: "250px", "max-width": "100%", height: "32px", "font-size": "12.5px" }}
      onChange={(e) => p.onCommit(e.currentTarget)}
    />
  );
}

/* ---------- list view ---------- */

function ListView(p: ListProps) {
  const mine = () => {
    const e = edit();
    return e && e.list === p.id ? e : null;
  };
  const open = (i: number | null) =>
    setEdit({ list: p.id, i, draft: i === null ? (p.newDraft?.() ?? []) : (p.draftOf?.(i) ?? []) });
  const grid = (): JSX.CSSProperties => ({
    display: "grid",
    "grid-template-columns": `${p.cols} 88px`,
    gap: "12px",
    padding: "0 8px 0 12px",
    "align-items": "center",
    "min-width": "480px",
  });
  const setDraft = (j: number, v: string) =>
    setEdit((e) => (e ? { ...e, draft: e.draft.map((x, k) => (k === j ? v : x)) } : e));
  const fields = () => p.fields ?? [];
  const off = () => {
    const e = mine();
    if (!e || busy()) return true;
    return fields().some((f, j) => {
      if (f.show && !f.show(e.draft)) return false;
      const v = (e.draft[j] ?? "").trim();
      return (f.required && !v) || (v && f.valid ? !f.valid(v) : false);
    });
  };
  const save = async () => {
    const e = mine();
    if (!e || off() || !p.save) return;
    setBusy(true);
    const ok = await p.save(
      e.i,
      e.draft.map((x) => x.trim()),
    );
    setBusy(false);
    if (ok) setEdit(null);
  };
  const firstText = () => fields().findIndex((f) => f.kind === "text" || f.kind === "password");

  const editor = (title: string) => (
    <fieldset
      aria-label={title}
      style={{
        border: "0",
        margin: "0",
        "min-width": "0",
        padding: "14px 14px 12px",
        display: "flex",
        "flex-direction": "column",
        gap: "12px",
        background: "var(--fill-3)",
        "border-bottom": "1px solid var(--line-soft)",
      }}
    >
      <For each={fields()}>
        {(f, j) => (
          <Show when={!f.show || f.show(mine()?.draft ?? [])}>
            <div style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
              <span style={{ "font-size": "12px", "font-weight": 500, color: "var(--muted)" }}>
                {f.label}
              </span>
              <Show when={f.kind === "text" || f.kind === "password"}>
                <input
                  class="field"
                  type={f.kind === "password" ? "password" : "text"}
                  aria-label={f.label}
                  value={mine()?.draft[j()] ?? ""}
                  placeholder={f.placeholder}
                  spellcheck={false}
                  autocomplete="off"
                  style={{ height: "32px" }}
                  ref={(el) => {
                    if (j() === firstText()) queueMicrotask(() => el.focus());
                  }}
                  onInput={(e) => setDraft(j(), e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void save();
                    }
                  }}
                />
              </Show>
              <Show when={f.kind === "select"}>
                <select
                  class="field"
                  aria-label={f.label}
                  style={{ height: "32px" }}
                  onChange={(e) => setDraft(j(), e.currentTarget.value)}
                >
                  <For each={f.options}>
                    {([v, t]) => (
                      <option value={v} selected={(mine()?.draft[j()] ?? "") === v}>
                        {t}
                      </option>
                    )}
                  </For>
                </select>
              </Show>
              <Show when={f.kind === "choice"}>
                <div style={{ "align-self": "flex-start" }}>
                  <Seg
                    label={f.label}
                    value={mine()?.draft[j()] ?? ""}
                    opts={f.options ?? []}
                    disabled={false}
                    set={(v) => setDraft(j(), v)}
                  />
                </div>
              </Show>
            </div>
          </Show>
        )}
      </For>
      <div style={{ display: "flex", gap: "6px", "justify-content": "flex-end" }}>
        <button
          type="button"
          class="gh"
          style={{ height: "30px", padding: "0 12px" }}
          onClick={() => setEdit(null)}
        >
          Cancel
        </button>
        <button
          type="button"
          class="pri"
          style={{ height: "30px", padding: "0 14px" }}
          disabled={off()}
          onClick={save}
        >
          Save
        </button>
      </div>
    </fieldset>
  );

  return (
    <div style={{ display: "flex", "flex-direction": "column", gap: "10px" }}>
      <div style={{ display: "flex", "align-items": "flex-start", gap: "12px" }}>
        <div style={{ flex: 1, "min-width": 0, display: "flex", "flex-direction": "column", gap: "3px" }}>
          <span style={{ "font-weight": 500, "font-size": "13.5px" }}>{p.label}</span>
          <span style={{ color: "var(--muted)", "font-size": "12.5px" }}>{p.hint}</span>
        </div>
        <Show when={p.addLabel}>
          <button
            type="button"
            class="ol"
            disabled={p.disabled || !!edit()}
            style={{ height: "28px", "border-radius": "7px", "font-size": "12.5px" }}
            onClick={() => open(null)}
          >
            <I d={P.plus} size={12} sw={2.2} />
            {p.addLabel}
          </button>
        </Show>
      </div>
      <div style={{ "border-top": "1px solid var(--line-soft)", "overflow-x": "auto" }}>
        <div
          style={{
            ...grid(),
            height: "30px",
            color: "var(--muted)",
            "font-size": "12px",
            "border-bottom": "1px solid var(--line-soft)",
          }}
        >
          <For each={p.head}>{(h) => <span>{h}</span>}</For>
          <span />
        </div>
        <For each={p.items}>
          {(it, i) => (
            <Show
              when={mine()?.i === i()}
              fallback={
                <div style={{ ...grid(), height: "38px", "border-bottom": "1px solid var(--line-soft)" }}>
                  <For each={it.cells}>
                    {(text, j) => (
                      <span
                        title={text}
                        style={{
                          "min-width": 0,
                          overflow: "hidden",
                          "text-overflow": "ellipsis",
                          "white-space": "nowrap",
                          ...(j() === it.cells.length - 1 && it.tone
                            ? { color: it.tone, "font-weight": it.tone === "var(--muted)" ? 400 : 500 }
                            : j() > 0
                              ? { "font-size": "12.5px", color: "var(--text-2)" }
                              : { "font-weight": 500 }),
                        }}
                      >
                        {text}
                      </span>
                    )}
                  </For>
                  <span style={{ display: "flex", "justify-content": "flex-end", gap: "2px" }}>
                    <Show when={it.act}>
                      <button
                        type="button"
                        class="ol"
                        disabled={p.disabled || !!edit()}
                        style={{
                          height: "28px",
                          padding: "0 12px",
                          "border-radius": "7px",
                          "font-weight": 500,
                        }}
                        onClick={() => p.act?.(i())}
                      >
                        {it.act}
                      </button>
                    </Show>
                    <Show when={it.canEdit}>
                      <button
                        type="button"
                        class="ic"
                        aria-label={`Edit ${it.name}`}
                        disabled={p.disabled || !!edit()}
                        style={btnBox}
                        onClick={() => open(i())}
                      >
                        <I d={P.pencil} size={13} sw={1.8} />
                      </button>
                    </Show>
                    <Show when={it.canRemove}>
                      <button
                        type="button"
                        class="ic"
                        aria-label={`Remove ${it.name}`}
                        disabled={p.disabled || !!edit()}
                        style={btnBox}
                        onClick={() => p.remove?.(i())}
                      >
                        <I d={P.trash} size={13} sw={1.8} />
                      </button>
                    </Show>
                  </span>
                </div>
              }
            >
              {editor(p.editTitle?.(i()) ?? `Edit ${it.name}`)}
            </Show>
          )}
        </For>
        <Show when={mine() && mine()?.i === null}>{editor(p.editTitle?.(null) ?? `New ${p.label}`)}</Show>
        <Show when={p.items.length === 0 && !mine()}>
          <div style={{ padding: "14px 12px", color: "var(--muted)", "font-size": "12.5px" }}>{p.empty}</div>
        </Show>
      </div>
    </div>
  );
}

/* ---------- parsing ---------- */

type Parsed = { ok: true; value: unknown } | { ok: false; msg: string };
const okv = (value: unknown): Parsed => ({ ok: true, value });
const parseStr = (s: string): Parsed => okv(s || null);
const parsePos = (s: string): Parsed =>
  !s
    ? okv(null)
    : /^\d+$/.test(s) && Number(s) > 0
      ? okv(Number(s))
      : { ok: false, msg: "Enter a whole number above 0." };
const parseUsd = (s: string): Parsed =>
  !s
    ? okv(null)
    : Number.isFinite(Number(s)) && Number(s) >= 0
      ? okv(Number(s))
      : { ok: false, msg: "Enter an amount of 0 or more." };
const parseCsv = (s: string): Parsed => {
  const list = s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  return okv(list.length ? list : null);
};
const fmtStr = (v: unknown) => (v == null ? "" : String(v));
const fmtCsv = (v: unknown) => (Array.isArray(v) ? v.join(", ") : "");

/** Server names an `mcp_status` result marks as failed; the shape is read loosely. */
function failedNames(v: unknown): Set<string> {
  const out = new Set<string>();
  const bad = (o: Json) =>
    Boolean(o.error) || o.failed === true || /fail|error/i.test(String(o.status ?? o.state ?? ""));
  const walk = (x: unknown, key?: string, failing = false): void => {
    if (typeof x === "string") {
      if (failing && !key) out.add(x);
      return;
    }
    if (Array.isArray(x)) {
      for (const y of x) walk(y, undefined, failing);
      return;
    }
    if (!x || typeof x !== "object") return;
    const o = x as Json;
    if (typeof o.name === "string" && bad(o)) out.add(o.name);
    else if (key && failing) out.add(key);
    else if (key && bad(o)) out.add(key);
    for (const [k, val] of Object.entries(o)) walk(val, k, failing || /^(failures|failed|errors)$/.test(k));
  };
  walk(v);
  return out;
}

/* ---------- component ---------- */

interface Row {
  key: string;
  label: string;
  hint: () => string;
  list?: boolean;
  app?: boolean;
  ctl: (off: boolean) => JSX.Element;
}
interface Section {
  id: keyof typeof ICONS;
  label: string;
  rows: Row[];
}

export default function Settings(props: { onClose?: () => void }) {
  const root = createMemo(() => state.current?.root ?? state.newRoot ?? state.projects[0]?.path ?? null);
  const proj = createMemo(() => project(root()));
  const cfg = createMemo<Json>(() => proj()?.config ?? {});
  const locked = () => !proj()?.config;
  const choices = createMemo(() => modelChoices(root()));
  const [section, setSection] = createSignal<keyof typeof ICONS>("general");
  const [q, setQ] = createSignal("");
  const [version, setVersion] = createSignal("");
  const [failed, setFailed] = createSignal<Set<string>>(new Set());
  let dialog: HTMLDivElement | undefined;

  onMount(() => {
    dialog?.focus();
    void getVersion()
      .then(setVersion)
      .catch(() => {});
    void loadMcp();
  });
  onCleanup(() => {
    setEdit(null);
    closeMenu();
  });

  async function loadMcp() {
    const r = root();
    if (!r) return;
    try {
      setFailed(failedNames(await host.rpc(r, "mcp_status")));
    } catch {
      setFailed(new Set<string>());
    }
  }

  /** Writes one daemon config key and restarts the daemons that share the user file. A daemon keeps
   * its loaded config until it restarts, so the row shows the written value instead of config_get. */
  async function write(key: string, value: unknown): Promise<boolean> {
    const r = root();
    if (!r) return false;
    try {
      await rpcWhenUp(r, "config_write", { key, value });
      for (const x of state.projects) {
        if (!x.config) continue;
        const next = structuredClone(unwrap(x.config)) as Record<string, unknown>;
        const parts = key.split(".");
        let o = next;
        for (const part of parts.slice(0, -1)) {
          if (!o[part] || typeof o[part] !== "object") o[part] = {};
          o = o[part] as Record<string, unknown>;
        }
        const last = parts.at(-1) ?? key;
        if (value === null) delete o[last];
        else o[last] = value;
        setState("projects", (p) => p.path === x.path, "config", reconcile(next));
      }
      for (const x of state.projects) {
        if (x.conn === "up") void host.rpc(x.path, "daemon_restart").catch(() => {});
      }
      return true;
    } catch (e) {
      toast(errorText(e), { tone: "err" });
      return false;
    }
  }

  async function refreshProviders(r: string) {
    const res = await host.rpc<ProvidersList>(r, "providers_list");
    const i = state.projects.findIndex((x) => x.path === r);
    if (i >= 0) setState("projects", i, "providers", reconcile(res));
  }

  /* ----- row factories ----- */

  const bool = (key: string, def: boolean) => {
    const v = dig(cfg(), key);
    return typeof v === "boolean" ? v : def;
  };
  const toggle = (key: string, label: string, hint: string, def = false): Row => ({
    key,
    label,
    hint: () => hint,
    ctl: (off) => <Switch label={label} on={bool(key, def)} disabled={off} set={(v) => void write(key, v)} />,
  });
  const cseg = (
    key: string,
    label: string,
    hint: string | (() => string),
    opts: [string, string][],
    def: string,
  ): Row => ({
    key,
    label,
    hint: typeof hint === "function" ? hint : () => hint,
    ctl: (off) => (
      <Seg
        label={label}
        value={str(dig(cfg(), key)) || def}
        opts={opts}
        disabled={off}
        set={(v) => void write(key, v)}
      />
    ),
  });
  const pseg = (
    key: string,
    label: string,
    hint: string,
    opts: [string, string][],
    value: () => string,
    set: (v: string) => void,
  ): Row => ({
    key,
    label,
    hint: () => hint,
    app: true,
    ctl: () => <Seg label={label} value={value()} opts={opts} disabled={false} set={set} />,
  });
  const csel = (
    key: string,
    label: string,
    hint: string,
    items: () => Choice<string>[],
    set?: (v: string) => void,
  ) => ({
    key,
    label,
    hint: () => hint,
    ctl: (off: boolean) => (
      <Sel
        id={key}
        label={label}
        value={str(dig(cfg(), key))}
        items={items()}
        disabled={off}
        set={set ?? ((v) => void write(key, v || null))}
      />
    ),
  });
  const modelItems = (key: string, none?: string): Choice<string>[] => {
    const cur = str(dig(cfg(), key));
    const items: Choice<string>[] = choices().map((c) => ({ value: c.ref, label: c.label, desc: c.desc }));
    if (cur && !items.some((c) => c.value === cur)) items.unshift({ value: cur, label: cur });
    return none ? [{ value: "", label: none }, ...items] : items;
  };
  const ctext = (
    key: string,
    label: string,
    hint: string,
    placeholder: string,
    parse: (s: string) => Parsed,
    fmt: (v: unknown) => string,
  ): Row => ({
    key,
    label,
    hint: () => hint,
    ctl: (off) => (
      <FieldInput
        label={label}
        value={fmt(dig(cfg(), key))}
        placeholder={placeholder}
        disabled={off}
        onCommit={async (el) => {
          const cur = dig(cfg(), key);
          const r = parse(el.value.trim());
          if (!r.ok) {
            toast(r.msg, { tone: "err" });
            el.value = fmt(cur);
            return;
          }
          if (JSON.stringify(r.value ?? null) === JSON.stringify(cur ?? null)) {
            el.value = fmt(cur);
            return;
          }
          if (!(await write(key, r.value))) el.value = fmt(dig(cfg(), key));
        }}
      />
    ),
  });

  /* ----- lists ----- */

  const providerRows = createMemo(() => {
    const pl = proj()?.providers;
    const connected = new Set(pl?.connected ?? []);
    const names = new Map((pl?.all ?? []).map((x) => [x.id, x.name]));
    const custom = obj(cfg().provider);
    const ids = [
      ...new Set([...connected, "anthropic", "openai", "google", "openrouter", ...Object.keys(custom)]),
    ];
    return ids.map((id) => {
      const c = obj(custom[id]);
      const on = connected.has(id);
      const env = Array.isArray(c.env) ? str(c.env[0]) : "";
      return {
        id,
        on,
        name: names.get(id) ?? (str(c.name) || id),
        auth: on ? (c.apiKey ? "API key, config" : env || "API key") : "None",
      };
    });
  });

  async function connectProvider(id: string, apiKey: string): Promise<boolean> {
    const r = root();
    if (!r) return false;
    try {
      await rpcWhenUp(r, "provider_connect", { providerId: id, apiKey });
      await refreshProviders(r);
      return true;
    } catch (e) {
      toast(errorText(e), { tone: "err" });
      return false;
    }
  }

  async function disconnectProvider(id: string) {
    const r = root();
    if (!r) return;
    try {
      const res = await rpcWhenUp<{ removed?: boolean; reason?: string }>(r, "provider_disconnect", {
        providerId: id,
      });
      if (res?.removed === false)
        toast(res.reason ?? "This provider is not signed in through Agency.", { tone: "err" });
      await refreshProviders(r);
    } catch (e) {
      toast(errorText(e), { tone: "err" });
    }
  }

  interface Rule {
    tool: string;
    pattern: string;
    decision: string;
  }
  const rules = createMemo<Rule[]>(() => {
    const out: Rule[] = [];
    for (const [tool, v] of Object.entries(obj(cfg().permissions))) {
      if (typeof v === "string") out.push({ tool, pattern: "*", decision: v });
      else
        for (const [pattern, decision] of Object.entries(obj(v)))
          out.push({ tool, pattern, decision: str(decision) });
    }
    return out;
  });
  const writeRules = (list: Rule[]) => {
    const map: Record<string, string | Record<string, string>> = {};
    const by = new Map<string, Rule[]>();
    for (const r of list) by.set(r.tool, [...(by.get(r.tool) ?? []), r]);
    for (const [tool, rs] of by) {
      const only = rs[0];
      map[tool] =
        rs.length === 1 && only && only.pattern === "*"
          ? only.decision
          : Object.fromEntries(rs.map((r) => [r.pattern, r.decision]));
    }
    return write("permissions", map);
  };
  const toolNames = createMemo(() => [
    ...new Set(["bash", "edit", "write", "read", "webfetch", ...rules().map((r) => r.tool)]),
  ]);

  const servers = createMemo(() =>
    Object.entries(obj(cfg().mcpServers)).map(([name, v]) => [name, obj(v)] as const),
  );
  const commandLine = (o: Json) =>
    [str(o.command), ...(Array.isArray(o.args) ? o.args.map(String) : [])].join(" ").trim();
  async function saveServer(i: number | null, d: string[]): Promise<boolean> {
    const [name = "", transport = "stdio", command = "", url = ""] = d;
    const list = servers().map(([n, v]) => [n, plain(v)] as [string, Json]);
    if (list.some(([n], k) => n === name && k !== i)) {
      toast(`A server named ${name} exists.`, { tone: "err" });
      return false;
    }
    const old = i === null ? {} : (list[i]?.[1] ?? {});
    let entry: Json;
    if (transport === "http") {
      const { command: _c, args: _a, ...rest } = old;
      entry = { ...rest, url };
    } else {
      const { url: _u, ...rest } = old;
      const [bin = "", ...args] = command.split(/\s+/);
      entry = { ...rest, command: bin, ...(args.length ? { args } : {}) };
    }
    const next =
      i === null
        ? [...list, [name, entry] as [string, Json]]
        : list.map((x, k) => (k === i ? ([name, entry] as [string, Json]) : x));
    const ok = await write("mcpServers", Object.fromEntries(next));
    if (ok) void loadMcp();
    return ok;
  }

  interface HookLoc {
    event: string;
    g: number;
    h: number;
    matcher: string;
    type: string;
    text: string;
  }
  const hookRows = createMemo<HookLoc[]>(() => {
    const out: HookLoc[] = [];
    for (const [event, groups] of Object.entries(obj(cfg().hooks))) {
      if (!Array.isArray(groups)) continue;
      groups.forEach((g, gi) => {
        const group = obj(g);
        const hooks = Array.isArray(group.hooks) ? group.hooks : [];
        hooks.forEach((h, hi) => {
          const o = obj(h);
          const type = str(o.type) || "command";
          const text =
            type === "command"
              ? str(o.command)
              : `${type}: ${str(o.url) || str(o.prompt) || [str(o.server), str(o.tool)].filter(Boolean).join(".")}`;
          out.push({ event, g: gi, h: hi, matcher: str(group.matcher), type, text });
        });
      });
    }
    return out;
  });
  const hookEvents = createMemo(() => [
    ...new Set([
      "PreToolUse",
      "PostToolUse",
      "UserPromptSubmit",
      "SessionStart",
      "Stop",
      ...hookRows().map((r) => r.event),
    ]),
  ]);
  const dropHook = (hooks: Json, loc: HookLoc) => {
    const groups = hooks[loc.event] as Json[];
    const group = groups[loc.g] as Json;
    (group.hooks as unknown[]).splice(loc.h, 1);
    if ((group.hooks as unknown[]).length === 0) groups.splice(loc.g, 1);
    if (groups.length === 0) delete hooks[loc.event];
  };
  const addHook = (hooks: Json, event: string, matcher: string, command: string) => {
    const groups = (hooks[event] ?? []) as Json[];
    hooks[event] = groups;
    let group = groups.find((g) => str(g.matcher) === matcher);
    if (!group) {
      group = { ...(matcher ? { matcher } : {}), hooks: [] };
      groups.push(group);
    }
    (group.hooks as unknown[]).push({ type: "command", command });
  };
  const writeHooks = (hooks: Json) => write("hooks", Object.keys(hooks).length ? hooks : null);
  async function saveHook(i: number | null, d: string[]): Promise<boolean> {
    const [event = "", matcher = "", command = ""] = d;
    const next = plain(obj(cfg().hooks));
    const loc = i === null ? undefined : hookRows()[i];
    if (loc && loc.event === event && loc.matcher === matcher) {
      const hook = (((next[event] as Json[])[loc.g] as Json).hooks as Json[])[loc.h] as Json;
      hook.command = command;
    } else {
      if (loc) dropHook(next, loc);
      addHook(next, event, matcher, command);
    }
    return writeHooks(next);
  }

  const agents = createMemo(() => Object.entries(obj(cfg().agents)).map(([h, v]) => [h, obj(v)] as const));
  const agentModel = (a: Json) =>
    a.provider && a.model ? `${str(a.provider)}/${str(a.model)}` : str(a.model);
  async function saveAgent(i: number | null, d: string[]): Promise<boolean> {
    const [handle = "", model = "", effort = ""] = d;
    const list = agents().map(([h, v]) => [h, plain(v)] as [string, Json]);
    if (list.some(([h], k) => h === handle && k !== i)) {
      toast(`An agent named ${handle} exists.`, { tone: "err" });
      return false;
    }
    const old = i === null ? {} : (list[i]?.[1] ?? {});
    const { provider: _p, model: _m, effort: _e, ...rest } = old;
    const slash = model.indexOf("/");
    const entry: Json = {
      ...rest,
      role: str(old.role) || handle,
      enabled: typeof old.enabled === "boolean" ? old.enabled : true,
      ...(model
        ? slash > 0
          ? { provider: model.slice(0, slash), model: model.slice(slash + 1) }
          : { model }
        : {}),
      ...(effort ? { effort } : {}),
    };
    const next =
      i === null
        ? [...list, [handle, entry] as [string, Json]]
        : list.map((x, k) => (k === i ? ([handle, entry] as [string, Json]) : x));
    return write("agents", Object.fromEntries(next));
  }
  const agentModelOptions = (): [string, string][] => {
    const opts: [string, string][] = [
      ["", "Default"],
      ...choices().map((c) => [c.ref, `${c.label} · ${c.desc}`] as [string, string]),
    ];
    for (const [, a] of agents()) {
      const m = agentModel(a);
      if (m && !opts.some(([v]) => v === m)) opts.push([m, m]);
    }
    return opts;
  };

  /* ----- sections ----- */

  const sections: Section[] = [
    {
      id: "general",
      label: "General",
      rows: [
        csel(
          "locale",
          "Language",
          "Language of messages and errors.",
          () => [{ value: "en", label: "English" }],
          (v) => void write("locale", v),
        ),
        pseg(
          "theme",
          "Appearance",
          "System follows the Windows or macOS setting.",
          [
            ["light", "Light"],
            ["dark", "Dark"],
            ["system", "System"],
          ],
          () => state.prefs.theme,
          (v) => savePrefs({ theme: v as "light" | "dark" | "system" }),
        ),
        cseg(
          "logLevel",
          "Log level",
          "How much the daemon writes to its log.",
          [
            ["debug", "Debug"],
            ["info", "Info"],
            ["warn", "Warn"],
            ["error", "Error"],
          ],
          "info",
        ),
        toggle("telemetryEnabled", "Anonymous usage metrics", "Off by default. Nothing is sent while off."),
        toggle("crashReportsEnabled", "Crash reports", "Adds crash data to agency debug bundles."),
      ],
    },
    {
      id: "models",
      label: "Models",
      rows: [
        csel("model", "Default model", "Used for new sessions.", () => modelItems("model")),
        csel("small_model", "Small model", "Titles, summaries and other background work.", () =>
          modelItems("small_model"),
        ),
        csel("auto_review_model", "Reviewer model", "Reviews tool calls in auto permission mode.", () =>
          modelItems("auto_review_model", "Same as small model"),
        ),
        pseg(
          "effort",
          "Reasoning effort",
          "Default effort for models that support it.",
          [
            ["low", "Low"],
            ["medium", "Medium"],
            ["high", "High"],
            ["max", "Max"],
          ],
          () => state.prefs.effort,
          (v) => savePrefs({ effort: v as Effort }),
        ),
        {
          key: "provider",
          label: "Providers",
          hint: () => "Keys come from the keychain, the environment or a sign-in.",
          list: true,
          ctl: () => (
            <ListView
              id="provider"
              label="Providers"
              hint="Keys come from the keychain, the environment or a sign-in."
              head={["Provider", "Auth", "State"]}
              cols="1fr 1.4fr 0.9fr"
              empty="No providers."
              disabled={!proj()}
              items={providerRows().map((r) => ({
                name: r.name,
                cells: [r.name, r.auth, r.on ? "Connected" : "Not connected"],
                tone: TONES[r.on ? "Connected" : "Not connected"],
                act: r.on ? "Sign out" : "Connect",
                canEdit: false,
                canRemove: false,
              }))}
              act={(i) => {
                const r = providerRows()[i];
                if (!r) return;
                if (r.on) void disconnectProvider(r.id);
                else setEdit({ list: "provider", i, draft: [""] });
              }}
              fields={[{ label: "API key", kind: "password", required: true, placeholder: "Paste a key" }]}
              editTitle={(i) => `Connect ${providerRows()[i ?? -1]?.name ?? "provider"}`}
              save={async (i, d) => {
                const r = providerRows()[i ?? -1];
                return r ? connectProvider(r.id, d[0] ?? "") : false;
              }}
            />
          ),
        },
      ],
    },
    {
      id: "permissions",
      label: "Permissions",
      rows: [
        pseg(
          "mode",
          "Default mode",
          "Shift+Tab changes it inside a session.",
          [
            ["ask", "Ask"],
            ["allow-edits", "Allow edits"],
            ["auto", "Auto"],
            ["allow-all", "Allow all"],
            ["deny", "Deny"],
          ],
          () => state.prefs.mode,
          (v) => savePrefs({ mode: v as PermissionMode }),
        ),
        toggle("trust.required", "Require workspace trust", "An untrusted workspace runs only safe tools."),
        {
          key: "permissions",
          label: "Rules",
          hint: () => "Read-only shell commands of the workspace run without a prompt.",
          list: true,
          ctl: (off) => (
            <ListView
              id="permissions"
              label="Rules"
              hint="Read-only shell commands of the workspace run without a prompt."
              head={["Tool", "Pattern", "Decision"]}
              cols="0.7fr 1.5fr 0.8fr"
              empty="No rules. Every tool follows the default mode."
              disabled={off}
              addLabel="Add rule"
              items={rules().map((r) => ({
                name: `${r.tool} ${r.pattern}`,
                cells: [r.tool, r.pattern, cap(r.decision)],
                tone: TONES[cap(r.decision)],
                canEdit: true,
                canRemove: true,
              }))}
              newDraft={() => ["bash", "", "ask"]}
              draftOf={(i) => {
                const r = rules()[i];
                return [r?.tool ?? "", r?.pattern ?? "", r?.decision ?? "ask"];
              }}
              fields={[
                { label: "Tool", kind: "select", options: toolNames().map((t) => [t, t]) },
                { label: "Pattern", kind: "text", required: true, placeholder: "git push *" },
                {
                  label: "Decision",
                  kind: "choice",
                  options: [
                    ["allow", "Allow"],
                    ["ask", "Ask"],
                    ["deny", "Deny"],
                  ],
                },
              ]}
              editTitle={(i) => (i === null ? "New rule" : "Edit rule")}
              save={(i, d) => {
                const rule = { tool: d[0] ?? "", pattern: d[1] || "*", decision: d[2] ?? "ask" };
                return writeRules(
                  i === null ? [...rules(), rule] : rules().map((r, k) => (k === i ? rule : r)),
                );
              }}
              remove={(i) => void writeRules(rules().filter((_, k) => k !== i))}
            />
          ),
        },
      ],
    },
    {
      id: "sandbox",
      label: "Sandbox",
      rows: [
        cseg(
          "sandbox.backend",
          "Backend",
          () => BACKEND_HINT[str(dig(cfg(), "sandbox.backend")) || "software"] ?? "",
          [
            ["software", "Software"],
            ["docker", "Docker"],
            ["os", "OS"],
          ],
          "software",
        ),
        toggle(
          "sandbox.allowNetwork",
          "Network for shell commands",
          "With the OS backend on Windows this must be on.",
        ),
        ctext(
          "sandbox.allowedDomains",
          "Allowed domains",
          "Linux and macOS only, through a proxy of the daemon.",
          "host.example",
          parseCsv,
          fmtCsv,
        ),
        ctext(
          "sandbox.denyEnv",
          "Hidden variables",
          "Shell commands of the model do not get these.",
          "NAME, NAME",
          parseCsv,
          fmtCsv,
        ),
      ],
    },
    {
      id: "context",
      label: "Context",
      rows: [
        ctext(
          "compactionLimit",
          "Compaction limit",
          "Tokens of history before a summary. Smaller windows compact at 90%.",
          "220000",
          parsePos,
          fmtStr,
        ),
        toggle(
          "keepToolResults",
          "Keep old tool results whole",
          "Off sends a one-line note for large old results.",
        ),
        toggle("memory", "Memory", "The memory tool and its notes in the prompt.", true),
        toggle(
          "verifyGate",
          "Verify before done",
          "A turn that changed code and ran no passing check is sent back once.",
          true,
        ),
        ctext(
          "maxSteps",
          "Max steps per turn",
          "Tool steps when the caller sets no limit.",
          "100",
          parsePos,
          fmtStr,
        ),
      ],
    },
    {
      id: "tools",
      label: "Tools and MCP",
      rows: [
        {
          key: "mcpServers",
          label: "MCP servers",
          hint: () =>
            "From the user config. Project files and imports from other agents are not listed here.",
          list: true,
          ctl: (off) => (
            <ListView
              id="mcp"
              label="MCP servers"
              hint="From the user config. Project files and imports from other agents are not listed here."
              head={["Server", "Transport", "Source", "State"]}
              cols="1fr 0.7fr 1.3fr 0.8fr"
              empty="No MCP servers."
              disabled={off}
              addLabel="Add server"
              items={servers().map(([name, v]) => {
                const bad = failed().has(name);
                return {
                  name,
                  cells: [name, v.url ? "http" : "stdio", "User config", bad ? "Failed" : "Configured"],
                  tone: TONES[bad ? "Failed" : "Configured"],
                  canEdit: true,
                  canRemove: true,
                };
              })}
              newDraft={() => ["", "stdio", "", ""]}
              draftOf={(i) => {
                const [name = "", v = {}] = servers()[i] ?? [];
                return [name, v.url ? "http" : "stdio", commandLine(v), str(v.url)];
              }}
              fields={[
                { label: "Name", kind: "text", required: true, placeholder: "context7" },
                {
                  label: "Transport",
                  kind: "choice",
                  options: [
                    ["stdio", "stdio"],
                    ["http", "http"],
                  ],
                },
                {
                  label: "Command",
                  kind: "text",
                  required: true,
                  placeholder: "npx -y @upstash/context7-mcp",
                  show: (d) => d[1] !== "http",
                },
                {
                  label: "URL",
                  kind: "text",
                  required: true,
                  placeholder: "https://example.com/mcp",
                  show: (d) => d[1] === "http",
                },
              ]}
              editTitle={(i) => (i === null ? "New server" : `Edit ${servers()[i]?.[0] ?? "server"}`)}
              save={saveServer}
              remove={(i) =>
                void write("mcpServers", Object.fromEntries(servers().filter((_, k) => k !== i))).then(
                  (ok) => {
                    if (ok) void loadMcp();
                  },
                )
              }
            />
          ),
        },
        cseg(
          "mcpDeferTools",
          "Load MCP tool schemas",
          "Auto keeps large schemas out of a request until the model needs them.",
          [
            ["auto", "Auto"],
            ["always", "Deferred"],
            ["never", "Always sent"],
          ],
          "auto",
        ),
        {
          key: "codeMode",
          label: "Code mode",
          hint: () => "One script calls the other tools. Sandboxed has no network and no writes.",
          ctl: (off) => (
            <Seg
              label="Code mode"
              value={cfg().codeMode === true ? "on" : cfg().codeMode === "host" ? "host" : "off"}
              opts={[
                ["off", "Off"],
                ["on", "Sandboxed"],
                ["host", "Host"],
              ]}
              disabled={off}
              set={(v) => void write("codeMode", v === "off" ? null : v === "on" ? true : "host")}
            />
          ),
        },
        cseg(
          "windowsShell",
          "Windows shell",
          "Models write bash with fewer errors than PowerShell 5.1.",
          [
            ["gitbash", "Git Bash"],
            ["powershell", "PowerShell"],
            ["cmd", "cmd"],
          ],
          "powershell",
        ),
      ],
    },
    {
      id: "hooks",
      label: "Hooks",
      rows: [
        {
          key: "hooks",
          label: "Hooks",
          hint: () => "A PreToolUse hook can change the input before the permission check.",
          list: true,
          ctl: (off) => (
            <ListView
              id="hooks"
              label="Hooks"
              hint="A PreToolUse hook can change the input before the permission check."
              head={["Event", "Matcher", "Command"]}
              cols="0.9fr 0.8fr 1.8fr"
              empty="No hooks."
              disabled={off}
              addLabel="Add hook"
              items={hookRows().map((r) => ({
                name: `${r.event} hook`,
                cells: [r.event, r.matcher || "*", r.text],
                canEdit: r.type === "command",
                canRemove: true,
              }))}
              newDraft={() => ["Stop", "*", ""]}
              draftOf={(i) => {
                const r = hookRows()[i];
                return [r?.event ?? "Stop", r?.matcher ?? "", r?.text ?? ""];
              }}
              fields={[
                { label: "Event", kind: "select", options: hookEvents().map((e) => [e, e]) },
                { label: "Matcher", kind: "text", placeholder: "Bash or Edit|Write or *" },
                { label: "Command", kind: "text", required: true, placeholder: "./scripts/on-stop.sh" },
              ]}
              editTitle={(i) => (i === null ? "New hook" : "Edit hook")}
              save={(i, d) => saveHook(i, [d[0] ?? "", d[1] === "*" ? "" : (d[1] ?? ""), d[2] ?? ""])}
              remove={(i) => {
                const loc = hookRows()[i];
                if (!loc) return;
                const next = plain(obj(cfg().hooks));
                dropHook(next, loc);
                void writeHooks(next);
              }}
            />
          ),
        },
      ],
    },
    {
      id: "team",
      label: "Agents and budgets",
      rows: [
        {
          key: "agents",
          label: "Agents",
          hint: () => "Each handle runs on its own provider and model.",
          list: true,
          ctl: (off) => (
            <ListView
              id="agents"
              label="Agents"
              hint="Each handle runs on its own provider and model."
              head={["Handle", "Model", "Effort"]}
              cols="0.8fr 1.8fr 0.7fr"
              empty="No agents. Team runs use the built-in roster."
              disabled={off}
              addLabel="Add agent"
              items={agents().map(([h, a]) => ({
                name: h,
                cells: [h, agentModel(a) || "Default", cap(str(a.effort)) || "Default"],
                canEdit: true,
                canRemove: true,
              }))}
              newDraft={() => ["", "", ""]}
              draftOf={(i) => {
                const [h = "", a = {}] = agents()[i] ?? [];
                return [h, agentModel(a), str(a.effort)];
              }}
              fields={[
                {
                  label: "Handle",
                  kind: "text",
                  required: true,
                  placeholder: "helper",
                  valid: (v) => /^[a-z][a-z0-9-]*$/.test(v),
                },
                { label: "Model", kind: "select", options: agentModelOptions() },
                {
                  label: "Effort",
                  kind: "choice",
                  options: [
                    ["", "Default"],
                    ["low", "Low"],
                    ["medium", "Medium"],
                    ["high", "High"],
                    ["max", "Max"],
                  ],
                },
              ]}
              editTitle={(i) => (i === null ? "New agent" : `Edit ${agents()[i]?.[0] ?? "agent"}`)}
              save={saveAgent}
              remove={(i) => {
                const left = Object.fromEntries(agents().filter((_, k) => k !== i));
                void write("agents", Object.keys(left).length ? left : null);
              }}
            />
          ),
        },
        {
          key: "leader",
          label: "Leader",
          hint: () => "Plans the work and reviews the report.",
          ctl: (off) => (
            <Sel
              id="leader"
              label="Leader"
              value={str(cfg().leader)}
              items={agents().map(([h]) => ({ value: h, label: h }))}
              disabled={off}
              set={(v) => void write("leader", v)}
            />
          ),
        },
        ctext("budgets.dailyUsd", "Daily cap", "In USD. Empty means no cap.", "No cap", parseUsd, fmtStr),
        ctext("budgets.monthlyUsd", "Monthly cap", "In USD. Empty means no cap.", "No cap", parseUsd, fmtStr),
      ],
    },
    {
      id: "instructions",
      label: "Instructions",
      rows: [
        toggle(
          "userAgentInstructions",
          "Instructions of other agents",
          "Also loads ~/.claude/CLAUDE.md, ~/.codex/AGENTS.md and similar files.",
        ),
        toggle(
          "userAgentPlugins",
          "Plugins of other agents",
          "Also loads code plugins from the user folders of OpenCode and Pi.",
        ),
        ctext(
          "outputStyle",
          "Output style",
          "Name of an output style. Empty uses the default.",
          "Default",
          parseStr,
          fmtStr,
        ),
      ],
    },
  ];

  /* ----- view ----- */

  const query = () => q().trim().toLowerCase();
  const blocks = createMemo(() => {
    const s = query();
    if (!s) {
      const cur = sections.find((x) => x.id === section()) ?? (sections[0] as Section);
      return [{ title: "", rows: cur.rows }];
    }
    return sections
      .map((x) => ({
        title: x.label,
        rows: x.rows.filter((r) => `${r.label} ${r.hint()} ${r.key}`.toLowerCase().includes(s)),
      }))
      .filter((b) => b.rows.length > 0);
  });
  const hits = () => blocks().reduce((n, b) => n + b.rows.length, 0);
  const title = () => (query() ? "Search" : (sections.find((x) => x.id === section())?.label ?? ""));
  const note = () =>
    !root()
      ? "Settings of the daemon need an open project. Open a project to change them."
      : locked()
        ? "The daemon of this project is not connected. Its settings are read-only until it is."
        : "";

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    if (openMenu()) closeMenu();
    else if (edit()) setEdit(null);
    else props.onClose?.();
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: Escape is handled on the dialog
    <div
      class="dialog-scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose?.();
      }}
    >
      <div
        ref={dialog}
        class="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabindex="-1"
        style={{ outline: "none" }}
        onKeyDown={onKey}
        onClick={(e) => {
          if (openMenu() && !(e.target as HTMLElement).closest("[data-menu]")) closeMenu();
        }}
      >
        <div
          style={{
            width: "236px",
            flex: "none",
            background: "var(--side)",
            "border-right": "1px solid var(--line-soft)",
            display: "flex",
            "flex-direction": "column",
            padding: "16px 10px 12px",
            "box-sizing": "border-box",
          }}
        >
          <h2
            id="settings-title"
            style={{
              margin: "0 0 8px",
              padding: "0 8px",
              "font-size": "15px",
              "line-height": "32px",
              "font-weight": 600,
            }}
          >
            Settings
          </h2>
          <label class="search" style={{ "margin-bottom": "12px", background: "var(--raised)" }}>
            <I d={P.search} size={14} sw={1.8} />
            <span class="sr">Search settings</span>
            <input
              type="search"
              placeholder="Search settings"
              value={q()}
              onInput={(e) => {
                setQ(e.currentTarget.value);
                closeMenu();
              }}
            />
          </label>
          <nav
            aria-label="Settings sections"
            style={{ display: "flex", "flex-direction": "column", gap: "1px", overflow: "auto" }}
          >
            <For each={sections}>
              {(s) => {
                const on = () => !query() && s.id === section();
                return (
                  <button
                    type="button"
                    class={on() ? "side-row on" : "side-row"}
                    aria-current={on() ? "page" : undefined}
                    onClick={() => {
                      setSection(s.id);
                      setQ("");
                      closeMenu();
                      setEdit(null);
                    }}
                  >
                    <I d={ICONS[s.id]} size={16} sw={1.6} />
                    <span style={{ flex: 1 }}>{s.label}</span>
                  </button>
                );
              }}
            </For>
          </nav>
          <div style={{ flex: 1 }} />
          <div style={{ padding: "8px", "font-size": "11.5px", color: "var(--muted)" }}>
            Agency {version()}
          </div>
        </div>

        <div style={{ flex: 1, "min-width": 0, display: "flex", "flex-direction": "column" }}>
          <div style={{ flex: 1, overflow: "auto", position: "relative" }}>
            <button
              type="button"
              class="ic"
              aria-label="Close settings"
              style={{ position: "absolute", top: "17px", right: "18px", width: "30px", height: "30px" }}
              onClick={() => props.onClose?.()}
            >
              <I d={P.x} size={14} sw={2} />
            </button>
            <div
              style={{
                "max-width": "640px",
                margin: "0 auto",
                padding: "16px 32px 32px",
                display: "flex",
                "flex-direction": "column",
                gap: "22px",
              }}
            >
              <div
                style={{ display: "flex", "flex-direction": "column", gap: "4px", "padding-right": "32px" }}
              >
                <h3
                  style={{
                    margin: 0,
                    "font-size": "18px",
                    "line-height": "32px",
                    "font-weight": 600,
                    "letter-spacing": "-0.2px",
                  }}
                >
                  {title()}
                </h3>
                <Show when={query() && hits() > 0}>
                  <p style={{ margin: 0, color: "var(--muted)" }}>
                    {hits()} {hits() === 1 ? "setting matches" : "settings match"} {"“"}
                    {q().trim()}
                    {"”"}.
                  </p>
                </Show>
              </div>

              <Show when={note()}>
                <div
                  role="status"
                  style={{
                    border: "1px solid var(--line-soft)",
                    "border-radius": "10px",
                    padding: "10px 12px",
                    color: "var(--muted)",
                    background: "var(--fill-3)",
                  }}
                >
                  {note()}
                </div>
              </Show>

              <Show when={query() && hits() === 0}>
                <div
                  style={{
                    border: "1px dashed var(--line)",
                    "border-radius": "10px",
                    padding: "28px",
                    "text-align": "center",
                    color: "var(--muted)",
                  }}
                >
                  No setting matches {"“"}
                  {q().trim()}
                  {"”"}. Try a config key, such as sandbox.
                </div>
              </Show>

              <For each={blocks()}>
                {(b) => (
                  <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
                    <Show when={b.title}>
                      <span
                        style={{
                          "font-size": "12px",
                          "font-weight": 500,
                          color: "var(--muted)",
                          "padding-left": "2px",
                        }}
                      >
                        {b.title}
                      </span>
                    </Show>
                    <div style={{ border: "1px solid var(--line-soft)", "border-radius": "12px" }}>
                      <For each={b.rows}>
                        {(r, i) => {
                          const off = () => !r.app && locked();
                          return (
                            <div
                              style={{
                                padding: "14px 16px",
                                "border-bottom":
                                  i() === b.rows.length - 1 ? "0" : "1px solid var(--line-soft)",
                              }}
                            >
                              <Show when={!r.list} fallback={r.ctl(off())}>
                                <div
                                  style={{
                                    display: "flex",
                                    "align-items": "center",
                                    gap: "20px",
                                    "flex-wrap": "wrap",
                                  }}
                                >
                                  <div
                                    style={{
                                      flex: "1 1 220px",
                                      "min-width": 0,
                                      display: "flex",
                                      "flex-direction": "column",
                                      gap: "3px",
                                    }}
                                  >
                                    <span style={{ "font-weight": 500, "font-size": "13.5px" }}>
                                      {r.label}
                                    </span>
                                    <span style={{ color: "var(--muted)", "font-size": "12.5px" }}>
                                      {r.hint()}
                                    </span>
                                  </div>
                                  {r.ctl(off())}
                                </div>
                              </Show>
                            </div>
                          );
                        }}
                      </For>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

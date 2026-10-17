import fuzzysort from "fuzzysort";
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { bytes, fileKind, tokens, usd } from "../lib/format.ts";
import { errorText, host } from "../lib/host.ts";
import {
  type Attachment,
  currentModel,
  EFFORT_LABEL,
  effortFor,
  goNew,
  keyOf,
  loadSession,
  MODES,
  project,
  rewind,
  savePrefs,
  send,
  setState,
  state,
  stop,
  toast,
  usageOf,
} from "../lib/store.ts";
import { coldContext } from "../lib/transcript.ts";
import { I, P } from "./icons.tsx";
import { ModelDialog } from "./ModelDialog.tsx";
import { Choices, openMenu, Pop, toggleMenu } from "./menu.tsx";

const BUILTINS: { name: string; desc: string }[] = [
  { name: "compact", desc: "Summarize the conversation to free up context" },
  { name: "clear", desc: "Start a new session in this project" },
  { name: "init", desc: "Create the instruction files of this project" },
  { name: "model", desc: "Change the model" },
  { name: "review", desc: "Open the changes for review" },
  { name: "undo", desc: "Undo the last turn" },
];

const fileCache = new Map<string, { at: number; files: string[] }>();
async function filesOf(root: string): Promise<string[]> {
  const hit = fileCache.get(root);
  if (hit && Date.now() - hit.at < 30_000) return hit.files;
  const files = await host.files(root).catch(() => hit?.files ?? []);
  fileCache.set(root, { at: Date.now(), files });
  return files;
}

interface Ac {
  kind: "@" | "/";
  start: number;
  q: string;
  i: number;
}

function acFrom(t: HTMLTextAreaElement): Ac | null {
  const caret = t.selectionStart ?? t.value.length;
  const before = t.value.slice(0, caret);
  const at = /(^|\s)@([^\s@]*)$/.exec(before);
  if (at) return { kind: "@", start: caret - (at[2] ?? "").length - 1, q: at[2] ?? "", i: 0 };
  const sl = /^\s*\/(\S*)$/.exec(before);
  return sl ? { kind: "/", start: caret - (sl[1] ?? "").length - 1, q: sl[1] ?? "", i: 0 } : null;
}

async function readAttachment(file: File): Promise<Attachment | null> {
  const isImage = file.type.startsWith("image/") || file.type === "application/pdf";
  if (isImage) {
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    return { name: file.name, size: file.size, mimeType: file.type, data, kind: "image" };
  }
  if (file.size > 512 * 1024) {
    toast(`${file.name} is over 512 KB. Reference it with @ instead.`, { tone: "err" });
    return null;
  }
  const text = await file.text();
  if (text.includes("\u0000")) {
    toast(`${file.name} is not a text file.`, { tone: "err" });
    return null;
  }
  return { name: file.name, size: file.size, mimeType: file.type || "text/plain", data: text, kind: "text" };
}

export function Composer(props: {
  root: string | null;
  id: string | null;
  isNew: boolean;
  inReview: boolean;
}) {
  const slot = () => (props.isNew || !props.id || !props.root ? "new" : keyOf(props.root, props.id));
  const draft = () => state.composer[slot()]?.draft ?? "";
  const attachments = () => state.composer[slot()]?.attachments ?? [];
  const setDraft = (text: string) =>
    setState("composer", slot(), { draft: text, attachments: attachments() });
  const setAttachments = (list: Attachment[]) =>
    setState("composer", slot(), { draft: draft(), attachments: list });

  const live = () => (props.root && props.id ? state.live[keyOf(props.root, props.id)] : undefined);
  const running = () => !props.isNew && !!live();
  // Not ready until the config loads too: a send before it would find no model.
  const down = () => project(props.root)?.conn !== "up" || !project(props.root)?.config;
  const model = () => currentModel(props.root);

  const [ac, setAc] = createSignal<Ac | null>(null);
  const [files, setFiles] = createSignal<string[]>([]);
  let area: HTMLTextAreaElement | undefined;

  createEffect(
    on(
      () => ac()?.kind,
      (kind) => {
        if (kind === "@" && props.root) void filesOf(props.root).then(setFiles);
      },
    ),
  );

  const items = createMemo(() => {
    const a = ac();
    if (!a) return [];
    if (a.kind === "@") {
      const hits = a.q
        ? fuzzysort.go(a.q, files(), { limit: 50 }).map((r) => r.target)
        : files().slice(0, 50);
      return hits.map((path) => ({
        text: `@${path}`,
        label: path.split("/").pop() ?? path,
        desc: path.split("/").slice(0, -1).join("/"),
        meta: "",
        icon: P.file,
      }));
    }
    const commands = project(props.root)?.commands ?? [];
    const pool = [
      ...BUILTINS.map((b) => ({ name: b.name, desc: b.desc, meta: "" })),
      ...commands
        .filter((c) => !BUILTINS.some((b) => b.name === c.name))
        .map((c) => ({
          name: c.name,
          desc: c.description ?? "",
          meta: c.source === "user" ? "Command" : "Skill",
        })),
    ];
    const q = a.q.toLowerCase();
    return pool
      .filter((c) => c.name.includes(q))
      .sort((x, y) => (x.name.startsWith(q) ? 0 : 1) - (y.name.startsWith(q) ? 0 : 1))
      .map((c) => ({ text: `/${c.name}`, label: `/${c.name}`, desc: c.desc, meta: c.meta, icon: P.slash }));
  });
  const sel = () => Math.min(ac()?.i ?? 0, Math.max(0, items().length - 1));

  const pick = (text: string) => {
    const a = ac();
    if (!a || !area) return;
    const d = draft();
    const pos = a.start + text.length + 1;
    setDraft(`${d.slice(0, a.start)}${text} ${d.slice(a.start + 1 + a.q.length).replace(/^ /, "")}`);
    setAc(null);
    queueMicrotask(() => {
      area?.focus();
      area?.setSelectionRange(pos, pos);
    });
  };

  const sync = (t: HTMLTextAreaElement) => {
    const next = acFrom(t);
    const cur = ac();
    setAc(next && cur && next.kind === cur.kind && next.start === cur.start && next.q === cur.q ? cur : next);
  };

  const autosize = () => {
    if (!area) return;
    area.style.height = "auto";
    area.style.height = `${Math.max(48, area.scrollHeight)}px`;
  };
  createEffect(on(draft, () => queueMicrotask(autosize)));

  /** A slash command: the client ones act here, the others run in the daemon and their text becomes the prompt. */
  async function runSlash(text: string): Promise<boolean> {
    const m = /^\/(\S+)\s*([\s\S]*)$/.exec(text.trim());
    if (!m || !props.root) return false;
    const [, name = "", args = ""] = m;
    const root = props.root;
    const id = props.isNew ? null : props.id;
    const local: Record<string, () => void> = {
      clear: () => goNew(root),
      model: () => toggleMenu("model"),
      ...(id ? { review: () => setState("view", "review"), undo: () => void rewind(root, id) } : {}),
      ...(id ? {} : { compact: () => toast("There is nothing to compact yet.", { tone: "err" }) }),
    };
    const act = local[name];
    if (act) {
      act();
      return true;
    }
    try {
      const result = await host.rpc<{ kind: string; text?: string }>(root, "command_run", {
        name,
        args: name === "compact" ? `${id} ${args}` : args,
      });
      if (result.kind === "builtin") {
        toast(result.text ?? `Ran /${name}`);
        if (id) void loadSession(root, id);
        return true;
      }
      if (result.text) await send(root, id, result.text, attachments());
      return true;
    } catch (error) {
      const message = errorText(error);
      if (/unknown command/i.test(message)) return false;
      toast(message, { tone: "err" });
      return true;
    }
  }

  async function submit() {
    const text = draft().trim();
    if (!text || down() || !props.root) return;
    const files = attachments();
    setState("composer", slot(), { draft: "", attachments: [] });
    setAc(null);
    if (text.startsWith("/") && (await runSlash(text))) return;
    await send(props.root, props.isNew ? null : props.id, text, files);
  }

  const onKey = (e: KeyboardEvent) => {
    const a = ac();
    const list = items();
    if (a && list.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      const i = (sel() + (e.key === "ArrowDown" ? 1 : list.length - 1)) % list.length;
      setAc({ ...a, i });
      document.getElementById(`ac-${i}`)?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (a && list.length && (e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
      e.preventDefault();
      pick(list[sel()]?.text ?? "");
      return;
    }
    if (a && e.key === "Escape") {
      e.preventDefault();
      setAc(null);
      return;
    }
    if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      const i = MODES.findIndex((m) => m.value === state.prefs.mode);
      savePrefs({ mode: MODES[(i + 1) % MODES.length]?.value ?? "ask" });
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  const onFiles = async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const picked = Array.from(input.files ?? []);
    input.value = "";
    const read = (await Promise.all(picked.map(readAttachment))).filter((a): a is Attachment => a !== null);
    setAttachments([...attachments().filter((a) => !read.some((r) => r.name === a.name)), ...read]);
  };

  const placeholder = () =>
    down()
      ? project(props.root)?.conn === "down"
        ? "Restart the daemon to send"
        : "Connecting to the daemon"
      : props.isNew
        ? "Describe a task. Use @ for files and / for commands"
        : props.inReview
          ? "Ask for a change to this diff"
          : running()
            ? "Steer the running turn"
            : "Ask for follow-up changes";

  // After the cache of the provider expired, the next message reads the whole context again at the full input price.
  const [now, setNow] = createSignal(Date.now());
  const tick = setInterval(() => setNow(Date.now()), 30_000);
  onCleanup(() => clearInterval(tick));
  const cold = createMemo(() => {
    const view = props.root && props.id ? state.sessions[keyOf(props.root, props.id)]?.view : undefined;
    if (!view || running()) return undefined;
    const used = coldContext(view.entries, view.tipId, now());
    if (used === undefined || used < 20_000) return undefined;
    const price = model()?.inputPerMTok;
    return { used, cost: price ? (used / 1_000_000) * price : undefined };
  });

  const context = createMemo(() => {
    if (!props.root || !props.id) return null;
    const used = live()?.tokens || usageOf(state.sessions[keyOf(props.root, props.id)]?.view ?? null).tokens;
    const window = model()?.contextWindow ?? 200_000;
    return { used, window, pct: Math.min(100, Math.round((used / window) * 100)) };
  });

  return (
    <div class="pad composer-wrap">
      <div aria-hidden="true" class="composer-fade" />
      <div class="cmp">
        <Show when={ac()}>
          <div
            role="listbox"
            id="composer-ac"
            aria-label={ac()?.kind === "@" ? "Files" : "Commands"}
            class="pop up"
            style={{ bottom: "calc(100% + 8px)", left: 0, right: 0, "max-height": "320px" }}
          >
            <For each={items()}>
              {(item, k) => (
                <button
                  type="button"
                  role="option"
                  tabindex="-1"
                  id={`ac-${k()}`}
                  aria-selected={k() === sel() ? "true" : "false"}
                  class={k() === sel() ? "mi sel" : "mi"}
                  style={{ gap: "10px", "min-height": "32px" }}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => {
                    const a = ac();
                    if (a && a.i !== k()) setAc({ ...a, i: k() });
                  }}
                  onClick={() => pick(item.text)}
                >
                  <I d={item.icon} size={15} sw={1.6} stroke="var(--muted)" />
                  <span style={{ "font-weight": 500, "white-space": "nowrap" }}>{item.label}</span>
                  <span class="ell" style={{ flex: 1, color: "var(--muted)" }}>
                    {item.desc}
                  </span>
                  <span style={{ color: "var(--muted-2)", "font-size": "12px" }}>{item.meta}</span>
                </button>
              )}
            </For>
            <Show when={items().length === 0}>
              <div style={{ padding: "6px 8px", color: "var(--muted)" }}>
                {ac()?.kind === "@" ? "No file matches" : "No command matches"}
              </div>
            </Show>
          </div>
        </Show>

        <div class="composer" id="composer-box">
          <Show when={attachments().length > 0}>
            <div style={{ display: "flex", gap: "8px", "flex-wrap": "wrap", "padding-top": "2px" }}>
              <For each={attachments()}>
                {(a) => (
                  <div class="att">
                    <span class="att-tile">
                      <Show
                        when={a.kind === "image" && a.mimeType !== "application/pdf"}
                        fallback={<I d={P.file} size={16} />}
                      >
                        <img alt="" src={`data:${a.mimeType};base64,${a.data}`} />
                      </Show>
                    </span>
                    <span
                      style={{
                        "min-width": 0,
                        display: "flex",
                        "flex-direction": "column",
                        "line-height": 1.3,
                      }}
                    >
                      <span class="ell" style={{ "font-size": "13px", "font-weight": 500 }}>
                        {a.name}
                      </span>
                      <span
                        class="ell"
                        style={{ "font-size": "12px", color: "var(--muted)" }}
                      >{`${fileKind(a.name)}, ${bytes(a.size)}`}</span>
                    </span>
                    <button
                      type="button"
                      class="att-x"
                      aria-label={`Remove ${a.name}`}
                      onClick={() => setAttachments(attachments().filter((x) => x !== a))}
                    >
                      <I d={P.x} size={8} sw={3} />
                    </button>
                  </div>
                )}
              </For>
            </div>
          </Show>
          <label for="composer" class="sr">
            Message Agency
          </label>
          <textarea
            id="composer"
            ref={area}
            rows={2}
            value={draft()}
            placeholder={placeholder()}
            aria-autocomplete="list"
            aria-controls="composer-ac"
            aria-activedescendant={ac() && items().length ? `ac-${sel()}` : undefined}
            onInput={(e) => {
              setDraft(e.currentTarget.value);
              sync(e.currentTarget);
            }}
            onKeyDown={onKey}
            onSelect={(e) => sync(e.currentTarget)}
            onBlur={() => setAc(null)}
          />
          <div style={{ display: "flex", "align-items": "center", gap: "2px" }}>
            <label class="ic" aria-label="Attach files" style={{ cursor: "pointer", position: "relative" }}>
              <input
                type="file"
                multiple
                onChange={onFiles}
                style={{ position: "absolute", width: "1px", height: "1px", opacity: 0 }}
              />
              <I d={P.plus} size={17} />
            </label>
            <button
              type="button"
              class="gh"
              aria-haspopup="dialog"
              aria-expanded={openMenu() === "model"}
              aria-label={`Model: ${model()?.label ?? "none"}`}
              onClick={() => toggleMenu("model")}
            >
              <span class="ell" style={{ "max-width": "220px" }}>
                {model()?.label ?? "No model"}
              </span>
              <Show when={effortFor(model())}>
                {(e) => <span style={{ color: "var(--muted)" }}>{EFFORT_LABEL[e()]}</span>}
              </Show>
              <I d={P.chevD} size={10} sw={2.4} stroke="var(--muted)" />
            </button>
            <ModelDialog root={props.root} />
            <div style={{ position: "relative", display: "flex" }}>
              <button
                type="button"
                class="gh"
                aria-label={`Permission mode: ${MODES.find((m) => m.value === state.prefs.mode)?.label}`}
                aria-haspopup="menu"
                onClick={() => toggleMenu("mode")}
                style={{ color: "var(--muted)" }}
              >
                <I d={P.shield} size={15} />
                <span class="hide-sm">{MODES.find((m) => m.value === state.prefs.mode)?.label}</span>
                <I d={P.chevD} size={10} sw={2.4} />
              </button>
              <Pop
                id="mode"
                label="Permission mode"
                up
                style={{ bottom: "calc(100% + 8px)", left: 0, width: "300px" }}
              >
                <Choices items={MODES} current={state.prefs.mode} pick={(v) => savePrefs({ mode: v })} two />
              </Pop>
            </div>
            <div style={{ flex: 1 }} />
            <Show
              when={running() && !draft().trim()}
              fallback={
                <button
                  type="button"
                  class="round"
                  aria-label="Send"
                  disabled={!draft().trim() || down()}
                  onClick={() => void submit()}
                >
                  <I d={P.up} size={15} sw={2.2} />
                </button>
              }
            >
              <button
                type="button"
                class="round stop"
                aria-label="Stop turn"
                onClick={() => props.root && props.id && void stop(props.root, props.id)}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                  <rect x="1" y="1" width="8" height="8" rx="1.5" fill="currentColor" />
                </svg>
              </button>
            </Show>
          </div>
        </div>
        <Show when={!props.isNew}>
          <div class="below">
            <span class="hide-sm" title="Runs in">
              <I d={project(props.root)?.git?.worktree ? P.folder : P.laptop} size={15} />
              {project(props.root)?.git?.worktree ? "Worktree" : "Local"}
            </span>
            <div style={{ flex: 1 }} />
            <Show when={cold()}>
              {(c) => (
                <span
                  class="hide-sm"
                  style={{ color: "var(--amber)" }}
                  title="The provider keeps a cached prompt about 5 minutes. After that, the next message reads the whole context again at the full input price. /compact makes the context smaller first."
                >
                  {`Cache expired: the next message reads ${tokens(c().used)} tokens again${c().cost === undefined ? "" : `, about ${usd(c().cost as number)}`}`}
                </span>
              )}
            </Show>
            <Show when={context()}>
              {(c) => (
                <span class="hide-sm" title={`${tokens(c().used)} of ${tokens(c().window)} tokens`}>
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 14 14"
                    aria-hidden="true"
                    style={{ transform: "rotate(-90deg)" }}
                  >
                    <circle cx="7" cy="7" r="6" fill="none" stroke="var(--muted)" stroke-width="1.2" />
                    <circle
                      cx="7"
                      cy="7"
                      r="2.75"
                      fill="none"
                      stroke="var(--muted)"
                      stroke-width="5.5"
                      stroke-dasharray={`${(c().pct * 0.1728).toFixed(2)} 17.28`}
                    />
                  </svg>
                  {`${c().pct}% context`}
                </span>
              )}
            </Show>
            <Show when={project(props.root)?.git?.branch}>
              {(b) => (
                <span title="Branch">
                  <I d={P.branch} size={15} />
                  {b()}
                </span>
              )}
            </Show>
          </div>
        </Show>
      </div>
    </div>
  );
}

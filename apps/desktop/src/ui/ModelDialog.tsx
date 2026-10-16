import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { tokens } from "../lib/format.ts";
import {
  currentModel,
  EFFORT_LABEL,
  effortFor,
  effortsOf,
  type ModelChoice,
  modelChoices,
  pickModel,
  savePrefs,
  state,
} from "../lib/store.ts";
import { Check, I, P } from "./icons.tsx";
import { closeMenu, openMenu } from "./menu.tsx";

/** The model picker: search, recent picks, then each connected provider's models. Opens where `/model` or the
 *  composer's model button sets the "model" menu. */
export function ModelDialog(props: { root: string | null }) {
  const [q, setQ] = createSignal("");
  const [at, setAt] = createSignal(0);
  const cur = () => currentModel(props.root);
  const sections = createMemo(() => {
    const words = q().toLowerCase().split(/\s+/).filter(Boolean);
    const list = modelChoices(props.root).filter((c) => {
      const text = `${c.label} ${c.model} ${c.desc} ${c.free ? "free" : ""}`.toLowerCase();
      return words.every((w) => text.includes(w));
    });
    const groups: [string, ModelChoice[]][] = [];
    if (words.length === 0) {
      const recent = state.prefs.recent.flatMap((r) => list.filter((c) => c.ref === r));
      if (recent.length > 0) groups.push(["Recent", recent]);
    }
    const byProvider = new Map<string, ModelChoice[]>();
    for (const c of list) byProvider.set(c.desc, [...(byProvider.get(c.desc) ?? []), c]);
    groups.push(...byProvider);
    // A recent model shows twice, so each row carries its own position for the keyboard.
    let n = 0;
    return groups.map(([title, items]) => ({ title, items: items.map((c) => ({ c, n: n++ })) }));
  });
  const flat = createMemo(() => sections().flatMap((s) => s.items.map((x) => x.c)));
  createEffect(on(q, () => setAt(0)));

  const choose = (c: ModelChoice | undefined) => {
    if (!c) return;
    pickModel(c.ref);
    closeMenu();
  };
  let list: HTMLDivElement | undefined;
  const move = (by: number) => {
    const n = flat().length;
    if (n === 0) return;
    setAt((i) => (i + by + n) % n);
    list?.querySelector(`[data-i="${at()}"]`)?.scrollIntoView({ block: "nearest" });
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") move(1);
    else if (e.key === "ArrowUp") move(-1);
    else if (e.key === "Enter") choose(flat()[at()]);
    else return;
    e.preventDefault();
  };
  const levels = () => effortsOf(cur());

  return (
    <Show when={openMenu() === "model"}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: Escape and a click outside close it */}
      <div
        class="dialog-scrim"
        onClick={(e) => {
          if (e.target === e.currentTarget) closeMenu();
        }}
      >
        <div class="picker" role="dialog" aria-modal="true" aria-label="Choose a model">
          <label class="picker-search">
            <I d={P.search} size={15} sw={1.7} />
            <input
              type="search"
              placeholder="Search models"
              aria-label="Search models"
              aria-controls="model-list"
              aria-activedescendant={flat()[at()] ? `model-${at()}` : undefined}
              value={q()}
              ref={(el) => setTimeout(() => el.focus())}
              onInput={(e) => setQ(e.currentTarget.value)}
              onKeyDown={onKey}
            />
          </label>
          <div class="picker-list" id="model-list" role="listbox" aria-label="Models" ref={list}>
            <Show
              when={flat().length > 0}
              fallback={
                <p class="picker-empty">
                  {modelChoices(props.root).length === 0
                    ? "No provider is connected. Connect one in Settings."
                    : "No model matches."}
                </p>
              }
            >
              <For each={sections()}>
                {(s) => (
                  // biome-ignore lint/a11y/useSemanticElements: a group of options inside a listbox
                  <div role="group" aria-label={s.title}>
                    <div class="picker-head">{s.title}</div>
                    <For each={s.items}>
                      {({ c, n }) => (
                        // biome-ignore lint/a11y/useFocusableInteractive: the search field keeps focus and moves the active option
                        // biome-ignore lint/a11y/useKeyWithClickEvents: the search field handles the keys for the list
                        <div
                          id={`model-${n}`}
                          data-i={n}
                          role="option"
                          aria-selected={at() === n}
                          class={at() === n ? "picker-row on" : "picker-row"}
                          onMouseMove={() => setAt(n)}
                          onClick={() => choose(c)}
                        >
                          <Check on={c.ref === cur()?.ref} />
                          <span class="ell" style={{ flex: 1, "min-width": 0 }}>
                            {c.label}
                          </span>
                          <Show when={c.free}>
                            <span class="tag free">Free</span>
                          </Show>
                          <Show when={c.thinking}>
                            <span class="tag">Reasoning</span>
                          </Show>
                          <span class="picker-ctx">{tokens(c.contextWindow)}</span>
                        </div>
                      )}
                    </For>
                  </div>
                )}
              </For>
            </Show>
          </div>
          <Show when={levels().length > 0}>
            <div class="picker-foot">
              <span>Reasoning effort</span>
              <div class="seg" role="radiogroup" aria-label="Reasoning effort">
                <For each={levels()}>
                  {(l) => (
                    // biome-ignore lint/a11y/useSemanticElements: .seg styles button[aria-checked]
                    <button
                      type="button"
                      role="radio"
                      aria-checked={effortFor(cur()) === l}
                      onClick={() => savePrefs({ effort: l })}
                    >
                      {EFFORT_LABEL[l]}
                    </button>
                  )}
                </For>
              </div>
            </div>
          </Show>
        </div>
      </div>
    </Show>
  );
}

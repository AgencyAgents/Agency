import { createSignal, For, type JSX, Show } from "solid-js";
import { Check, I, P } from "./icons.tsx";

/** One open popover at a time; a click outside or Escape closes it. */
export const [openMenu, setOpenMenu] = createSignal<string | null>(null);
export const toggleMenu = (id: string) => setOpenMenu((m) => (m === id ? null : id));
export const closeMenu = () => setOpenMenu(null);

export interface Choice<T> {
  value: T;
  label: string;
  desc?: string;
  disabled?: boolean;
}

/** A radio list for a `.pop` menu: a check marks the current value. A long list gets a search field. */
export function Choices<T>(props: {
  items: Choice<T>[];
  current: T;
  pick: (value: T) => void;
  two?: boolean;
}) {
  const [q, setQ] = createSignal("");
  const shown = () => {
    const words = q().toLowerCase().split(/\s+/).filter(Boolean);
    return props.items.filter((i) => {
      const text = `${i.label} ${i.desc ?? ""} ${String(i.value)}`.toLowerCase();
      return words.every((w) => text.includes(w));
    });
  };
  return (
    <>
      <Show when={props.items.length > 12}>
        <label class="search pop-search">
          <I d={P.search} size={14} sw={1.7} />
          <input
            type="search"
            placeholder="Search"
            aria-label="Search"
            value={q()}
            ref={(el) => setTimeout(() => el.focus())}
            onInput={(e) => setQ(e.currentTarget.value)}
            onKeyDown={(e) => {
              const first = shown()[0];
              if (e.key !== "Enter" || !first || first.disabled) return;
              props.pick(first.value);
              closeMenu();
            }}
          />
        </label>
        <Show when={shown().length === 0}>
          <div class="mi" style={{ color: "var(--muted)", cursor: "default" }}>
            No match
          </div>
        </Show>
      </Show>
      <For each={shown()}>
        {(item) => (
          <button
            type="button"
            role="menuitemradio"
            aria-checked={item.value === props.current ? "true" : "false"}
            class={props.two && item.desc ? "mi two" : "mi"}
            disabled={item.disabled}
            onClick={() => {
              props.pick(item.value);
              closeMenu();
            }}
          >
            <Check on={item.value === props.current} />
            <Show
              when={props.two && item.desc}
              fallback={
                <>
                  <span class="ell" style={{ flex: 1 }}>
                    {item.label}
                  </span>
                  <Show when={item.desc}>
                    <span
                      class="ell"
                      style={{ color: "var(--muted)", "font-size": "12px", "max-width": "45%" }}
                    >
                      {item.desc}
                    </span>
                  </Show>
                </>
              }
            >
              <span style={{ flex: 1, display: "flex", "flex-direction": "column", "min-width": 0 }}>
                <span>{item.label}</span>
                <span style={{ color: "var(--muted)", "font-size": "12px" }}>{item.desc}</span>
              </span>
            </Show>
          </button>
        )}
      </For>
    </>
  );
}

export function Pop(props: {
  id: string;
  label: string;
  style: JSX.CSSProperties;
  up?: boolean;
  role?: "menu" | "dialog";
  children: JSX.Element;
}) {
  return (
    <Show when={openMenu() === props.id}>
      <Show
        when={props.role === "dialog"}
        fallback={
          <div role="menu" aria-label={props.label} class={props.up ? "pop up" : "pop"} style={props.style}>
            {props.children}
          </div>
        }
      >
        <div role="dialog" aria-label={props.label} class={props.up ? "pop up" : "pop"} style={props.style}>
          {props.children}
        </div>
      </Show>
    </Show>
  );
}

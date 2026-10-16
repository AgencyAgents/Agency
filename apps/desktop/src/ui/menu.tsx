import { createSignal, For, type JSX, Show } from "solid-js";
import { Check } from "./icons.tsx";

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

/** A radio list for a `.pop` menu: a check marks the current value. */
export function Choices<T>(props: {
  items: Choice<T>[];
  current: T;
  pick: (value: T) => void;
  two?: boolean;
}) {
  return (
    <For each={props.items}>
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

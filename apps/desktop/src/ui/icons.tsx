import type { JSX } from "solid-js";

export const P = {
  sidebar: "M3.5 7.5a3 3 0 0 1 3-3h11a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3h-11a3 3 0 0 1-3-3ZM9.5 4.5v15",
  panel: "M3.5 7.5a3 3 0 0 1 3-3h11a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3h-11a3 3 0 0 1-3-3ZM14.5 4.5v15",
  compose:
    "M12 4H7a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-5M17.5 3.5a2 2 0 0 1 3 3L12 15l-4 1 1-4Z",
  skill: "M12 3 20 7.5v9L12 21l-8-4.5v-9ZM4 7.5 12 12l8-4.5M12 12v9",
  workflow:
    "M5.5 3.5h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-3a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2ZM15.5 13.5h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-3a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2ZM7 10.5v3a3 3 0 0 0 3 3h3.5",
  filter: "M4 7h16M7 12h10M10 17h4",
  search: "M11 17.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM20 20l-4-4",
  folder: "M3.5 7.5a2 2 0 0 1 2-2h3.8l2 2h7.2a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z",
  chevR: "m10 7 5 5-5 5",
  chevD: "m6 9 6 6 6-6",
  chevL: "m15 18-6-6 6-6",
  check: "m5 12.5 4.5 4.5L19 7.5",
  x: "M6 6l12 12M18 6 6 18",
  plus: "M12 5v14M5 12h14",
  gear: "M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7 7 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.07-.4.1-.8.1-1.2ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
  open: "M18 13.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4.5M14 4h6v6M20 4l-8.5 8.5",
  commit: "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM3 12h5.5M15.5 12H21",
  shield: "M12 3.5 5 6.3v5.5c0 4.2 3 7.4 7 8.7 4-1.3 7-4.5 7-8.7V6.3Z",
  branch:
    "M7 8.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4ZM7 20.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4ZM17 10.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4ZM7 8.2v7.6M17 10.2c0 4-5.5 3.2-9.2 6",
  laptop: "M5.5 5h13a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2ZM2 19h20",
  file: "M13.5 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9ZM13.5 3.5V9H19",
  image:
    "M5 4.5h14a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18V6A1.5 1.5 0 0 1 5 4.5ZM3.5 15.5l4.5-4.5 4 4 2.5-2.5 6 6M15.5 9.5h.01",
  copy: "M10.5 8.5h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2ZM15.5 5.5v-1a2 2 0 0 0-2-2h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h1",
  up: "M12 19V5M6 11l6-6 6 6",
  slash: "M15 4 9 20",
  alert: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7.5v5.5M12 16.5h.01",
  fail: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM9.5 9.5l5 5M14.5 9.5l-5 5",
  done: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM8 12l3 3 5-5.5",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7.5V12l3 2",
  ring: "M21 12a9 9 0 1 1-9-9",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3",
  pencil: "M16.5 4.5a2.1 2.1 0 0 1 3 3L8.5 18.5 4.5 19.5l1-4Z",
  play: "M7 4.5v15l12-7.5Z",
  stopSq: "M7 7h10v10H7Z",
};

export function I(props: {
  d: string;
  size?: number;
  sw?: number;
  class?: string;
  style?: JSX.CSSProperties;
  stroke?: string;
  label?: string;
}) {
  return (
    <svg
      width={props.size ?? 16}
      height={props.size ?? 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke={props.stroke ?? "currentColor"}
      stroke-width={props.sw ?? 1.5}
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class}
      style={{ flex: "none", ...props.style }}
      role={props.label ? "img" : undefined}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : "true"}
    >
      <path d={props.d} />
    </svg>
  );
}

export function Spinner(props: { size?: number; label?: string }) {
  return (
    <svg
      class="spin"
      width={props.size ?? 13}
      height={props.size ?? 13}
      viewBox="0 0 16 16"
      style={{ flex: "none" }}
      role={props.label ? "img" : undefined}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : "true"}
    >
      <circle cx="8" cy="8" r="6" fill="none" stroke="var(--spin-track)" stroke-width="1.6" />
      <path
        d="M8 2a6 6 0 0 1 6 6"
        fill="none"
        stroke="var(--accent-text)"
        stroke-width="1.6"
        stroke-linecap="round"
      />
    </svg>
  );
}

export function Check(props: { on: boolean }) {
  return <span class="mi-check">{props.on ? <I d={P.check} size={13} sw={2.2} /> : null}</span>;
}

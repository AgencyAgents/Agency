import { getCurrentWindow } from "@tauri-apps/api/window";
import { createEffect, lazy, onCleanup, onMount, Show, Suspense } from "solid-js";
import { boot, setState, state } from "../lib/store.ts";
import { Details } from "./Details.tsx";
import { closeMenu, openMenu } from "./menu.tsx";
import { SessionView } from "./SessionView.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { startup, UpdateScreen } from "./Updater.tsx";

const Settings = lazy(() => import("./Settings.tsx"));
const Skills = lazy(() => import("./Skills.tsx"));
const Workflows = lazy(() => import("./Workflows.tsx"));

function useTheme() {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () => {
    const pref = state.prefs.theme;
    const dark = pref === "dark" || (pref === "system" && media.matches);
    document.documentElement.classList.toggle("dk", dark);
    void getCurrentWindow()
      .setTheme(pref === "system" ? null : pref)
      .catch(() => {});
  };
  createEffect(apply);
  media.addEventListener("change", apply);
  onCleanup(() => media.removeEventListener("change", apply));
}

export function App() {
  useTheme();
  onMount(() => {
    void getCurrentWindow().show();
    void startup().then((go) => {
      if (!go) return;
      void boot();
      // Commit and schedule triggers run from app start, not from the first visit to Workflows.
      void import("../lib/workflows.ts").then((m) => m.startTriggers());
    });
  });
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && openMenu()) closeMenu();
  };
  window.addEventListener("keydown", onKey);
  onCleanup(() => window.removeEventListener("keydown", onKey));

  return (
    <>
      <UpdateScreen />
      <Show when={state.booted}>
        <div class="app">
          <Show when={openMenu()}>
            <div aria-hidden="true" class="scrim" onClick={closeMenu} />
          </Show>
          <Sidebar />
          <div class="stage">
            <Suspense>
              <Show when={state.view === "skills"}>
                <Skills />
              </Show>
              <Show when={state.view === "workflows"}>
                <Workflows />
              </Show>
            </Suspense>
            <Show when={state.view !== "skills" && state.view !== "workflows"}>
              <SessionView />
            </Show>
            <Details />
          </div>
          <Show when={state.settings}>
            <Suspense>
              <Settings onClose={() => setState("settings", false)} />
            </Suspense>
          </Show>
        </div>
      </Show>
    </>
  );
}

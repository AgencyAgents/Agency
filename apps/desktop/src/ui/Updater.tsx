import { createSignal, Show } from "solid-js";
import { bytes } from "../lib/format.ts";
import { errorText, host, type UpdateInfo } from "../lib/host.ts";
import { Spinner } from "./icons.tsx";

type Phase =
  | { kind: "starting" }
  | { kind: "updating"; info: UpdateInfo; received: number; total: number | null; installing: boolean }
  | { kind: "failed"; info: UpdateInfo; error: string }
  | { kind: "ready" };

const [phase, setPhase] = createSignal<Phase>({ kind: "starting" });
const [available, setAvailable] = createSignal<UpdateInfo | null>(null);

export { available as updateAvailable };

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([work, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);
}

/** Downloads and installs; the installer closes the app and starts the new version. */
export async function installUpdate(info: UpdateInfo): Promise<void> {
  setPhase({ kind: "updating", info, received: 0, total: null, installing: false });
  try {
    await host.updateInstall((p) => {
      const cur = phase();
      if (cur.kind !== "updating") return;
      setPhase(
        p.phase === "download"
          ? { ...cur, received: p.received, total: p.total }
          : { ...cur, installing: true },
      );
    });
  } catch (error) {
    setPhase({ kind: "failed", info, error: errorText(error) });
  }
}

/** Startup: a found update installs before the app opens; no answer within 4 s means start now and check later. */
export async function startup(): Promise<boolean> {
  const info = await withTimeout(
    host.updateCheck().catch(() => null),
    4000,
  );
  if (info) {
    await installUpdate(info);
    return false;
  }
  setPhase({ kind: "ready" });
  setInterval(
    () =>
      void host
        .updateCheck()
        .then((found) => found && setAvailable(found))
        .catch(() => {}),
    6 * 3600_000,
  );
  return true;
}

export function continueWithoutUpdate(): void {
  setPhase({ kind: "ready" });
}

export function UpdateScreen() {
  const pct = () => {
    const p = phase();
    return p.kind === "updating" && p.total ? Math.min(100, (p.received / p.total) * 100) : null;
  };
  return (
    <Show when={phase().kind !== "ready"}>
      <div class="screen" role="status" aria-live="polite">
        <Show when={phase().kind === "starting"}>
          <Spinner size={22} />
          <span style={{ color: "var(--muted)" }}>Starting Agency</span>
        </Show>
        <Show when={phase().kind === "updating" ? (phase() as Extract<Phase, { kind: "updating" }>) : false}>
          {(p) => (
            <>
              <Spinner size={22} />
              <h2>
                {p().installing
                  ? `Installing Agency ${p().info.version}`
                  : `Updating Agency to ${p().info.version}`}
              </h2>
              <div class="progress" aria-hidden="true">
                <span style={{ width: `${p().installing ? 100 : (pct() ?? 8)}%` }} />
              </div>
              <span style={{ color: "var(--muted)", "font-size": "12.5px" }}>
                {p().installing
                  ? "Agency restarts when the install is done."
                  : p().total
                    ? `${bytes(p().received)} of ${bytes(p().total ?? 0)}`
                    : p().received
                      ? `${bytes(p().received)} downloaded`
                      : "Connecting to GitHub"}
              </span>
            </>
          )}
        </Show>
        <Show when={phase().kind === "failed" ? (phase() as Extract<Phase, { kind: "failed" }>) : false}>
          {(p) => (
            <>
              <h2>The update did not install</h2>
              <span style={{ color: "var(--muted)", "max-width": "420px", "overflow-wrap": "anywhere" }}>
                {p().error}
              </span>
              <div style={{ display: "flex", gap: "8px", "margin-top": "6px" }}>
                <button type="button" class="pri" onClick={() => void installUpdate(p().info)}>
                  Try again
                </button>
                <button type="button" class="ol" onClick={continueWithoutUpdate}>
                  Continue with {p().info.current}
                </button>
              </div>
            </>
          )}
        </Show>
      </div>
    </Show>
  );
}

export function UpdateBanner() {
  return (
    <Show when={available()}>
      {(info) => (
        <div
          class="banner"
          role="status"
          style={{ margin: "0 0 8px", "flex-direction": "column", "align-items": "stretch" }}
        >
          <span style={{ "font-weight": 600 }}>Agency {info().version} is ready</span>
          <button
            type="button"
            class="pri"
            style={{ height: "30px", "justify-content": "center" }}
            onClick={() => void installUpdate(info())}
          >
            Restart to update
          </button>
        </div>
      )}
    </Show>
  );
}

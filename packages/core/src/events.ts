/**
 * The stable hook surface (R7). Emitted from day one even though nothing consumes
 * it yet in v1 — the TUI listens now, plugins listen later, without touching emitters.
 */
export interface AgencyEvents {
  "config.loaded": { config: unknown };
  "log.entry": { level: string; message: string; traceId?: string };
}

type Listener<T> = (payload: T) => void;

export class EventBus<Events extends object = AgencyEvents> {
  private readonly listeners = new Map<keyof Events, Set<Listener<never>>>();

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener as Listener<never>);
    this.listeners.set(event, set);
    return () => set.delete(listener as Listener<never>);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as Listener<Events[K]>)(payload);
    }
  }
}

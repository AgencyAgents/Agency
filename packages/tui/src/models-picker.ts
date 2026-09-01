import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { t } from "@agency/i18n";
import { go } from "fuzzysort";

/**
 * The /models picker: pure selection logic over the daemon's providers_list
 * result. Rendering stays in the UI layer; everything decision-shaped
 * (grouping, fuzzy search, ordering, gating, favorites/recents) lives here so
 * it's testable without a terminal.
 */

/** View of one model, mirroring the daemon's ProviderListModel over RPC. */
export interface PickerModel {
  id: string;
  name: string;
  providerId: string;
  providerName: string;
  pricing: { inputPerMTok: number; outputPerMTok: number; cachedInputPerMTok?: number };
  contextWindow: number;
  capabilities: { tools: boolean; vision: boolean; thinking: boolean };
  status?: "alpha" | "beta" | "deprecated" | "active";
  releaseDate?: string;
}

/** View of one provider group, mirroring the daemon's ProviderListEntry. */
export interface PickerProvider {
  id: string;
  name: string;
  models: PickerModel[];
}

export interface PickerSection {
  key: string;
  label: string;
  models: PickerModel[];
}

/** "provider/model" identity used by favorites and recents. */
export function modelKey(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}

export function parseModelKey(key: string): { providerId: string; modelId: string } | undefined {
  const slash = key.indexOf("/");
  if (slash <= 0 || slash === key.length - 1) return undefined;
  return { providerId: key.slice(0, slash), modelId: key.slice(slash + 1) };
}

/** Deprecated and alpha models are hidden unless the user opts in. */
export function isGated(model: PickerModel): boolean {
  return model.status === "deprecated" || model.status === "alpha";
}

/**
 * Listing order: free models first (a $0 input price is the "Free" footer),
 * then newest release, then name as a stable tiebreaker.
 */
export function sortModelOptions(models: readonly PickerModel[]): PickerModel[] {
  return [...models].sort((a, b) => {
    const freeA = a.pricing.inputPerMTok === 0 ? 0 : 1;
    const freeB = b.pricing.inputPerMTok === 0 ? 0 : 1;
    if (freeA !== freeB) return freeA - freeB;

    const timeA = a.releaseDate ? new Date(a.releaseDate).getTime() : 0;
    const timeB = b.releaseDate ? new Date(b.releaseDate).getTime() : 0;
    if (timeA !== timeB) return timeB - timeA;

    return a.name.localeCompare(b.name);
  });
}

export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${trimNumber(tokens / 1_000_000)}M`;
  if (tokens >= 1_000) return `${trimNumber(tokens / 1_000)}k`;
  return String(tokens);
}

function trimNumber(value: number): string {
  return String(Number(value.toFixed(1)));
}

/** Text badges for the detail line; every cue is textual, never color-only. */
export function modelBadges(model: PickerModel): string[] {
  const badges: string[] = [];
  if (model.pricing.inputPerMTok === 0) badges.push(t("tui.picker.free"));
  if (model.contextWindow > 0) {
    badges.push(`ctx ${formatContextWindow(model.contextWindow)}`);
  }
  if (model.capabilities.tools) badges.push("tools");
  if (model.capabilities.vision) badges.push("vision");
  if (model.capabilities.thinking) badges.push("thinking");
  if (model.status && model.status !== "active") badges.push(model.status);
  return badges;
}

export interface PickerQueryOptions {
  query?: string;
  /** "provider/model" keys, most recently favorited last. */
  favorites?: readonly string[];
  /** "provider/model" keys, most recent first. */
  recents?: readonly string[];
  includeGated?: boolean;
}

/**
 * Builds the picker's sections: Favorites and Recent first when set, then one
 * section per provider. A query switches to a single fuzzy-searched section
 * over every provider at once, matching opencode's dialog-model behavior.
 */
export function buildPickerSections(
  providers: readonly PickerProvider[],
  options: PickerQueryOptions = {},
): PickerSection[] {
  const all = providers.flatMap((provider) =>
    provider.models.map((model) => ({ ...model, providerId: provider.id, providerName: provider.name })),
  );
  const visible = options.includeGated ? all : all.filter((model) => !isGated(model));

  const query = options.query?.trim() ?? "";
  if (query) {
    const results = go(query, visible, { keys: ["name", "providerName"], limit: 50, threshold: 0 });
    return [{ key: "results", label: t("tui.picker.results"), models: results.map((r) => r.obj) }];
  }

  const byKey = new Map(visible.map((model) => [modelKey(model.providerId, model.id), model]));
  const pick = (keys: readonly string[] | undefined): PickerModel[] =>
    (keys ?? []).flatMap((key) => {
      const model = byKey.get(key);
      return model ? [model] : [];
    });

  const sections: PickerSection[] = [];
  const favorites = pick(options.favorites);
  if (favorites.length > 0) {
    sections.push({ key: "favorites", label: t("tui.picker.favorites"), models: favorites });
  }
  const recents = pick(options.recents);
  if (recents.length > 0) {
    sections.push({ key: "recent", label: t("tui.picker.recent"), models: recents });
  }

  const grouped = new Map<string, PickerModel[]>();
  for (const model of visible) {
    const group = grouped.get(model.providerName) ?? [];
    group.push(model);
    grouped.set(model.providerName, group);
  }
  for (const [providerName, models] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    sections.push({ key: providerName, label: providerName, models: sortModelOptions(models) });
  }
  return sections;
}

export interface ModelPickerState {
  favorites: string[];
  recent: string[];
}

const EMPTY_STATE: ModelPickerState = { favorites: [], recent: [] };

/**
 * Persists favorites and recents as "provider/model" keys. With a path it's a
 * small JSON file under the data dir; without one it degrades to in-memory
 * state, so the picker works everywhere and only remembers across runs when
 * there's somewhere to put it.
 */
export class ModelPickerStore {
  private state: ModelPickerState;

  constructor(private readonly filePath?: string) {
    this.state = filePath ? this.read() : { ...EMPTY_STATE };
  }

  private read(): ModelPickerState {
    if (!this.filePath || !existsSync(this.filePath)) return { ...EMPTY_STATE };
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<ModelPickerState>;
      return {
        favorites: Array.isArray(raw.favorites) ? raw.favorites.filter((k) => parseModelKey(k)) : [],
        recent: Array.isArray(raw.recent) ? raw.recent.filter((k) => parseModelKey(k)) : [],
      };
    } catch {
      return { ...EMPTY_STATE };
    }
  }

  current(): ModelPickerState {
    return this.state;
  }

  save(state: ModelPickerState): void {
    this.state = state;
    if (!this.filePath) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(state, null, 2));
  }

  toggleFavorite(key: string): ModelPickerState {
    const favorites = this.state.favorites.includes(key)
      ? this.state.favorites.filter((k) => k !== key)
      : [...this.state.favorites, key];
    const next = { ...this.state, favorites };
    this.save(next);
    return next;
  }

  recordRecent(key: string, limit = 10): ModelPickerState {
    const recent = [key, ...this.state.recent.filter((k) => k !== key)].slice(0, limit);
    const next = { ...this.state, recent };
    this.save(next);
    return next;
  }
}

import type { ModelInfo } from "./registry.ts";

/** Task categories cheap enough for the small model. */
const ELIGIBLE_KINDS: ReadonlySet<string> = new Set(["title", "summary", "background"]);

/** Caller intent for one routing decision. */
export interface CheapRouteInput {
  readonly kind?: string;
  /** Explicit override; when true the primary model always wins. */
  readonly forcePrimary?: boolean;
}

/** Resolved model plus its audit tag; no silent downgrade. */
export interface ModelSelection {
  readonly model: string;
  readonly routed: "cheap" | "primary";
  readonly tag: string;
}

/** Outcome of a routed call, noting fallback. */
export interface RoutedResult<T> {
  readonly value: T;
  readonly model: string;
  readonly fellBack: boolean;
  readonly tag: string;
}

/** True for low risk kinds safe on the small model. */
export function isCheapEligible(kind: string | undefined): boolean {
  if (!kind) return false;
  return ELIGIBLE_KINDS.has(kind);
}

/** Pure selector: eligible goes cheap unless overridden. */
export function selectModel(
  primaryModel: string,
  cheapModel: string | undefined,
  input: CheapRouteInput,
): ModelSelection {
  if (input.forcePrimary === true) {
    return { model: primaryModel, routed: "primary", tag: "route=primary reason=override" };
  }
  if (cheapModel !== undefined && isCheapEligible(input.kind)) {
    return { model: cheapModel, routed: "cheap", tag: `route=cheap kind=${input.kind}` };
  }
  return { model: primaryModel, routed: "primary", tag: `route=primary kind=${input.kind ?? "none"}` };
}

/** Runs the selected model, retrying once on primary after cheap failure. */
export async function withCheapFallback<T>(
  selection: ModelSelection,
  primaryModel: string,
  run: (model: string) => Promise<T>,
): Promise<RoutedResult<T>> {
  if (selection.routed !== "cheap") {
    const value = await run(primaryModel);
    return { value, model: primaryModel, fellBack: false, tag: selection.tag };
  }
  try {
    const value = await run(selection.model);
    return { value, model: selection.model, fellBack: false, tag: selection.tag };
  } catch (error) {
    const value = await run(primaryModel);
    const cause = error instanceof Error ? error.message : String(error);
    return {
      value,
      model: primaryModel,
      fellBack: true,
      tag: `${selection.tag} fallback=primary cheapError=${truncateForTag(cause)}`,
    };
  }
}

/** Keep the root cause in the tag without letting a huge message bloat logs. */
function truncateForTag(message: string, limit = 120): string {
  const singleLine = message.replace(/\s+/g, " ").trim();
  return singleLine.length > limit ? singleLine.slice(0, limit) : singleLine;
}

/** Cost then age picker: cheapest input price wins, newest breaks ties. */
// Input price leads because utility traffic is input-heavy.
export function pickCheapModel(models: readonly ModelInfo[]): ModelInfo | undefined {
  let best: ModelInfo | undefined;
  for (const m of models) {
    if (!best) {
      best = m;
      continue;
    }
    const price = m.pricing.inputPerMTok - best.pricing.inputPerMTok;
    if (price < 0 || (price === 0 && (m.releaseDate ?? "") > (best.releaseDate ?? ""))) best = m;
  }
  return best;
}

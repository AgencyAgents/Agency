import type { RiskTier, ToolSpec } from "./contract.ts";

export interface ToolRegistrationOptions {
  /** Registers the tool under `namespace_name` (the MCP convention), so
   *  plugins and per-agent toolsets can never collide with built-ins. */
  namespace?: string;
}

/** Factory for a deferred tool. May be sync or async; async loaders are
 *  shared single-flight so concurrent first calls promote exactly once. */
export type DeferredToolLoader = () => ToolSpec | Promise<ToolSpec>;

/** Decides whether a deferred tool may construct. Evaluated with the same
 *  `(name, riskTier)` pair the permissions gate sees; a throw fails closed. */
export type DeferredToolPredicate = (name: string, riskTier: RiskTier | undefined) => boolean;

export interface DeferredRegistrationOptions extends ToolRegistrationOptions {
  /** Lightweight metadata the gate sees without constructing the tool.
   *  Deferral is construction-only; permission evaluation is never deferred. */
  riskTier?: RiskTier;
  description?: string;
  /** Promotion predicate; default always promotes when offered. */
  predicate?: DeferredToolPredicate;
}

interface DeferredEntry {
  kind: "deferred";
  name: string;
  loader: DeferredToolLoader;
  predicate: DeferredToolPredicate;
  riskTier: RiskTier | undefined;
  description: string;
  resolved?: ToolSpec;
  failure?: Error;
  inflight?: Promise<ToolSpec>;
}

/** Typed fail-closed placeholder: the gate still sees the tool (name +
 *  riskTier are real) but calls fail closed until promotion succeeds. */
function unpromotedPlaceholder(name: string, riskTier: RiskTier | undefined, description: string): ToolSpec {
  return {
    name,
    description,
    inputSchema: { type: "object", properties: {} },
    ...(riskTier === undefined ? {} : { riskTier }),
    handler: async () => ({
      content:
        `[deferred-unpromoted:${name}] tool "${name}" is not promoted ` +
        `(promotion predicate declined); promote via registry.promote("${name}")`,
      isError: true,
    }),
  };
}

function promotionFailedError(name: string, cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(`[deferred-promotion-failed:${name}] tool "${name}" failed to promote: ${detail}`);
}

/**
 * Dynamic tool registry over the flat ToolSpec list (A6): add/remove at
 * runtime, namespaced registration, prefix filtering, and per-agent subsets
 * through a permissions predicate (the daemon passes its A5 gate's
 * `toolOffered`). Backward compatible: `list()` is the same ordered ToolSpec[]
 * createBuiltinTools always returned.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolSpec | DeferredEntry>();

  private static entryName(specName: string, options?: ToolRegistrationOptions): string {
    return options?.namespace === undefined ? specName : `${options.namespace}_${specName}`;
  }

  private static isDeferred(entry: ToolSpec | DeferredEntry): entry is DeferredEntry {
    return (entry as DeferredEntry).kind === "deferred";
  }

  /** Resolve a deferred entry when its predicate passes. Sync loaders settle
   *  inline; async loaders park single-flight and callers get a placeholder
   *  whose handler awaits the shared promotion. Never throws for predicate
   *  declines — those stay fail-closed placeholders. */
  private resolveEntry(entry: DeferredEntry): ToolSpec {
    if (entry.resolved) return entry.resolved;
    let pass: boolean;
    try {
      pass = entry.predicate(entry.name, entry.riskTier);
    } catch (error) {
      entry.failure = promotionFailedError(
        entry.name,
        `predicate threw: ${error instanceof Error ? error.message : String(error)}`,
      );
      return this.awaitingPlaceholder(entry);
    }
    if (!pass) return unpromotedPlaceholder(entry.name, entry.riskTier, entry.description);
    if (entry.inflight) return this.awaitingPlaceholder(entry);
    let produced: ToolSpec | Promise<ToolSpec>;
    try {
      produced = entry.loader();
    } catch (error) {
      entry.failure = promotionFailedError(entry.name, error);
      return this.awaitingPlaceholder(entry);
    }
    if (produced instanceof Promise) {
      return this.awaitingPlaceholder(entry, this.settlePromotion(entry, produced));
    }
    entry.resolved = ToolRegistry.adoptSpec(entry, produced);
    return entry.resolved;
  }

  /** Placeholder whose handler awaits the shared inflight promotion, then
   *  delegates to the real tool; surfaces the typed failure when it rejects. */
  private awaitingPlaceholder(entry: DeferredEntry, inflightOverride?: Promise<ToolSpec>): ToolSpec {
    if (entry.failure) {
      const message = entry.failure.message;
      return {
        name: entry.name,
        description: entry.description,
        inputSchema: { type: "object", properties: {} },
        ...(entry.riskTier === undefined ? {} : { riskTier: entry.riskTier }),
        handler: async () => ({ content: message, isError: true }),
      };
    }
    const inflight = inflightOverride ?? entry.inflight;
    if (!inflight) return unpromotedPlaceholder(entry.name, entry.riskTier, entry.description);
    return {
      name: entry.name,
      description: entry.description,
      inputSchema: { type: "object", properties: {} },
      ...(entry.riskTier === undefined ? {} : { riskTier: entry.riskTier }),
      handler: async (input, ctx) => {
        try {
          const spec = await inflight;
          return spec.handler(input, ctx);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { content: message, isError: true };
        }
      },
    };
  }

  /** Loader specs keep their own name; namespaced entries rename like register does. */
  private static adoptSpec(entry: DeferredEntry, spec: ToolSpec): ToolSpec {
    return spec.name === entry.name ? spec : { ...spec, name: entry.name };
  }

  private materialize(entry: ToolSpec | DeferredEntry): ToolSpec {
    return ToolRegistry.isDeferred(entry) ? this.resolveEntry(entry) : entry;
  }

  register(spec: ToolSpec, options?: ToolRegistrationOptions): void {
    const name = ToolRegistry.entryName(spec.name, options);
    if (this.tools.has(name)) {
      throw new Error(`tool "${name}" is already registered`);
    }
    this.tools.set(name, options?.namespace === undefined ? spec : { ...spec, name });
  }

  registerDeferred(name: string, loader: DeferredToolLoader, options?: DeferredRegistrationOptions): void {
    const registered = ToolRegistry.entryName(name, options);
    if (this.tools.has(registered)) {
      throw new Error(`tool "${registered}" is already registered`);
    }
    this.tools.set(registered, {
      kind: "deferred",
      name: registered,
      loader,
      predicate: options?.predicate ?? (() => true),
      riskTier: options?.riskTier,
      description: options?.description ?? "",
    });
  }

  /** Park an async production single-flight; caches resolve or typed failure. */
  private settlePromotion(entry: DeferredEntry, produced: Promise<ToolSpec>): Promise<ToolSpec> {
    entry.inflight = produced.then(
      (spec) => {
        entry.resolved = ToolRegistry.adoptSpec(entry, spec);
        entry.inflight = undefined;
        return entry.resolved;
      },
      (error: unknown) => {
        entry.failure = promotionFailedError(entry.name, error);
        entry.inflight = undefined;
        throw entry.failure;
      },
    );
    // Nobody may await the flight yet (sync getters); never go unhandled.
    entry.inflight.catch(() => {});
    return entry.inflight;
  }

  /** Start (or join) the shared promotion flight for an entry. */
  private startPromotion(entry: DeferredEntry): Promise<ToolSpec> {
    if (entry.inflight) return entry.inflight;
    let produced: ToolSpec | Promise<ToolSpec>;
    try {
      produced = entry.loader();
    } catch (error) {
      entry.failure = promotionFailedError(entry.name, error);
      return Promise.reject(entry.failure);
    }
    if (produced instanceof Promise) return this.settlePromotion(entry, produced);
    entry.resolved = ToolRegistry.adoptSpec(entry, produced);
    return Promise.resolve(entry.resolved);
  }

  /** Promote a deferred tool: checks the predicate, runs the loader
   *  single-flight, caches the result. Eager names return as-is. */
  async promote(name: string): Promise<ToolSpec> {
    const entry = this.tools.get(name);
    if (entry === undefined) throw new Error(`[deferred-unknown:${name}] tool "${name}" is not registered`);
    if (!ToolRegistry.isDeferred(entry)) return entry;
    if (entry.resolved) return entry.resolved;
    if (entry.failure) throw entry.failure;
    let pass: boolean;
    try {
      pass = entry.predicate(entry.name, entry.riskTier);
    } catch (error) {
      entry.failure = promotionFailedError(
        entry.name,
        `predicate threw: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw entry.failure;
    }
    if (!pass) {
      throw new Error(
        `[deferred-unpromoted:${name}] tool "${name}" is not promoted ` +
          `(promotion predicate declined); promote via registry.promote("${name}") ` +
          `after the predicate passes`,
      );
    }
    return this.startPromotion(entry);
  }

  /** True once a deferred tool has successfully promoted. */
  isPromoted(name: string): boolean {
    const entry = this.tools.get(name);
    return entry !== undefined && ToolRegistry.isDeferred(entry) && entry.resolved !== undefined;
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): ToolSpec | undefined {
    const entry = this.tools.get(name);
    if (entry === undefined) return undefined;
    return this.materialize(entry);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Every registered tool in registration order. Deferred entries resolve
   *  when their predicate passes; otherwise a fail-closed placeholder with
   *  the real name/riskTier stands in so the gate still sees the tool. */
  list(): ToolSpec[] {
    return [...this.tools.values()].map((entry) => this.materialize(entry));
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /** Tools whose registered name starts with `prefix` (namespacing filter). */
  filter(prefix: string): ToolSpec[] {
    return this.list().filter((tool) => tool.name.startsWith(prefix));
  }

  /** Per-agent subset: keeps the tools the predicate admits (A5 permissions).
   *  Permission is evaluated on name/riskTier before any construction, so
   *  denied deferred tools never promote. */
  forAgent(offered: (name: string, riskTier: RiskTier | undefined) => boolean): ToolSpec[] {
    const out: ToolSpec[] = [];
    for (const entry of this.tools.values()) {
      if (ToolRegistry.isDeferred(entry)) {
        if (!offered(entry.name, entry.riskTier)) continue;
        out.push(this.resolveEntry(entry));
        continue;
      }
      if (offered(entry.name, entry.riskTier)) out.push(entry);
    }
    return out;
  }
}

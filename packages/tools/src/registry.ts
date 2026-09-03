import type { RiskTier, ToolSpec } from "./contract.ts";

export interface ToolRegistrationOptions {
  /** Registers the tool under `namespace_name` (the MCP convention), so
   *  plugins and per-agent toolsets can never collide with built-ins. */
  namespace?: string;
}

/**
 * Dynamic tool registry over the flat ToolSpec list (A6): add/remove at
 * runtime, namespaced registration, prefix filtering, and per-agent subsets
 * through a permissions predicate (the daemon passes its A5 gate's
 * `toolOffered`). Backward compatible: `list()` is the same ordered ToolSpec[]
   * createBuiltinTools always returned.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolSpec>();

  register(spec: ToolSpec, options?: ToolRegistrationOptions): void {
    const name = options?.namespace === undefined ? spec.name : `${options.namespace}_${spec.name}`;
    if (this.tools.has(name)) {
      throw new Error(`tool "${name}" is already registered`);
    }
    this.tools.set(name, options?.namespace === undefined ? spec : { ...spec, name });
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): ToolSpec | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Every registered tool in registration order. */
  list(): ToolSpec[] {
    return [...this.tools.values()];
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /** Tools whose registered name starts with `prefix` (namespacing filter). */
  filter(prefix: string): ToolSpec[] {
    return this.list().filter((tool) => tool.name.startsWith(prefix));
  }

  /** Per-agent subset: keeps the tools the predicate admits (A5 permissions). */
  forAgent(offered: (name: string, riskTier: RiskTier | undefined) => boolean): ToolSpec[] {
    return this.list().filter((tool) => offered(tool.name, tool.riskTier));
  }
}
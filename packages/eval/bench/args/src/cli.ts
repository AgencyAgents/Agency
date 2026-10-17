import { parseArgs } from "./args.ts";

/** The port of `serve`: --port, then PORT, then 3000. */
export function portOf(argv: string[], env: Record<string, string | undefined>): number {
  const { flags } = parseArgs(argv);
  const raw = typeof flags.port === "string" ? flags.port : (env.PORT ?? "3000");
  return Number.parseInt(raw, 10);
}

#!/usr/bin/env bun
import { storagePaths } from "@agency/core";
import { t } from "@agency/i18n";
import { debugCommand } from "./debug.ts";
import { createTerminalOnboardingPrompter, runOnboarding } from "./onboarding.ts";

/**
 * Inlined at compile time by scripts/build.ts (--define); running from source
 * falls back to the package version.
 */
const VERSION = process.env.AGENCY_VERSION ?? "0.1.0";

const HELP = `Agency - production coding harness

Usage: agency [command] [options]

Commands:
  where                    Show storage paths
  storage                  Report storage sizes
  storage prune            Prune cache and old sessions
  session list             List sessions
  session delete <id>      Delete a session
  auth login               Connect a provider
  auth list                List connected providers
  onboard                  First-run setup: connect, model, trust
  debug                    Write a redacted debug bundle for issue reports
  --help, -h               Show this help
  --version, -v            Show version

Run without a command to launch the TUI.
`;

export async function runEntrypoint(argv: string[] = process.argv.slice(2)): Promise<number> {
  const [cmd, sub] = argv;
  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (cmd === "where") {
    const paths = storagePaths(process.cwd());
    process.stdout.write(`${JSON.stringify(paths, null, 2)}\n`);
    return 0;
  }
  if (cmd === "storage" && sub === "prune") {
    process.stdout.write("Pruned cache (noop in headless check).\n");
    return 0;
  }
  if (cmd === "storage") {
    const paths = storagePaths(process.cwd());
    process.stdout.write(
      `Sessions: ${paths.sessionsDir}\nCache: ${paths.cacheDir}\nLogs: ${paths.logsDir}\n`,
    );
    return 0;
  }
  if (cmd === "session" && sub === "list") {
    process.stdout.write("(no sessions or TUI required)\n");
    return 0;
  }
  if (cmd === "debug") {
    const { path } = debugCommand({ workspaceRoot: process.cwd(), version: VERSION });
    process.stdout.write(`${t("debug.written", { path })}\n`);
    return 0;
  }
  if (cmd === "onboard") {
    const result = await runOnboarding({
      workspaceRoot: process.cwd(),
      prompter: createTerminalOnboardingPrompter(),
      out: (line) => process.stdout.write(`${line}\n`),
    });
    return result.completed ? 0 : 1;
  }
  // Default: launch TUI hint (actual TUI requires a TTY)
  process.stdout.write("Agency TUI: run in a terminal with a TTY. Use --help for commands.\n");
  return 0;
}

if (import.meta.main) {
  runEntrypoint().then((code) => process.exit(code));
}

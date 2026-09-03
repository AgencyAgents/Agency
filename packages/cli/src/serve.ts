import { createAgentDaemon } from "./daemon.ts";

export async function runServe(options: { workspaceRoot: string; instanceFile: string; idleLingerMs?: number }): Promise<void> {
  const daemon = await createAgentDaemon({
    workspaceRoot: options.workspaceRoot,
    instanceFile: options.instanceFile,
    idleLingerMs: options.idleLingerMs,
    logsDir: undefined,
    onIdleShutdown: () => {
      void daemon.stop().then(() => process.exit(0));
    },
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      void daemon.stop().then(() => process.exit(0));
    });
  }
  console.log(`Agency daemon serving at ${options.workspaceRoot} (pid ${process.pid})`);
  await new Promise(() => {});
}

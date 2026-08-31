export interface KeychainBackend {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  set(account: string, secret: string): Promise<void>;
  get(account: string): Promise<string | undefined>;
  delete(account: string): Promise<void>;
}

/** Runs an external command and captures output, injectable so backends are
 *  unit-testable without actually shelling out to `security`/`secret-tool`. */
export type SpawnFn = (
  command: readonly string[],
  options?: { stdin?: string },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export const defaultSpawn: SpawnFn = async (command, options) => {
  const proc = Bun.spawn(command as string[], {
    stdin: options?.stdin !== undefined ? Buffer.from(options.stdin) : undefined,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
};

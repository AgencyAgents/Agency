import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { AgencyError, ErrorCode } from "@agency/schema";
import type { RequestApproval } from "./approval.ts";
import {
  type CommandPolicy,
  type ExternalDirectoryDecision,
  PROTECTED_PATHS,
  type SandboxBackend,
  SandboxBoundary,
} from "./sandbox.ts";
import {
  APPCONTAINER_MODE,
  prepareScriptContainer,
  prepareWindowsSandbox,
  windowsSandboxHelper,
  windowsSandboxSid,
} from "./sandbox-win.ts";

export interface OsSandboxOptions {
  /** Commands get the network. Default: no network. */
  allowNetwork?: boolean;
  /** For tests: the platform, and the programs. */
  platform?: NodeJS.Platform;
  bwrapBin?: string;
  seatbeltBin?: string;
  /** The `windowsShell` of the config: Git Bash does not start under the restricted token of Windows. */
  windowsShell?: "powershell" | "gitbash" | "cmd";
  /**
   * Folders that a command must not read: the keys, sessions and daemon tokens of the harness. Linux and macOS only:
   * the token of Windows restricts writes, not reads.
   */
  hidden?: string[];
}

/**
 * bubblewrap argv: the whole disk read-only, the workspace and a private /tmp writable, no network, and the
 * `hidden` folders empty. A mount point cannot be renamed: that pins `.git`. See `PROTECTED_PATHS`.
 */
export function buildBwrapArgs(
  root: string,
  cwd: string,
  allowNetwork: boolean,
  bin = "bwrap",
  hidden: string[] = [],
): string[] {
  const bind = (flag: string, paths: readonly string[]): string[] =>
    paths.flatMap((path) => [flag, `${root}/${path}`, `${root}/${path}`]);
  return [
    bin,
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
    ...hidden.flatMap((path) => ["--tmpfs", path]),
    "--bind",
    root,
    root,
    ...bind("--bind-try", PROTECTED_PATHS.pinned),
    ...bind("--ro-bind-try", PROTECTED_PATHS.readOnly),
    ...bind("--bind-try", PROTECTED_PATHS.writable),
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    ...(allowNetwork ? [] : ["--unshare-net"]),
    "--die-with-parent",
    "--new-session",
    "--chdir",
    cwd,
    "--",
  ];
}

const quote = (path: string): string => `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Seatbelt profile with the same rules as the bubblewrap argv. The last rule that matches wins. */
export function buildSeatbeltProfile(
  root: string,
  allowNetwork: boolean,
  tmpDir = "/private/tmp",
  hidden: string[] = [],
): string {
  const rules = (kind: string, paths: readonly string[]): string =>
    paths.map((path) => `(${kind} ${quote(`${root}/${path}`)})`).join(" ");
  return [
    "(version 1)",
    "(allow default)",
    ...hidden.map((path) => `(deny file-read* (subpath ${quote(path)}))`),
    "(deny file-write*)",
    `(allow file-write* (subpath ${quote(root)}) (subpath ${quote(tmpDir)}) (subpath "/private/tmp") (subpath "/private/var/folders") (literal "/dev/null") (regex #"^/dev/tty"))`,
    `(deny file-write* ${rules("literal", PROTECTED_PATHS.pinned)} ${rules("subpath", PROTECTED_PATHS.readOnly)})`,
    `(allow file-write* ${rules("subpath", PROTECTED_PATHS.writable)})`,
    ...(allowNetwork ? [] : ["(deny network*)"]),
  ].join("\n");
}

/**
 * The argv that runs a script process with no network, no write access and no view of the user's files: it talks
 * only on its stdin and stdout. `readPaths` are the files of the runner. On Windows, an AppContainer with no capability.
 */
export function buildScriptSandboxArgv(
  argv: string[],
  readPaths: string[],
  platform: NodeJS.Platform = process.platform,
): string[] | undefined {
  if (platform === "linux") {
    const system = ["/usr", "/lib", "/lib64", "/bin", "/etc/ld.so.cache"];
    return [
      "bwrap",
      ...system.flatMap((path) => ["--ro-bind-try", path, path]),
      ...readPaths.flatMap((path) => ["--ro-bind", path, path]),
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "--tmpfs",
      "/tmp",
      "--unshare-all",
      "--die-with-parent",
      "--new-session",
      "--chdir",
      "/tmp",
      "--",
      ...argv,
    ];
  }
  if (platform === "darwin") {
    const profile = [
      "(version 1)",
      "(allow default)",
      "(deny network*)",
      "(deny file-write*)",
      '(allow file-write* (literal "/dev/null"))',
      '(deny file-read* (subpath "/Users") (subpath "/Volumes") (subpath "/private/var/root") (subpath "/private/var/folders"))',
      ...readPaths.map((path) => `(allow file-read* (subpath ${quote(path)}))`),
    ].join("\n");
    return ["/usr/bin/sandbox-exec", "-p", profile, ...argv];
  }
  if (platform === "win32") return [...windowsSandboxHelper(), APPCONTAINER_MODE, "--", ...argv];
  return undefined;
}

/** The environment of the script process: nothing of the user's. The Windows container finds its profile by LOCALAPPDATA. */
export function scriptSandboxEnv(platform: NodeJS.Platform = process.platform): Record<string, string> {
  const env: Record<string, string> = { PATH: "/usr/bin:/bin" };
  if (platform !== "win32") return env;
  for (const name of ["SystemRoot", "LOCALAPPDATA"]) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return env;
}

let scriptSandboxProbe: Promise<boolean> | undefined;

/**
 * True when the script sandbox of this platform starts a process. One probe for the life of the daemon. On Windows
 * the container first gets read access to `readPaths`, the files of the runner.
 */
export function scriptSandboxAvailable(readPaths: string[] = []): Promise<boolean> {
  scriptSandboxProbe ??= (async () => {
    const windows = process.platform === "win32";
    if (windows && !(await prepareScriptContainer(readPaths))) return false;
    const argv = buildScriptSandboxArgv(windows ? ["cmd.exe", "/d", "/c", "exit 0"] : ["/usr/bin/true"], []);
    if (argv === undefined) return false;
    try {
      return (await Bun.spawn(argv, { stdout: "ignore", stderr: "ignore" }).exited) === 0;
    } catch {
      return false;
    }
  })();
  return scriptSandboxProbe;
}

/**
 * Runs each shell command in a sandbox of the operating system: bubblewrap on Linux, Seatbelt on macOS, a
 * write-restricted token on Windows. Paths and permission rules are those of the software boundary.
 */
export class OsSandboxBackend implements SandboxBackend {
  private readonly local: SandboxBoundary;
  private readonly root: string;
  private readonly platform: NodeJS.Platform;
  private readonly allowNetwork: boolean;
  private readonly sid: string;

  constructor(
    root: string,
    commandPolicy: CommandPolicy = {},
    externalDecision: ExternalDirectoryDecision | undefined = undefined,
    private readonly options: OsSandboxOptions = {},
  ) {
    this.local = new SandboxBoundary(root, commandPolicy, externalDecision);
    // The kernel rules name real paths: on macOS /var is a link to /private/var.
    try {
      this.root = realpathSync(root);
    } catch {
      this.root = root;
    }
    this.platform = options.platform ?? process.platform;
    this.allowNetwork = options.allowNetwork ?? false;
    this.sid = windowsSandboxSid(this.root);
  }

  resolvePath(candidate: string): string {
    return this.local.resolvePath(candidate);
  }

  resolvePathGated(candidate: string, opts: { tool: string; ask?: RequestApproval }): Promise<string> {
    return this.local.resolvePathGated(candidate, opts);
  }

  checkCommand(command: string): void {
    this.local.checkCommand(command);
  }

  /** The argv that runs `argv` in the sandbox. */
  wrap(argv: string[], cwd: string = this.root): string[] {
    if (this.platform === "linux") {
      return [
        ...buildBwrapArgs(this.root, cwd, this.allowNetwork, this.options.bwrapBin, this.hidden()),
        ...argv,
      ];
    }
    if (this.platform === "darwin") {
      const profile = buildSeatbeltProfile(
        this.root,
        this.allowNetwork,
        process.env.TMPDIR ?? "/private/tmp",
        this.hidden(),
      );
      return [this.options.seatbeltBin ?? "/usr/bin/sandbox-exec", "-p", profile, ...argv];
    }
    if (this.platform === "win32") return [...windowsSandboxHelper(), this.sid, "--", ...argv];
    throw new AgencyError(ErrorCode.INTERNAL, `sandbox.backend "os" has no backend for ${this.platform}`, {
      source: "sandbox-os",
    });
  }

  /** The hidden folders that exist and do not hold the workspace: bubblewrap mounts only on a folder that exists. */
  private hidden(): string[] {
    return (this.options.hidden ?? []).filter(
      (path) => existsSync(path) && !`${this.root}/`.startsWith(`${path.replace(/\/+$/, "")}/`),
    );
  }

  /** True when the sandbox program of this platform starts a command. */
  async isAvailable(): Promise<boolean> {
    // A `.agency` that a command makes would not be read-only: the rules apply to the paths that exist.
    mkdirSync(join(this.root, ".agency"), { recursive: true });
    if (this.platform === "win32") {
      // Here the folders get the rules of the SID, one time for each daemon start.
      if (this.windowsRefusal() !== undefined || !(await prepareWindowsSandbox(this.root, this.sid)))
        return false;
    } else if (this.platform !== "linux" && this.platform !== "darwin") return false;
    const probe = this.platform === "win32" ? ["cmd.exe", "/d", "/c", "exit 0"] : ["true"];
    try {
      const child = Bun.spawn(this.wrap(probe), { stdout: "ignore", stderr: "ignore" });
      return (await child.exited) === 0;
    } catch {
      return false;
    }
  }

  /** Why Windows refuses the config, before any probe. */
  private windowsRefusal(): string | undefined {
    if (this.options.windowsShell === "gitbash") {
      return 'sandbox.backend is "os", but Git Bash (MSYS) does not start under the restricted token of Windows. Remove windowsShell or set it to "powershell" or "cmd".';
    }
    if (!this.allowNetwork) {
      return 'sandbox.backend is "os", but on Windows a command cannot be kept off the network without administrator rights. Set sandbox.allowNetwork to true to accept that, or set sandbox.backend to "software".';
    }
    return undefined;
  }

  unavailableReason(): string {
    if (this.platform === "linux") {
      return 'sandbox.backend is "os" but bubblewrap did not start a command. Install it (`apt install bubblewrap`) and allow user namespaces, or set sandbox.backend to "software".';
    }
    if (this.platform === "darwin") {
      return 'sandbox.backend is "os" but /usr/bin/sandbox-exec did not start a command. Set sandbox.backend to "software".';
    }
    if (this.platform === "win32") {
      return (
        this.windowsRefusal() ??
        'sandbox.backend is "os", but the restricted token of Windows did not start a command, or the workspace did not take its access rule. Set sandbox.backend to "software".'
      );
    }
    return `sandbox.backend "os" works on Linux, macOS and Windows only, and this is ${this.platform}. Set sandbox.backend to "software".`;
  }

  async exec(
    argv: string[],
    opts: {
      cwd?: string;
      timeoutMs?: number;
      signal?: AbortSignal;
      env?: Record<string, string | undefined>;
    } = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    this.checkCommand(argv.join(" "));
    const child = Bun.spawn(this.wrap(argv, opts.cwd), {
      cwd: opts.cwd ?? this.root,
      stdout: "pipe",
      stderr: "pipe",
      ...(opts.env === undefined ? {} : { env: opts.env }),
    });
    const stdoutText = new Response(child.stdout).text();
    const stderrText = new Response(child.stderr).text();
    // --die-with-parent and the Seatbelt child both end with the wrapper process.
    const kill = (): void => {
      try {
        child.kill(9);
      } catch {}
    };
    let timedOut = false;
    if (opts.signal?.aborted) kill();
    else opts.signal?.addEventListener("abort", kill);
    const timer =
      opts.timeoutMs !== undefined && opts.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            kill();
          }, opts.timeoutMs)
        : undefined;
    try {
      const [stdout, stderr, exitCode] = await Promise.all([stdoutText, stderrText, child.exited]);
      if (timedOut) {
        throw new AgencyError(ErrorCode.INTERNAL, "sandboxed command timed out", {
          source: "sandbox-os",
          context: { argv, timedOut: true, stdout, stderr },
        });
      }
      return { stdout, stderr, exitCode };
    } finally {
      opts.signal?.removeEventListener("abort", kill);
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

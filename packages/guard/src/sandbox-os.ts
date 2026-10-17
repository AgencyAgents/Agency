import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgencyError, ErrorCode } from "@agency/schema";
import type { RequestApproval } from "./approval.ts";
import { startDomainProxy } from "./domain-proxy.ts";
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
  /** Commands reach only these hosts, through a proxy of the daemon. `allowNetwork` wins. Linux and macOS only. */
  allowedDomains?: string[];
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

const PROXY_VARS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];

/** The environment that sends the programs of a command to the proxy: an inherited NO_PROXY would skip it. */
function proxyEnv(url: string): Array<[string, string]> {
  return [...PROXY_VARS.map((name): [string, string] => [name, url]), ["NO_PROXY", ""], ["no_proxy", ""]];
}

const RELAY_PORT = 3128;
const RELAY_SOCKET = "/tmp/agency-proxy.sock";
/** In the network namespace of the sandbox: socat serves the Unix socket of the proxy on a port; the command waits for it. */
const RELAY_SCRIPT = `socat TCP-LISTEN:${RELAY_PORT},bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:${RELAY_SOCKET} </dev/null >/dev/null 2>&1 &
i=0; while [ $i -lt 300 ] && ! grep -q ':${RELAY_PORT.toString(16).toUpperCase().padStart(4, "0")} 00000000:0000 0A' /proc/net/tcp; do sleep 0.01; i=$((i+1)); done
exec "$@"`;

/**
 * bubblewrap argv: the whole disk read-only, the workspace and a private /tmp writable, no network, and the
 * `hidden` folders empty and the `masked` sockets gone. A mount point cannot be renamed: that pins `.git`. See
 * `PROTECTED_PATHS`. With `proxySocket` the command reaches only that proxy.
 */
export function buildBwrapArgs(
  root: string,
  cwd: string,
  allowNetwork: boolean,
  bin = "bwrap",
  hidden: string[] = [],
  proxySocket?: string,
  masked: string[] = [],
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
    ...masked.flatMap((path) => ["--ro-bind", "/dev/null", path]),
    "--bind",
    root,
    root,
    ...bind("--bind-try", PROTECTED_PATHS.pinned),
    ...bind("--ro-bind-try", PROTECTED_PATHS.readOnly),
    ...bind("--bind-try", PROTECTED_PATHS.writable),
    ...(proxySocket === undefined
      ? []
      : [
          "--bind",
          proxySocket,
          RELAY_SOCKET,
          ...proxyEnv(`http://127.0.0.1:${RELAY_PORT}`).flatMap(([name, value]) => ["--setenv", name, value]),
        ]),
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    ...(allowNetwork ? [] : ["--unshare-net"]),
    "--die-with-parent",
    "--new-session",
    "--chdir",
    cwd,
    "--",
    ...(proxySocket === undefined ? [] : ["/bin/sh", "-c", RELAY_SCRIPT, "sh"]),
  ];
}

const quote = (path: string): string => `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * Seatbelt profile with the same rules as the bubblewrap argv. The last rule that matches wins. With `proxyPort`
 * the command reaches only the proxy on that port.
 */
export function buildSeatbeltProfile(
  root: string,
  allowNetwork: boolean,
  tmpDir = "/private/tmp",
  hidden: string[] = [],
  proxyPort?: number,
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
    ...(allowNetwork || proxyPort === undefined
      ? []
      : [`(allow network-outbound (remote ip "localhost:${proxyPort}"))`]),
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
      return (await Bun.spawn(argv, { windowsHide: true, stdout: "ignore", stderr: "ignore" }).exited) === 0;
    } catch {
      return false;
    }
  })();
  return scriptSandboxProbe;
}

/**
 * Sockets of services that run a program on request outside any sandbox: the system bus (`systemd-run`), Docker and
 * its kin. A read-only mount does not stop a connect, and a network namespace does not hold a socket of the disk.
 */
const HOST_SOCKETS = [
  "/run/dbus/system_bus_socket",
  "/var/run/dbus/system_bus_socket",
  "/run/docker.sock",
  "/var/run/docker.sock",
  "/run/containerd/containerd.sock",
  "/run/podman/podman.sock",
  "/run/snapd.socket",
];

/** The runtime folder of the user: its bus runs `systemd-run --user`, and the SSH, GnuPG and Podman agents listen there. */
function runtimeDirs(): string[] {
  const uid = process.getuid?.();
  return [
    ...new Set([process.env.XDG_RUNTIME_DIR, uid === undefined ? undefined : `/run/user/${uid}`]),
  ].filter((path): path is string => path !== undefined && path !== "");
}

/** The real paths of those that exist, once each: `/var/run` is most often a link to `/run`. */
const existing = (paths: string[]): string[] => [
  ...new Set(paths.filter((path) => existsSync(path)).map((path) => realpathSync(path))),
];

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
  /** The proxy of `allowedDomains` once it runs: a Unix socket on Linux, a port on macOS. */
  private proxy?: { socket?: string; port?: number };

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

  /** The hosts of `allowedDomains` when they limit the network: `allowNetwork` gives all of it. */
  private domains(): string[] | undefined {
    return this.allowNetwork ? undefined : this.options.allowedDomains;
  }

  /** Starts the proxy of `allowedDomains`, one time. Before it runs, a command has no network at all. */
  async startNetworkProxy(): Promise<void> {
    const domains = this.domains();
    if (domains === undefined || this.proxy !== undefined) return;
    if (this.platform === "linux") {
      // bubblewrap binds the socket into the sandbox: its own network has no route to a port of the host.
      const socket = join(mkdtempSync(join(tmpdir(), "agency-net-")), "proxy.sock");
      await startDomainProxy(domains, { path: socket });
      this.proxy = { socket };
    } else {
      const { port } = await startDomainProxy(domains, { host: "127.0.0.1", port: 0 });
      this.proxy = { port };
    }
  }

  /** The argv that runs `argv` in the sandbox. */
  wrap(argv: string[], cwd: string = this.root): string[] {
    if (this.platform === "linux") {
      return [
        ...buildBwrapArgs(
          this.root,
          cwd,
          this.allowNetwork,
          this.options.bwrapBin,
          [...this.hidden(), ...existing(runtimeDirs())],
          this.proxy?.socket,
          existing(HOST_SOCKETS),
        ),
        ...argv,
      ];
    }
    if (this.platform === "darwin") {
      const port = this.proxy?.port;
      const profile = buildSeatbeltProfile(
        this.root,
        this.allowNetwork,
        process.env.TMPDIR ?? "/private/tmp",
        this.hidden(),
        port,
      );
      const env =
        port === undefined
          ? []
          : [
              "/usr/bin/env",
              ...proxyEnv(`http://127.0.0.1:${port}`).map(([name, value]) => `${name}=${value}`),
            ];
      return [this.options.seatbeltBin ?? "/usr/bin/sandbox-exec", "-p", profile, ...env, ...argv];
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
    if (!["linux", "darwin", "win32"].includes(this.platform)) return false;
    if (this.platform === "win32" && this.windowsRefusal() !== undefined) return false;
    if (this.platform === "linux" && this.domains() !== undefined && !Bun.which("socat")) return false;
    try {
      // A `.agency` that a command makes would not be read-only: the rules apply to the paths that exist.
      mkdirSync(join(this.root, ".agency"), { recursive: true });
      // The probe below then also starts socat in the sandbox.
      if (this.platform !== "win32") await this.startNetworkProxy();
      // Here the folders get the rules of the SID, one time for each daemon start.
      if (this.platform === "win32" && !(await prepareWindowsSandbox(this.root, this.sid))) return false;
      const probe = this.platform === "win32" ? ["cmd.exe", "/d", "/c", "exit 0"] : ["true"];
      const child = Bun.spawn(this.wrap(probe), { windowsHide: true, stdout: "ignore", stderr: "ignore" });
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
    if (this.domains() !== undefined) {
      return 'sandbox.backend is "os", but on Windows a command cannot be limited to sandbox.allowedDomains without administrator rights. Remove sandbox.allowedDomains and set sandbox.allowNetwork to true to accept that, or set sandbox.backend to "software".';
    }
    if (!this.allowNetwork) {
      return 'sandbox.backend is "os", but on Windows a command cannot be kept off the network without administrator rights. Set sandbox.allowNetwork to true to accept that, or set sandbox.backend to "software".';
    }
    return undefined;
  }

  unavailableReason(): string {
    if (this.platform === "linux" && this.domains() !== undefined && !Bun.which("socat")) {
      return "sandbox.allowedDomains needs socat, which relays the proxy into the sandbox. Install it (`apt install socat`), or remove sandbox.allowedDomains.";
    }
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
    // bubblewrap and the rules of Windows hold only the protected paths that exist: one that a command makes is
    // removed after it, or its hooks or MCP servers would run outside the sandbox at the next start. Seatbelt
    // refuses it already. ponytail: a background command is not swept; sweep at its end if one is seen to do this.
    const absent =
      this.platform === "darwin"
        ? []
        : PROTECTED_PATHS.readOnly.filter((path) => !existsSync(join(this.root, path)));
    const sweep = (): string[] => {
      const made = absent.filter((path) => existsSync(join(this.root, path)));
      for (const path of made) rmSync(join(this.root, path), { recursive: true, force: true });
      return made;
    };
    const child = Bun.spawn(this.wrap(argv, opts.cwd), {
      windowsHide: true,
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
      const [stdout, output, exitCode] = await Promise.all([stdoutText, stderrText, child.exited]);
      const made = sweep();
      const stderr =
        made.length === 0
          ? output
          : `${output}${output && !output.endsWith("\n") ? "\n" : ""}agency sandbox: removed ${made.join(", ")}, which this command made: a command may not make files whose hooks or servers run outside the sandbox. Edit such a file with the edit or write tool, which asks the user.\n`;
      if (timedOut) {
        throw new AgencyError(ErrorCode.INTERNAL, "sandboxed command timed out", {
          source: "sandbox-os",
          context: { argv, timedOut: true, stdout, stderr },
        });
      }
      return { stdout, stderr, exitCode };
    } finally {
      sweep();
      opts.signal?.removeEventListener("abort", kill);
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

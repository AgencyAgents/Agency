import { realpathSync } from "node:fs";
import { AgencyError, ErrorCode } from "@agency/schema";
import type { RequestApproval } from "./approval.ts";
import {
  type CommandPolicy,
  type ExternalDirectoryDecision,
  type SandboxBackend,
  SandboxBoundary,
} from "./sandbox.ts";

export interface OsSandboxOptions {
  /** Commands get the network. Default: no network. */
  allowNetwork?: boolean;
  /** For tests: the platform, and the programs. */
  platform?: NodeJS.Platform;
  bwrapBin?: string;
  seatbeltBin?: string;
}

/**
 * bubblewrap argv: the whole disk read-only, the workspace and a private /tmp writable, no network.
 * `.git/hooks` stays read-only: a hook that a command writes would run later outside the sandbox.
 */
export function buildBwrapArgs(root: string, cwd: string, allowNetwork: boolean, bin = "bwrap"): string[] {
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
    "--bind",
    root,
    root,
    "--ro-bind-try",
    `${root}/.git/hooks`,
    `${root}/.git/hooks`,
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
export function buildSeatbeltProfile(root: string, allowNetwork: boolean, tmpDir = "/private/tmp"): string {
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* (subpath ${quote(root)}) (subpath ${quote(tmpDir)}) (subpath "/private/tmp") (subpath "/private/var/folders") (literal "/dev/null") (regex #"^/dev/tty"))`,
    `(deny file-write* (subpath ${quote(`${root}/.git/hooks`)}))`,
    ...(allowNetwork ? [] : ["(deny network*)"]),
  ].join("\n");
}

/**
 * Runs each shell command in a sandbox of the operating system: bubblewrap on Linux, Seatbelt on macOS.
 * Paths and permission rules are those of the software boundary. There is no backend for Windows.
 */
export class OsSandboxBackend implements SandboxBackend {
  private readonly local: SandboxBoundary;
  private readonly root: string;
  private readonly platform: NodeJS.Platform;
  private readonly allowNetwork: boolean;

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
      return [...buildBwrapArgs(this.root, cwd, this.allowNetwork, this.options.bwrapBin), ...argv];
    }
    if (this.platform === "darwin") {
      const profile = buildSeatbeltProfile(
        this.root,
        this.allowNetwork,
        process.env.TMPDIR ?? "/private/tmp",
      );
      return [this.options.seatbeltBin ?? "/usr/bin/sandbox-exec", "-p", profile, ...argv];
    }
    throw new AgencyError(ErrorCode.INTERNAL, `sandbox.backend "os" has no backend for ${this.platform}`, {
      source: "sandbox-os",
    });
  }

  /** True when the sandbox program of this platform starts a command. */
  async isAvailable(): Promise<boolean> {
    if (this.platform !== "linux" && this.platform !== "darwin") return false;
    try {
      const probe = Bun.spawn(this.wrap(["true"]), { stdout: "ignore", stderr: "ignore" });
      return (await probe.exited) === 0;
    } catch {
      return false;
    }
  }

  unavailableReason(): string {
    if (this.platform === "linux") {
      return 'sandbox.backend is "os" but bubblewrap did not start a command. Install it (`apt install bubblewrap`) and allow user namespaces, or set sandbox.backend to "software".';
    }
    if (this.platform === "darwin") {
      return 'sandbox.backend is "os" but /usr/bin/sandbox-exec did not start a command. Set sandbox.backend to "software".';
    }
    return `sandbox.backend "os" works on Linux and macOS only, and this is ${this.platform}. Set sandbox.backend to "software".`;
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

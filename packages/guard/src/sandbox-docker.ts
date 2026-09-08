import { spawnSync } from "node:child_process";
import { relative, resolve, sep } from "node:path";
import { AgencyError, ErrorCode } from "@agency/schema";
import type { RequestApproval } from "./approval.ts";
import { SandboxBoundary } from "./sandbox.ts";
import type { CommandPolicy, ExternalDirectoryDecision, SandboxBackend } from "./sandbox.ts";

/** Container path the workspace root mounts at (POSIX inside the container). */
export const DEFAULT_CONTAINER_ROOT = "/workspace";

/** `docker info` reachability probe budget; keeps suites fast when no daemon exists. */
export const DOCKER_PROBE_TIMEOUT_MS = 5_000;

/**
 * Known-good Linux capability names (canonical, no `CAP_` prefix) accepted
 * for `--cap-drop`. Sourced from `capabilities(7)`; anything outside this
 * set fails closed at backend construction instead of reaching the CLI.
 */
export const LINUX_CAPABILITIES: ReadonlySet<string> = new Set([
  "CHOWN",
  "DAC_OVERRIDE",
  "DAC_READ_SEARCH",
  "FOWNER",
  "FSETID",
  "KILL",
  "SETGID",
  "SETUID",
  "SETPCAP",
  "LINUX_IMMUTABLE",
  "NET_BIND_SERVICE",
  "NET_ADMIN",
  "NET_RAW",
  "IPC_LOCK",
  "IPC_OWNER",
  "SYS_MODULE",
  "SYS_RAWIO",
  "SYS_CHROOT",
  "SYS_PTRACE",
  "SYS_PACCT",
  "SYS_ADMIN",
  "SYS_BOOT",
  "SYS_NICE",
  "SYS_RESOURCE",
  "SYS_TIME",
  "SYS_TTY_CONFIG",
  "MKNOD",
  "LEASE",
  "AUDIT_WRITE",
  "AUDIT_CONTROL",
  "SETFCAP",
  "MAC_OVERRIDE",
  "MAC_ADMIN",
  "SYSLOG",
  "WAKE_ALARM",
  "BLOCK_SUSPEND",
  "AUDIT_READ",
]);

/** Canonicalizes a user-supplied capability (`cap_net_raw` -> `NET_RAW`). */
function canonicalCapName(raw: string): string {
  const upper = raw.trim().toUpperCase();
  return upper.startsWith("CAP_") ? upper.slice(4) : upper;
}

/**
 * Builds `--cap-drop` flags, rejecting unknown names with a typed error.
 * Empty/undefined yields no flags (Docker defaults apply).
 */
export function buildCapDropArgs(caps: readonly string[] | undefined): string[] {
  if (caps === undefined || caps.length === 0) return [];
  const flags: string[] = [];
  for (const raw of caps) {
    const name = canonicalCapName(raw);
    if (!LINUX_CAPABILITIES.has(name)) {
      throw new AgencyError(ErrorCode.INTERNAL, `unknown Linux capability "${raw}" in sandbox.capDrop`, {
        source: "sandbox-docker",
        context: { capability: raw },
      });
    }
    flags.push("--cap-drop", name);
  }
  return flags;
}

/**
 * Builds the network gate for one-shot `docker run`.
 * Egress is deny-by-default once configured: a defined allowlist (even
 * empty) isolates the container (`--network=none`) unless `network` names
 * an explicit network. Undefined egress preserves current behavior (no
 * flag). Per-hostname enforcement is NOT expressible in `docker run` flags,
 * so the allowlist itself is enforced at tool-policy level (`requireNetwork`
 * over capabilities); this flag is the coarse container-level lock.
 */
export function buildNetworkArgs(egress: readonly string[] | undefined, network: string | undefined): string[] {
  if (network !== undefined) return ["--network", network];
  if (egress !== undefined) return ["--network", "none"];
  return [];
}

/** Options for the container backend; all optional so construction stays trivial. */
export interface DockerSandboxOptions {
  /** Image for one-shot `docker run` exec. Defaults to `AGENCY_DOCKER_TEST_IMAGE` or alpine. */
  image?: string;
  /** Existing container for `docker exec`; when unset, exec uses `docker run --rm`. */
  container?: string;
  /** Container-side mount point. Defaults to /workspace. */
  containerRoot?: string;
  /** Docker CLI binary. Defaults to `AGENCY_DOCKER_BIN` or docker. */
  dockerBin?: string;
  /** Egress hostname allowlist; defined (even empty) means deny-by-default. */
  egress?: string[];
  /** Named Docker network for one-shot runs; wins over the egress default. */
  network?: string;
  /** Linux capabilities to drop; unknown names fail construction. */
  capDrop?: string[];
  /** Probe timeout in ms. Defaults to DOCKER_PROBE_TIMEOUT_MS. */
  probeTimeoutMs?: number;
}

/** Normalizes a container mount point: absolute POSIX, no trailing slash. */
export function normalizeContainerRoot(root: string): string {
  let out = root.replace(/\\/g, "/");
  if (!out.startsWith("/")) out = `/${out}`;
  out = out.replace(/\/+/g, "/");
  if (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

/** Host-side prefix compare honoring Windows case-insensitivity (no fs access). */
function hostStartsWith(resolved: string, root: string): boolean {
  if (process.platform === "win32") {
    const a = resolved.replace(/\//g, "\\").toLowerCase();
    const b = root.replace(/\//g, "\\").toLowerCase();
    return a === b || a.startsWith(`${b}\\`);
  }
  return resolved === root || resolved.startsWith(`${root}/`);
}

/**
 * Maps an already-resolved host path to its container path.
 * Throws PERMISSION_DENIED when the path is not under the host root.
 */
export function translateHostToMount(resolvedHostPath: string, hostRoot: string, containerRoot: string): string {
  if (!hostStartsWith(resolvedHostPath, hostRoot)) {
    throw new AgencyError(ErrorCode.PERMISSION_DENIED, `"${resolvedHostPath}" is outside the mounted root`, {
      source: "sandbox-docker",
      context: { path: resolvedHostPath, root: hostRoot },
    });
  }
  const rel = relative(hostRoot, resolvedHostPath);
  const mount = normalizeContainerRoot(containerRoot);
  if (rel === "") return mount;
  return `${mount}/${rel.split(sep).join("/")}`;
}

/**
 * Maps a container-absolute path back to its host path.
 * Throws PERMISSION_DENIED when the path escapes the container mount.
 */
export function translateMountToHost(containerPath: string, hostRoot: string, containerRoot: string): string {
  const posix = containerPath.replace(/\\/g, "/");
  const mount = normalizeContainerRoot(containerRoot);
  const under = posix === mount || posix.startsWith(`${mount}/`);
  if (!under) {
    throw new AgencyError(ErrorCode.PERMISSION_DENIED, `"${containerPath}" is outside the container mount`, {
      source: "sandbox-docker",
      context: { path: containerPath, mount },
    });
  }
  const rel = posix === mount ? "" : posix.slice(mount.length + 1);
  const parts = rel.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.includes("..")) {
    throw new AgencyError(ErrorCode.PERMISSION_DENIED, `"${containerPath}" escapes the container mount`, {
      source: "sandbox-docker",
      context: { path: containerPath, mount },
    });
  }
  return rel === "" || parts.length === 0 ? resolve(hostRoot) : resolve(hostRoot, ...parts);
}

/** Builds `-v host:container` args; the host root is passed verbatim for Docker. */
export function buildVolumeArgs(hostRoot: string, containerRoot: string): string[] {
  return ["-v", `${resolve(hostRoot)}:${normalizeContainerRoot(containerRoot)}`];
}

/** True when a Docker daemon answers `docker info` within the timeout. */
export async function isDockerAvailable(dockerBin?: string, timeoutMs: number = DOCKER_PROBE_TIMEOUT_MS): Promise<boolean> {
  const bin = dockerBin ?? process.env["AGENCY_DOCKER_BIN"] ?? "docker";
  try {
    const child = Bun.spawn([bin, "info", "--format", "{{.ServerVersion}}"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => {
      try {
        child.kill(9);
      } catch {
        // Already exited; the await below settles.
      }
    }, timeoutMs);
    try {
      const code = await child.exited;
      return code === 0;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

/** True when the image exists locally (no pull); keeps integration tests offline. */
export function hasLocalImage(image: string, dockerBin?: string): boolean {
  const bin = dockerBin ?? process.env["AGENCY_DOCKER_BIN"] ?? "docker";
  try {
    const out = spawnSync(bin, ["image", "inspect", image], { stdio: "ignore", timeout: DOCKER_PROBE_TIMEOUT_MS });
    return out.status === 0;
  } catch {
    return false;
  }
}

/**
 * Docker container backend: policy decisions delegate to a local boundary
 * (same realpath + 8.3 containment holds on the host before any mapping),
 * while exec runs across the volume mount. Construction is side-effect free:
 * no container is created and no daemon is contacted until exec/probe runs.
 */
export class DockerSandboxBackend implements SandboxBackend {
  readonly containerRoot: string;
  private readonly local: SandboxBoundary;
  private readonly image: string;
  private readonly container: string | undefined;
  private readonly dockerBin: string;
  private readonly networkFlags: string[];
  private readonly capFlags: string[];
  private readonly probeTimeoutMs: number;

  constructor(
    private readonly root: string,
    commandPolicy: CommandPolicy = {},
    externalDecision: ExternalDirectoryDecision | undefined = undefined,
    options: DockerSandboxOptions = {},
  ) {
    this.local = new SandboxBoundary(root, commandPolicy, externalDecision);
    this.containerRoot = normalizeContainerRoot(options.containerRoot ?? DEFAULT_CONTAINER_ROOT);
    this.image = options.image ?? process.env["AGENCY_DOCKER_TEST_IMAGE"] ?? "alpine";
    this.container = options.container;
    this.dockerBin = options.dockerBin ?? process.env["AGENCY_DOCKER_BIN"] ?? "docker";
    this.networkFlags = buildNetworkArgs(options.egress, options.network);
    this.capFlags = buildCapDropArgs(options.capDrop);
    this.probeTimeoutMs = options.probeTimeoutMs ?? DOCKER_PROBE_TIMEOUT_MS;
  }

  /** Resolves on the host; identical verdicts to the local backend. */
  resolvePath(candidate: string): string {
    return this.local.resolvePath(candidate);
  }

  /** Gated resolve; identical verdicts to the local backend. */
  resolvePathGated(candidate: string, opts: { tool: string; ask?: RequestApproval }): Promise<string> {
    return this.local.resolvePathGated(candidate, opts);
  }

  /** Policy check; identical verdicts to the local backend. */
  checkCommand(command: string): void {
    this.local.checkCommand(command);
  }

  /** Resolves `candidate` on the host, then maps it into the container mount. */
  toContainerPath(candidate: string): string {
    const resolved = this.resolvePath(candidate);
    return translateHostToMount(resolved, resolve(this.root), this.containerRoot);
  }

  /** Maps a container-absolute path back to its host path. */
  toHostPath(containerPath: string): string {
    return translateMountToHost(containerPath, resolve(this.root), this.containerRoot);
  }

  /** Volume args binding this backend's root into the container. */
  volumeArgs(): string[] {
    return buildVolumeArgs(this.root, this.containerRoot);
  }

  /** Docker CLI argv for a container run; `-i` keeps stdio attached for streamed children. */
  private runArgs(argv: string[], workdir: string, interactive: boolean, env?: Record<string, string>): string[] {
    const envFlags = interactive ? Object.entries(env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]) : [];
    // Pinned-container `docker exec` cannot set network or capabilities: the
    // container's network/caps are fixed at creation, so the knobs apply to
    // one-shot `docker run` only (documented in configuration.md).
    return this.container
      ? [this.dockerBin, "exec", ...(interactive ? ["-i"] : []), ...envFlags, "-w", workdir, this.container, ...argv]
      : [
          this.dockerBin,
          "run",
          "--rm",
          ...(interactive ? ["-i"] : []),
          ...envFlags,
          ...this.networkFlags,
          ...this.capFlags,
          ...this.volumeArgs(),
          "-w",
          workdir,
          this.image,
          ...argv,
        ];
  }

  /** Lazily probes daemon reachability; never called from the constructor. */
  isAvailable(): Promise<boolean> {
    return isDockerAvailable(this.dockerBin, this.probeTimeoutMs);
  }

  /**
   * Runs `argv` in the container with the workspace mounted.
   * Uses `docker exec` for a pinned container, else one-shot `docker run`.
   */
  async exec(
    argv: string[],
    opts: { cwd?: string; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    this.checkCommand(argv.join(" "));
    const workdir = opts.cwd ? this.toContainerPath(opts.cwd) : this.containerRoot;
    const args = this.runArgs(argv, workdir, false);
    const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const stdoutText = new Response(child.stdout).text();
    const stderrText = new Response(child.stderr).text();
    const killCli = (): void => {
      try {
        child.kill(9);
      } catch {
        // Already exited; reads below still settle.
      }
    };
    let timedOut = false;
    const onAbort = (): void => {
      killCli();
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort);
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killCli();
      }, opts.timeoutMs);
    }
    try {
      const [stdout, stderr, exitCode] = await Promise.all([stdoutText, stderrText, child.exited]);
      if (timedOut) {
        throw new AgencyError(ErrorCode.INTERNAL, `container exec timed out`, {
          source: "sandbox-docker",
          context: { argv, timedOut: true, stdout, stderr },
        });
      }
      // Abort kills the docker CLI child above; the caller coerces the
      // settled output to [cancelled] via its own signal listener.
      return { stdout, stderr, exitCode };
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Spawns a long-lived process with piped stdio for MCP servers. Same
   * containment as exec (policy gate, then host resolve before the mount
   * map); kill() stops the docker CLI child, which ends an attached
   * `run --rm` with it. Server env rides `-e` flags into the container.
   */
  async spawnStdio(
    argv: string[],
    opts: { cwd?: string; env?: Record<string, string> } = {},
  ): Promise<{ stdin: unknown; stdout: unknown; stderr: unknown; exited: Promise<number>; pid?: number; kill(): void }> {    this.checkCommand(argv.join(" "));
    const workdir = opts.cwd ? this.toContainerPath(opts.cwd) : this.containerRoot;
    const child = Bun.spawn(this.runArgs(argv, workdir, true, opts.env), {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      exited: child.exited,
      pid: child.pid,
      kill: () => {
        try {
          child.kill(9);
        } catch {
          // Already exited; the exited promise still settles.
        }
      },
    };
  }
}

/**
 * Fail-closed Docker gate for daemon boot: when the backend offers an
 * availability probe (i.e. it is container-backed), an unreachable daemon
 * throws a typed error naming the remediation instead of silently falling
 * back to software. Backends without a probe (software) resolve untouched.
 * Capability-checked (`in` guard) so non-container backends never pay for,
 * or risk, a probe.
 */
export async function ensureSandboxAvailable(backend: SandboxBackend): Promise<void> {
  const candidate = backend as Partial<Record<"isAvailable", unknown>>;
  const probe = candidate.isAvailable;
  if (typeof probe !== "function") return;
  const reachable = await (probe as () => Promise<boolean>).call(backend);
  if (reachable) return;
  throw new AgencyError(
    ErrorCode.INTERNAL,
    "sandbox.backend is \"docker\" but no Docker daemon is reachable (`docker info` failed). " +
      "Start the Docker daemon, or set sandbox.backend to \"software\" (AGENCY_SANDBOX_BACKEND=software).",
    { source: "sandbox-docker" },
  );
}

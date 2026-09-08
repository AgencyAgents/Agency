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
    opts: { cwd?: string; timeoutMs?: number } = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    this.checkCommand(argv.join(" "));
    const workdir = opts.cwd ? this.toContainerPath(opts.cwd) : this.containerRoot;
    const args = this.container
      ? [this.dockerBin, "exec", "-w", workdir, this.container, ...argv]
      : [this.dockerBin, "run", "--rm", ...this.volumeArgs(), "-w", workdir, this.image, ...argv];
    const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const stdoutText = new Response(child.stdout).text();
    const stderrText = new Response(child.stderr).text();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill(9);
        } catch {
          // Already exited; reads below still settle.
        }
      }, opts.timeoutMs);
    }
    try {
      const [stdout, stderr, exitCode] = await Promise.all([stdoutText, stderrText, child.exited]);
      if (timedOut) {
        throw new AgencyError(ErrorCode.INTERNAL, `container exec timed out`, {
          source: "sandbox-docker",
          context: { argv },
        });
      }
      return { stdout, stderr, exitCode };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

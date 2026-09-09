import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SandboxBackend } from "@agency/guard";
import {
  DockerSandboxBackend,
  FULL_CAPABILITIES,
  hasLocalImage,
  isDockerAvailable,
  SandboxBoundary,
  translateHostToMount,
  translateMountToHost,
} from "@agency/guard";
import { AgencyError, ErrorCode } from "@agency/schema";
import { type BashState, createBashTool } from "../src/builtins/bash.ts";
import { createWriteTool } from "../src/builtins/write.ts";
import {
  asContainerExecBackend,
  type ContainerExecOptions,
  type ContainerExecResult,
} from "../src/container-exec.ts";
import type { ToolDeps } from "../src/contract.ts";
import { ProcessManager } from "../src/process-manager.ts";
import { CWD_MARKER, resolveShell } from "../src/shell.ts";
import { SnapshotStore } from "../src/snapshot.ts";

// Bash container routing (wave1-todo4). A fake exec backend stands in for the
// Docker daemon: it runs the argv locally like the software path but records
// routing (argv, host cwd, timeout, signal), translates cwd through the real
// mount helpers, rewrites the cwd marker to container form so the branch
// translates it back, and kills its child on abort/timeout like exec does.
interface FakeExecCall {
  argv: string[];
  cwd: string | undefined;
  timeoutMs: number | undefined;
  hadSignal: boolean;
}

class FakeContainerBackend extends SandboxBoundary {
  readonly containerRoot = "/workspace";
  readonly calls: FakeExecCall[] = [];
  readonly translatedCwds: string[] = [];
  readonly kills: string[] = [];
  private readonly children: Array<{ kill: (code?: number) => void }> = [];
  private readonly hostRoot: string;

  constructor(root: string, commandPolicy?: ConstructorParameters<typeof SandboxBoundary>[1]) {
    super(root, commandPolicy);
    this.hostRoot = resolve(root);
  }

  toContainerPath(candidate: string): string {
    return translateHostToMount(this.resolvePath(candidate), this.hostRoot, this.containerRoot);
  }

  toHostPath(containerPath: string): string {
    return translateMountToHost(containerPath, this.hostRoot, this.containerRoot);
  }

  async exec(argv: string[], opts: ContainerExecOptions = {}): Promise<ContainerExecResult> {
    this.checkCommand(argv.join(" "));
    const workdir = opts.cwd ? this.toContainerPath(opts.cwd) : this.containerRoot;
    this.translatedCwds.push(workdir);
    this.calls.push({ argv, cwd: opts.cwd, timeoutMs: opts.timeoutMs, hadSignal: opts.signal !== undefined });
    const child = Bun.spawn(argv, {
      cwd: opts.cwd ? this.resolvePath(opts.cwd) : this.hostRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    this.children.push(child);
    const stdoutText = new Response(child.stdout).text();
    const stderrText = new Response(child.stderr).text();
    const killChild = (reason: string): void => {
      this.kills.push(reason);
      try {
        child.kill(9);
      } catch {
        // Already exited; reads below still settle.
      }
    };
    let timedOut = false;
    const onAbort = (): void => {
      killChild("abort");
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort);
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killChild("timeout");
      }, opts.timeoutMs);
    }
    try {
      const [stdout, stderr, exitCode] = await Promise.all([stdoutText, stderrText, child.exited]);
      if (timedOut) {
        throw new AgencyError(ErrorCode.INTERNAL, "container exec timed out", {
          source: "fake-container-backend",
          context: { argv, timedOut: true, stdout, stderr },
        });
      }
      return {
        stdout: toContainerMarkers(stdout, (printed) => this.toContainerPath(printed)),
        stderr,
        exitCode,
      };
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  killAll(): void {
    for (const child of this.children.splice(0)) {
      try {
        child.kill(9);
      } catch {
        // Already exited.
      }
    }
  }
}

// A real container prints mount paths in its cwd marker; the fake runs
// locally, so its host marker line is rewritten to container form. The bash
// branch must translate it back via toHostPath for cwd to persist.
function toContainerMarkers(stdout: string, translate: (hostPath: string) => string): string {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line?.startsWith(CWD_MARKER) ?? false) {
      const printed = line.slice(CWD_MARKER.length).replace(/\r$/, "");
      if (printed !== "") {
        try {
          lines[i] = `${CWD_MARKER}${translate(printed)}`;
        } catch {
          // Untranslatable (escaped) marker stays host-side; the branch denies it.
        }
      }
      break;
    }
  }
  return lines.join("\n");
}

const dirs: string[] = [];
const managers: ProcessManager[] = [];
const fakes: FakeContainerBackend[] = [];
afterEach(async () => {
  for (const f of fakes.splice(0)) f.killAll();
  for (const m of managers.splice(0)) m.killAll();
  await new Promise((r) => setTimeout(r, 100));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

function setupContainer(commandPolicy?: ConstructorParameters<typeof SandboxBoundary>[1]) {
  const root = mkdtempSync(join(tmpdir(), "agency-container-exec-"));
  dirs.push(root);
  const backend = new FakeContainerBackend(root, commandPolicy);
  fakes.push(backend);
  const deps: ToolDeps = {
    identity: { type: "user" },
    capabilities: { ...FULL_CAPABILITIES, pathScopes: [root] },
    sandbox: backend,
  };
  const state: BashState = { cwd: root };
  const manager = new ProcessManager();
  managers.push(manager);
  const tool = createBashTool(deps, resolveShell(process.platform), state, manager);
  return { tool, state, root, backend };
}

function setupSoftware(commandPolicy?: ConstructorParameters<typeof SandboxBoundary>[1]) {
  const root = mkdtempSync(join(tmpdir(), "agency-container-exec-"));
  dirs.push(root);
  const deps: ToolDeps = {
    identity: { type: "user" },
    capabilities: { ...FULL_CAPABILITIES, pathScopes: [root] },
    sandbox: new SandboxBoundary(root, commandPolicy),
  };
  const state: BashState = { cwd: root };
  const manager = new ProcessManager();
  managers.push(manager);
  const tool = createBashTool(deps, resolveShell(process.platform), state, manager);
  return { tool, state, root };
}

const signal = new AbortController().signal;
const pwdCommand = process.platform === "win32" ? "(Get-Location).Path" : "pwd";

describe("container-exec branch selection", () => {
  test("software backend takes the local branch, exec backend takes the container branch", async () => {
    const root = mkdtempSync(join(tmpdir(), "agency-container-exec-"));
    dirs.push(root);
    expect(asContainerExecBackend(new SandboxBoundary(root))).toBeUndefined();
    const backend = new FakeContainerBackend(root);
    fakes.push(backend);
    expect(asContainerExecBackend(backend)).not.toBeUndefined();
    const impostor = new SandboxBoundary(root) as unknown as Record<string, unknown>;
    impostor.exec = 42;
    expect(asContainerExecBackend(impostor as unknown as SandboxBackend)).toBeUndefined();
  });

  test("software branch runs locally with markers stripped", async () => {
    const { tool } = setupSoftware();
    const result = await tool.handler({ command: "echo hello-software-path" }, { signal });
    expect(result.content).toContain("hello-software-path");
    expect(result.content).not.toContain("__AGENCY_");
    expect(result.isError).toBeFalsy();
  }, 30_000);
});

describe("container-exec routing and cwd", () => {
  test("exec receives the shell argv with the host cwd and signal", async () => {
    const { tool, root, backend } = setupContainer();
    const result = await tool.handler({ command: "echo hello-container-branch" }, { signal });
    expect(result.content).toContain("hello-container-branch");
    expect(result.content).not.toContain("__AGENCY_");
    expect(backend.calls.length).toBe(1);
    expect(backend.calls[0]?.argv[0]).toBe(resolveShell(process.platform).command);
    expect(backend.calls[0]?.argv.join(" ")).toContain("echo hello-container-branch");
    expect(backend.calls[0]?.cwd).toBe(root);
    expect(backend.calls[0]?.hadSignal).toBe(true);
    expect(backend.calls[0]?.timeoutMs).toBeUndefined();
    expect(backend.translatedCwds).toEqual(["/workspace"]);
  }, 30_000);

  test("cwd persists across calls through container marker translation", async () => {
    const { tool, state, backend } = setupContainer();
    mkdirSync(join(state.cwd, "sub"));
    await tool.handler({ command: "cd sub" }, { signal });
    expect(state.cwd.toLowerCase()).toContain("sub");
    const result = await tool.handler({ command: pwdCommand }, { signal });
    expect(result.content.toLowerCase()).toContain("sub");
    expect(backend.translatedCwds[backend.translatedCwds.length - 1]).toBe("/workspace/sub");
  }, 30_000);

  test("checkCommand gates before exec on the container branch", async () => {
    const { tool, backend } = setupContainer({ deny: [/rm -rf/] });
    const err = await tool.handler({ command: "rm -rf /" }, { signal }).catch((e) => e);
    expect(err).toBeInstanceOf(AgencyError);
    expect((err as AgencyError).code).toBe(ErrorCode.PERMISSION_DENIED);
    expect(backend.calls.length).toBe(0);
  });

  test("empty command runs the marker wrapper without hanging", async () => {
    const { tool, backend } = setupContainer();
    const result = await tool.handler({ command: "" }, { signal });
    expect(result.content).not.toContain("__AGENCY_");
    expect(result.isError).toBeFalsy();
    expect(backend.calls.length).toBe(1);
  }, 30_000);

  test("long container commands emit progress", async () => {
    const { tool } = setupContainer();
    const messages: string[] = [];
    const command = process.platform === "win32" ? "Start-Sleep -Seconds 5" : "sleep 5";
    await tool.handler({ command }, { signal, onProgress: (m) => messages.push(m) });
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0]).toContain("still running");
  }, 30_000);
});

describe("container-exec abort and timeout", () => {
  test("abort kills the exec, keeps partial output, labels cancelled", async () => {
    const { tool, root, backend } = setupContainer();
    const controller = new AbortController();
    const inner = controller.signal;
    let added = 0;
    let removed = 0;
    const counting = new Proxy(inner, {
      get(target, prop, _receiver) {
        if (prop === "addEventListener") {
          return (...args: Parameters<AbortSignal["addEventListener"]>) => {
            added += 1;
            return target.addEventListener(...args);
          };
        }
        if (prop === "removeEventListener") {
          return (...args: Parameters<AbortSignal["removeEventListener"]>) => {
            removed += 1;
            return target.removeEventListener(...args);
          };
        }
        return Reflect.get(target, prop, target);
      },
    }) as AbortSignal;
    const markerPath = join(root, "abort-flushed.marker");
    const command =
      process.platform === "win32"
        ? `Write-Output 'partial-output-before-abort'; Set-Content -LiteralPath '${markerPath.replace(/\\/g, "/")}' -Value done; Start-Sleep -Seconds 30`
        : `echo partial-output-before-abort; touch '${markerPath}'; sleep 30`;
    const resultPromise = tool.handler({ command }, { signal: counting });
    const deadline = Date.now() + 20_000;
    while (!existsSync(markerPath)) {
      if (Date.now() > deadline) throw new Error("marker file never appeared");
      await new Promise((r) => setTimeout(r, 50));
    }
    controller.abort();
    const result = await resultPromise;
    expect(result.content).toContain("partial-output-before-abort");
    expect(result.content).toContain("[cancelled");
    expect(result.content).not.toContain("exit code: 0");
    expect(result.isError).toBe(true);
    expect(backend.kills).toContain("abort");
    expect(added).toBeGreaterThan(0);
    expect(added).toBe(removed);
  }, 60_000);

  test("timeout kills the exec and reports a typed error with partial output", async () => {
    const { tool, backend } = setupContainer();
    const command =
      process.platform === "win32"
        ? `Write-Output 'partial-output-before-timeout'; Start-Sleep -Seconds 30`
        : `echo partial-output-before-timeout; sleep 30`;
    const result = await tool.handler({ command, timeout: 5_000 }, { signal });
    expect(result.content).toContain("partial-output-before-timeout");
    expect(result.content).toContain("[timeout");
    expect(result.content).toContain("5000ms");
    expect(result.isError).toBe(true);
    expect(backend.kills).toContain("timeout");
  }, 60_000);

  test("untranslatable cwd denies before the run", async () => {
    const { tool, state, backend } = setupContainer();
    state.cwd = join(state.cwd, "..", "outside-container-exec");
    const err = await tool.handler({ command: "echo never-runs" }, { signal }).catch((e) => e);
    expect(err).toBeInstanceOf(AgencyError);
    expect((err as AgencyError).code).toBe(ErrorCode.PERMISSION_DENIED);
    expect(backend.calls.length).toBe(0);
  });
});

describe("file tools stay on host paths under a container backend", () => {
  test("write lands on the host where snapshots capture it", async () => {
    const root = mkdtempSync(join(tmpdir(), "agency-container-exec-"));
    dirs.push(root);
    const backend = new DockerSandboxBackend(root);
    expect(asContainerExecBackend(backend)).not.toBeUndefined();
    const deps: ToolDeps = {
      identity: { type: "user" },
      capabilities: { ...FULL_CAPABILITIES, pathScopes: [root] },
      sandbox: backend,
    };
    const snapshotDir = mkdtempSync(join(tmpdir(), "agency-container-snap-"));
    dirs.push(snapshotDir);
    const snapshots = new SnapshotStore(snapshotDir);
    const write = createWriteTool(deps, snapshots, {});
    const target = join(root, "mounted.txt");
    writeFileSync(target, "before\n");

    const result = await write.handler({ path: target, content: "after\n" }, { signal, turnId: "t1" });
    expect(result.isError).toBeFalsy();
    expect(readFileSync(target, "utf8")).toBe("after\n");

    expect(snapshots.undo()).toBeDefined();
    expect(readFileSync(target, "utf8")).toBe("before\n");
    expect(snapshots.redo()).toBeDefined();
    expect(readFileSync(target, "utf8")).toBe("after\n");
  });
});

const DOCKER_IMAGE = process.env.AGENCY_DOCKER_TEST_IMAGE ?? "alpine";
const haveDocker = await isDockerAvailable(undefined, 5_000);
const haveImage = haveDocker && hasLocalImage(DOCKER_IMAGE);
const itContainer = haveDocker && haveImage ? test : test.skip;

describe("container-exec docker integration (gated)", () => {
  itContainer(
    `docker backend runs bash in the container with translated cwd [skip unless daemon+${DOCKER_IMAGE} reachable]`,
    async () => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), "agency-container-bash-")));
      dirs.push(dir);
      const root = join(dir, "ws");
      mkdirSync(join(root, "sub"), { recursive: true });
      const backend = new DockerSandboxBackend(root, {}, undefined, { image: DOCKER_IMAGE });
      const deps: ToolDeps = {
        identity: { type: "user" },
        capabilities: { ...FULL_CAPABILITIES, pathScopes: [root] },
        sandbox: backend,
      };
      const state: BashState = { cwd: root };
      const manager = new ProcessManager();
      managers.push(manager);
      const tool = createBashTool(deps, resolveShell("linux"), state, manager);
      const echo = await tool.handler({ command: "echo hello-from-docker" }, { signal });
      expect(echo.content).toContain("hello-from-docker");
      await tool.handler({ command: "cd sub" }, { signal });
      expect(state.cwd).toBe(resolve(join(root, "sub")));
    },
    120_000,
  );
});

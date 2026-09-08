import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgencyError, ErrorCode } from "@agency/schema";
import {
  DockerSandboxBackend,
  buildVolumeArgs,
  hasLocalImage,
  isDockerAvailable,
  normalizeContainerRoot,
  translateHostToMount,
  translateMountToHost,
} from "../src/sandbox-docker.ts";
import { SandboxBoundary } from "../src/sandbox.ts";

// Docker container backend (wave1-todo2). Pure translation logic is
// unit-tested with no daemon; container exec is gated and skips cleanly
// when no daemon (or no local image, so suites never pull) is reachable.
const DOCKER_IMAGE = process.env["AGENCY_DOCKER_TEST_IMAGE"] ?? "alpine";
const haveDocker = await isDockerAvailable(undefined, 5_000);
const haveImage = haveDocker && hasLocalImage(DOCKER_IMAGE);
const canRunContainer = haveDocker && haveImage;
const itContainer = canRunContainer ? test : test.skip;

function setup(): { dir: string; root: string; outside: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agency-docker-sandbox-")));
  const root = join(dir, "ws");
  const outside = join(dir, "outside");
  mkdirSync(join(root, "sub"), { recursive: true });
  mkdirSync(outside);
  return { dir, root, outside };
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

function denied(fn: () => unknown): AgencyError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AgencyError);
    expect((e as AgencyError).code).toBe(ErrorCode.PERMISSION_DENIED);
    return e as AgencyError;
  }
  throw new Error("expected PERMISSION_DENIED");
}

describe("sandbox-docker pure translation (no daemon)", () => {
  test("normalizeContainerRoot keeps absolute POSIX, strips trailing slash", () => {
    expect(normalizeContainerRoot("/workspace")).toBe("/workspace");
    expect(normalizeContainerRoot("/workspace/")).toBe("/workspace");
    expect(normalizeContainerRoot("workspace")).toBe("/workspace");
    expect(normalizeContainerRoot("/")).toBe("/");
  });

  test("host root maps to the container root itself", () => {
    const { dir, root } = setup();
    try {
      const backend = new DockerSandboxBackend(root);
      expect(backend.toContainerPath(".")).toBe("/workspace");
      expect(translateHostToMount(resolve(root), resolve(root), "/workspace")).toBe("/workspace");
    } finally {
      cleanup(dir);
    }
  });

  test("nested host paths map under the container mount", () => {
    const { dir, root } = setup();
    try {
      const backend = new DockerSandboxBackend(root);
      expect(backend.toContainerPath(join("sub", "f.txt"))).toBe("/workspace/sub/f.txt");
      expect(backend.toHostPath("/workspace/sub/f.txt")).toBe(join(resolve(root), "sub", "f.txt"));
      expect(backend.toHostPath("/workspace")).toBe(resolve(root));
    } finally {
      cleanup(dir);
    }
  });

  test("untranslatable host paths throw PERMISSION_DENIED", () => {
    const { dir, root, outside } = setup();
    try {
      denied(() => translateHostToMount(resolve(outside), resolve(root), "/workspace"));
      const backend = new DockerSandboxBackend(root);
      denied(() => backend.toContainerPath(join("..", "outside", "evil.txt")));
      denied(() => backend.toContainerPath(outside));
    } finally {
      cleanup(dir);
    }
  });

  test("container paths escaping the mount throw PERMISSION_DENIED", () => {
    const { dir, root } = setup();
    try {
      const backend = new DockerSandboxBackend(root);
      denied(() => backend.toHostPath("/etc/passwd"));
      denied(() => backend.toHostPath("/workspace/../evil.txt"));
      denied(() => backend.toHostPath("/other/file.txt"));
    } finally {
      cleanup(dir);
    }
  });

  test("symlink escape across the mount boundary is denied", () => {
    const { dir, root, outside } = setup();
    try {
      symlinkSync(outside, join(root, "sub", "escape"), process.platform === "win32" ? "junction" : "dir");
      const backend = new DockerSandboxBackend(root);
      denied(() => backend.toContainerPath(join("sub", "escape", "secret.txt")));
    } finally {
      cleanup(dir);
    }
  });

  test("buildVolumeArgs binds host root to container root verbatim", () => {
    const host = process.platform === "win32" ? "C:\\ws" : "/tmp/ws";
    expect(buildVolumeArgs(host, "/workspace")).toEqual(["-v", `${resolve(host)}:/workspace`]);
    expect(buildVolumeArgs(host, "/data/")).toEqual(["-v", `${resolve(host)}:/data`]);
  });

  test("malformed inputs: UNC, trailing slash, dot segments, drive-relative", () => {
    const { dir, root } = setup();
    try {
      const backend = new DockerSandboxBackend(root);
      // Trailing slash on an in-root dir still maps inside the mount.
      expect(backend.toContainerPath(join("sub") + "/")).toBe("/workspace/sub");
      // Dot segments that stay inside resolve normally.
      expect(backend.toContainerPath(join("sub", ".", "f.txt"))).toBe("/workspace/sub/f.txt");
      // UNC, parent escapes, and absolute outside paths are denied.
      denied(() => backend.toContainerPath("\\\\server\\share\\file.txt"));
      denied(() => backend.toContainerPath(join("..", "..", "evil.txt")));
      // Drive-relative spellings resolve against cwd: outside-root ones deny.
      denied(() => backend.toContainerPath("C:/Windows/System32/drivers/etc/hosts"));
    } finally {
      cleanup(dir);
    }
  });
});

describe("sandbox-docker policy parity with local backend", () => {
  test("resolvePath verdicts match SandboxBoundary", () => {
    const { dir, root } = setup();
    try {
      const local = new SandboxBoundary(root);
      const docker = new DockerSandboxBackend(root);
      expect(docker.resolvePath(join("sub", "new.txt"))).toBe(local.resolvePath(join("sub", "new.txt")));
      denied(() => docker.resolvePath(join("..", "evil.txt")));
      denied(() => local.resolvePath(join("..", "evil.txt")));
    } finally {
      cleanup(dir);
    }
  });

  test("checkCommand verdicts match SandboxBoundary", () => {
    const policy = { allow: [/^git/], deny: [/^git push/] };
    const docker = new DockerSandboxBackend(".", policy);
    expect(() => docker.checkCommand("git status")).not.toThrow();
    denied(() => docker.checkCommand("git push"));
    denied(() => docker.checkCommand("rm -rf x"));
  });

  test("resolvePathGated verdicts match SandboxBoundary", async () => {
    const { dir, root, outside } = setup();
    try {
      const deniedBackend = new DockerSandboxBackend(root, {}, () => "deny");
      await expect(deniedBackend.resolvePathGated(outside, { tool: "read" })).rejects.toThrow(AgencyError);
      const allowed = new DockerSandboxBackend(root, {}, () => "allow");
      await expect(allowed.resolvePathGated(outside, { tool: "read" })).resolves.toBe(outside);
      const gated = new DockerSandboxBackend(root, {}, () => "ask");
      await expect(gated.resolvePathGated(outside, { tool: "read" })).rejects.toThrow(AgencyError);
      await expect(gated.resolvePathGated(outside, { tool: "read", ask: async () => "once" })).resolves.toBe(
        outside,
      );
      await expect(deniedBackend.resolvePathGated("new.ts", { tool: "write" })).resolves.toBe(
        join(root, "new.ts"),
      );
    } finally {
      cleanup(dir);
    }
  });

  test("implements the SandboxBackend seam and constructs with no daemon", () => {
    const { dir, root } = setup();
    try {
      // Construction alone must never contact Docker (side-effect free).
      const backend = new DockerSandboxBackend(root);
      expect(() => backend.checkCommand("anything")).not.toThrow();
      expect(backend.containerRoot).toBe("/workspace");
      expect(backend.volumeArgs()).toEqual(["-v", `${resolve(root)}:/workspace`]);
    } finally {
      cleanup(dir);
    }
  });

  test("isDockerAvailable is false for an unreachable binary (fast, no hang)", async () => {
    await expect(isDockerAvailable("agency-no-such-docker-bin-xyz", 2_000)).resolves.toBe(false);
  });
});

describe("sandbox-docker container exec (gated)", () => {
  itContainer(
    `docker exec echo round-trip with workspace mount [skip unless daemon+${DOCKER_IMAGE} reachable]`,
    async () => {
      const { dir, root } = setup();
      try {
        writeFileSync(join(root, "probe.txt"), "hello-from-host\n");
        const backend = new DockerSandboxBackend(root, {}, undefined, { image: DOCKER_IMAGE });
        expect(await backend.isAvailable()).toBe(true);
        const echo = await backend.exec(["echo", "hello-from-container"], { timeoutMs: 60_000 });
        expect(echo.exitCode).toBe(0);
        expect(echo.stdout).toContain("hello-from-container");
        const cat = await backend.exec(["cat", "/workspace/probe.txt"], { timeoutMs: 60_000 });
        expect(cat.exitCode).toBe(0);
        expect(cat.stdout).toContain("hello-from-host");
      } finally {
        cleanup(dir);
      }
    },
  );

  itContainer(
    `docker exec denies symlink escape before reaching the daemon [skip unless daemon+${DOCKER_IMAGE} reachable]`,
    async () => {
      const { dir, root, outside } = setup();
      try {
        symlinkSync(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
        const backend = new DockerSandboxBackend(root, {}, undefined, { image: DOCKER_IMAGE });
        denied(() => backend.toContainerPath(join("escape", "secret.txt")));
      } finally {
        cleanup(dir);
      }
    },
  );
});

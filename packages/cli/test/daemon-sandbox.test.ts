import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@agency/core";
import { DockerSandboxBackend, SandboxBoundary } from "@agency/guard";
import { createSandboxBackend } from "../src/daemon.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** Asserts a typed Zod rejection naming the sandbox section. */
function expectZodSandboxError(fn: () => unknown): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("ZodError");
    expect(String((err as Error).message)).toMatch(/sandbox/);
    return;
  }
  throw new Error("expected a ZodError but nothing threw");
}

describe("daemon sandbox backend selection", () => {
  test("default config boots the software backend", () => {
    const config = loadConfig({ globalDir: tempDir("agency-sandbox-global-"), env: {} });
    expect(config.sandbox.backend).toBe("software");
    const sandbox = createSandboxBackend(
      tempDir("agency-sandbox-root-"),
      { deny: [] },
      undefined,
      config.sandbox,
    );
    expect(sandbox).toBeInstanceOf(SandboxBoundary);
    expect(sandbox).not.toBeInstanceOf(DockerSandboxBackend);
  });

  test("explicit software boots the software backend", () => {
    const config = loadConfig({
      globalDir: tempDir("agency-sandbox-global-"),
      env: {},
      flags: { sandbox: { backend: "software" } },
    });
    const sandbox = createSandboxBackend(
      tempDir("agency-sandbox-root-"),
      { deny: [] },
      undefined,
      config.sandbox,
    );
    expect(sandbox).toBeInstanceOf(SandboxBoundary);
  });

  test("docker flag boots the container backend with config options", () => {
    const config = loadConfig({
      globalDir: tempDir("agency-sandbox-global-"),
      env: {},
      flags: { sandbox: { backend: "docker", image: "alpine:3.21", containerRoot: "/w" } },
    });
    expect(config.sandbox.backend).toBe("docker");
    const sandbox = createSandboxBackend(
      tempDir("agency-sandbox-root-"),
      { deny: [] },
      undefined,
      config.sandbox,
    );
    expect(sandbox).toBeInstanceOf(DockerSandboxBackend);
    expect((sandbox as DockerSandboxBackend).containerRoot).toBe("/w");
  });

  test("invalid backend string fails config load with a typed error", () => {
    const dir = tempDir("agency-sandbox-global-");
    expectZodSandboxError(() =>
      loadConfig({ globalDir: dir, env: {}, flags: { sandbox: { backend: "chroot" } } }),
    );
  });

  test("malformed backend values are rejected", () => {
    const dir = tempDir("agency-sandbox-global-");
    for (const backend of ["", "DOCKER", null, 42, { nested: true }]) {
      expectZodSandboxError(() => loadConfig({ globalDir: dir, env: {}, flags: { sandbox: { backend } } }));
    }
  });

  test("env var selects the docker backend", () => {
    const config = loadConfig({
      globalDir: tempDir("agency-sandbox-global-"),
      env: { AGENCY_SANDBOX_BACKEND: "docker" },
    });
    expect(config.sandbox.backend).toBe("docker");
    const sandbox = createSandboxBackend(
      tempDir("agency-sandbox-root-"),
      { deny: [] },
      undefined,
      config.sandbox,
    );
    expect(sandbox).toBeInstanceOf(DockerSandboxBackend);
  });

  test("flags override the file layers and nested keys merge across layers", () => {
    const globalDir = tempDir("agency-sandbox-global-");
    const projectRoot = tempDir("agency-sandbox-project-");
    writeFileSync(
      join(globalDir, "config.jsonc"),
      `{ "schemaVersion": 2, "sandbox": { "backend": "docker" } }`,
    );
    mkdirSync(join(projectRoot, ".agency"));
    writeFileSync(
      join(projectRoot, ".agency", "config.jsonc"),
      `{ "schemaVersion": 2, "sandbox": { "image": "custom:1" } }`,
    );
    const merged = loadConfig({ globalDir, projectRoot, env: {} });
    expect(merged.sandbox.backend).toBe("docker");
    expect(merged.sandbox.image).toBe("custom:1");
    const overridden = loadConfig({
      globalDir,
      projectRoot,
      env: {},
      flags: { sandbox: { backend: "software" } },
    });
    expect(overridden.sandbox.backend).toBe("software");
    expect(overridden.sandbox.image).toBe("custom:1");
  });

  test("egress/network/capDrop flow from flags and env into the docker backend", () => {
    const flagged = loadConfig({
      globalDir: tempDir("agency-sandbox-global-"),
      env: {},
      flags: {
        sandbox: { backend: "docker", egress: ["example.com"], network: "filtered", capDrop: ["NET_RAW"] },
      },
    });
    expect(flagged.sandbox.egress).toEqual(["example.com"]);
    expect(flagged.sandbox.network).toBe("filtered");
    expect(flagged.sandbox.capDrop).toEqual(["NET_RAW"]);
    const viaFlags = createSandboxBackend(
      tempDir("agency-sandbox-root-"),
      { deny: [] },
      undefined,
      flagged.sandbox,
    );
    expect(viaFlags).toBeInstanceOf(DockerSandboxBackend);

    const viaEnv = loadConfig({
      globalDir: tempDir("agency-sandbox-global-"),
      env: {
        AGENCY_SANDBOX_BACKEND: "docker",
        AGENCY_SANDBOX_EGRESS: "example.com, api.example.com",
        AGENCY_SANDBOX_NETWORK: "filtered",
        AGENCY_SANDBOX_CAP_DROP: "NET_RAW,SYS_ADMIN",
      },
    });
    expect(viaEnv.sandbox.egress).toEqual(["example.com", "api.example.com"]);
    expect(viaEnv.sandbox.network).toBe("filtered");
    expect(viaEnv.sandbox.capDrop).toEqual(["NET_RAW", "SYS_ADMIN"]);
    const viaEnvBackend = createSandboxBackend(
      tempDir("agency-sandbox-root-"),
      { deny: [] },
      undefined,
      viaEnv.sandbox,
    );
    expect(viaEnvBackend).toBeInstanceOf(DockerSandboxBackend);
  });

  test("unknown capDrop passes schema shape but fails backend construction", () => {
    const config = loadConfig({
      globalDir: tempDir("agency-sandbox-global-"),
      env: {},
      flags: { sandbox: { backend: "docker", capDrop: ["BOGUS_CAP"] } },
    });
    expect(() =>
      createSandboxBackend(tempDir("agency-sandbox-root-"), { deny: [] }, undefined, config.sandbox),
    ).toThrow();
  });
});

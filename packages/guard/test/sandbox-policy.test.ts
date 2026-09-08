import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgencyError, ErrorCode } from "@agency/schema";
import {
  DockerSandboxBackend,
  buildCapDropArgs,
  buildNetworkArgs,
  ensureSandboxAvailable,
} from "../src/sandbox-docker.ts";
import { SandboxBoundary } from "../src/sandbox.ts";

// Wave1-todo6: egress + cap-drop flag construction, constructor validation,
// and the fail-closed no-daemon gate. All daemon-free: asserts argv helper
// contents and typed errors, never live runs.

function tempRoot(): { dir: string; root: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agency-sandbox-policy-")));
  return { dir, root: join(dir, "ws") };
}

describe("buildNetworkArgs", () => {
  test("undefined egress preserves current behavior (no flag)", () => {
    expect(buildNetworkArgs(undefined, undefined)).toEqual([]);
  });
  test("empty egress allowlist isolates the container", () => {
    expect(buildNetworkArgs([], undefined)).toEqual(["--network", "none"]);
  });
  test("non-empty egress without a named network still isolates (deny-by-default)", () => {
    expect(buildNetworkArgs(["example.com"], undefined)).toEqual(["--network", "none"]);
  });
  test("explicit network wins over the egress default", () => {
    expect(buildNetworkArgs(["example.com"], "filtered")).toEqual(["--network", "filtered"]);
    expect(buildNetworkArgs([], "filtered")).toEqual(["--network", "filtered"]);
  });
  test("explicit network alone is honored", () => {
    expect(buildNetworkArgs(undefined, "filtered")).toEqual(["--network", "filtered"]);
  });
});

describe("buildCapDropArgs", () => {
  test("undefined/empty yields no flags", () => {
    expect(buildCapDropArgs(undefined)).toEqual([]);
    expect(buildCapDropArgs([])).toEqual([]);
  });
  test("known caps map to --cap-drop flags in order", () => {
    expect(buildCapDropArgs(["NET_RAW", "SYS_ADMIN"])).toEqual([
      "--cap-drop",
      "NET_RAW",
      "--cap-drop",
      "SYS_ADMIN",
    ]);
  });
  test("CAP_-prefixed and lowercase spellings canonicalize", () => {
    expect(buildCapDropArgs(["CAP_NET_RAW", "cap_sys_admin"])).toEqual([
      "--cap-drop",
      "NET_RAW",
      "--cap-drop",
      "SYS_ADMIN",
    ]);
  });
  test("unknown capability fails closed with a typed error", () => {
    try {
      buildCapDropArgs(["NET_RAW", "BOGUS_CAP"]);
      throw new Error("expected AgencyError but nothing threw");
    } catch (err) {
      expect(err).toBeInstanceOf(AgencyError);
      expect((err as AgencyError).code).toBe(ErrorCode.INTERNAL);
      expect(String((err as Error).message)).toMatch(/BOGUS_CAP/);
    }
  });
});

describe("DockerSandboxBackend knob validation", () => {
  test("unknown capDrop fails construction (fail fast, no daemon needed)", () => {
    const { dir, root } = tempRoot();
    try {
      expect(() => new DockerSandboxBackend(root, {}, undefined, { capDrop: ["NOPE"] })).toThrow(AgencyError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("egress + capDrop construct cleanly with known values", () => {
    const { dir, root } = tempRoot();
    try {
      const backend = new DockerSandboxBackend(root, {}, undefined, {
        egress: ["example.com"],
        capDrop: ["NET_RAW"],
      });
      expect(backend).toBeInstanceOf(DockerSandboxBackend);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ensureSandboxAvailable fail-closed gate", () => {
  test("software backend (no probe) resolves without probing", async () => {
    const { dir, root } = tempRoot();
    try {
      await ensureSandboxAvailable(new SandboxBoundary(root));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("reachable container backend resolves", async () => {
    const probe = { isAvailable: async () => true };
    await ensureSandboxAvailable(probe as unknown as SandboxBoundary);
  });
  test("unreachable container backend throws a typed error naming remediation", async () => {
    const probe = { isAvailable: async () => false };
    try {
      await ensureSandboxAvailable(probe as unknown as SandboxBoundary);
      throw new Error("expected AgencyError but nothing threw");
    } catch (err) {
      expect(err).toBeInstanceOf(AgencyError);
      expect((err as AgencyError).code).toBe(ErrorCode.INTERNAL);
      const message = String((err as Error).message);
      expect(message).toMatch(/sandbox\.backend.*"docker"/);
      expect(message).toMatch(/AGENCY_SANDBOX_BACKEND=software/);
    }
  });
  test("real DockerSandboxBackend without a daemon fails closed", async () => {
    const { dir, root } = tempRoot();
    try {
      const backend = new DockerSandboxBackend(root, {}, undefined, {
        dockerBin: "agency-definitely-not-a-binary-xyz",
      });
      try {
        await ensureSandboxAvailable(backend);
        throw new Error("expected AgencyError but nothing threw");
      } catch (err) {
        expect(err).toBeInstanceOf(AgencyError);
        expect(String((err as Error).message)).toMatch(/AGENCY_SANDBOX_BACKEND=software/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

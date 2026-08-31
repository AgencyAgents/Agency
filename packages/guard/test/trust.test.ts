import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgencyError, ErrorCode } from "@agency/schema";
import { createFileTrustStore, requireTrust } from "../src/trust.ts";

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempStorePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "agency-trust-test-"));
  cleanup.push(dir);
  return join(dir, "trusted.json");
}

describe("createFileTrustStore", () => {
  test("a directory is untrusted before any decision is recorded", () => {
    const store = createFileTrustStore(tempStorePath());
    expect(store.isTrusted("/repo/project")).toBe(false);
  });

  test("trust persists across store instances backed by the same file", () => {
    const path = tempStorePath();
    createFileTrustStore(path).trust("/repo/project");
    expect(createFileTrustStore(path).isTrusted("/repo/project")).toBe(true);
  });

  test("distrust removes a previously trusted path", () => {
    const store = createFileTrustStore(tempStorePath());
    store.trust("/repo/project");
    store.distrust("/repo/project");
    expect(store.isTrusted("/repo/project")).toBe(false);
  });

  test("trusting the same path twice doesn't duplicate the entry", () => {
    const path = tempStorePath();
    const store = createFileTrustStore(path);
    store.trust("/repo/project");
    store.trust("/repo/project");
    expect(createFileTrustStore(path).isTrusted("/repo/project")).toBe(true);
  });
});

describe("requireTrust", () => {
  test("throws PERMISSION_DENIED for an untrusted directory", () => {
    const store = createFileTrustStore(tempStorePath());
    const err = (() => {
      try {
        requireTrust(store, "/repo/project");
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(AgencyError);
    expect((err as AgencyError).code).toBe(ErrorCode.PERMISSION_DENIED);
  });

  test("does not throw once the directory is trusted", () => {
    const store = createFileTrustStore(tempStorePath());
    store.trust("/repo/project");
    expect(() => requireTrust(store, "/repo/project")).not.toThrow();
  });
});

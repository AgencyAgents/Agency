import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgencyError, ErrorCode } from "@agency/schema";
import { createHttpClient } from "../src/http.ts";

// Bun reads HTTP_PROXY/HTTPS_PROXY once at process startup, not per request,
// so these tests need the process itself launched without them set (true
// in CI and on a normal dev machine). If your shell exports an ambient proxy,
// run this file as: env -u HTTP_PROXY -u HTTPS_PROXY bun test packages/net

let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => {
  server?.stop(true);
  server = undefined;
});

describe("createHttpClient", () => {
  test("makes a normal request successfully with no proxy configured", async () => {
    server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const client = createHttpClient({});

    const res = await client.fetch(`http://localhost:${server.port}/`);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  test("times out a hanging request as a NETWORK error", async () => {
    server = Bun.serve({
      port: 0,
      async fetch() {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        return new Response("too slow");
      },
    });
    const client = createHttpClient({ timeoutMs: 50 });

    await expect(client.fetch(`http://localhost:${server.port}/`)).rejects.toMatchObject({
      code: ErrorCode.NETWORK,
    });
  });

  test("an unreachable host surfaces as a NETWORK error, not a hang", async () => {
    const client = createHttpClient({ timeoutMs: 2_000 });

    const err = await client.fetch("http://127.0.0.1:1/").catch((e) => e);
    expect(err).toBeInstanceOf(AgencyError);
    expect((err as AgencyError).code).toBe(ErrorCode.NETWORK);
  });

  test("an explicit proxy override is used instead of going direct", async () => {
    const client = createHttpClient({ proxy: "http://127.0.0.1:1", timeoutMs: 2_000 });

    // The origin (example.invalid) is unreachable directly, but a real client
    // only ever talks to the configured proxy: the failure comes from the
    // proxy connection itself, not from resolving example.invalid.
    const err = await client.fetch("http://example.invalid/").catch((e) => e);
    expect(err).toBeInstanceOf(AgencyError);
    expect((err as AgencyError).code).toBe(ErrorCode.PROXY);
  });

  test("NO_PROXY exempts a matching host from an explicit proxy override", async () => {
    server = Bun.serve({ port: 0, fetch: () => new Response("direct") });
    const client = createHttpClient({
      proxy: "http://127.0.0.1:1",
      env: { NO_PROXY: "localhost" },
    });

    const res = await client.fetch(`http://localhost:${server.port}/`);
    expect(await res.text()).toBe("direct");
  });

  test("reads a custom CA bundle from NODE_EXTRA_CA_CERTS when caFile is unset", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agency-net-test-"));
    const caPath = join(dir, "fake-ca.pem");
    writeFileSync(caPath, "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n");
    server = Bun.serve({ port: 0, fetch: () => new Response("ok") });

    try {
      const client = createHttpClient({ env: { NODE_EXTRA_CA_CERTS: caPath } });
      const res = await client.fetch(`http://localhost:${server.port}/`);
      expect(res.status).toBe(200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

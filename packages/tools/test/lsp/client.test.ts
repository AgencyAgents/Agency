import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspClient } from "../../src/lsp/client.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const FIXTURE = join(import.meta.dir, "fake-server.ts");

async function waitFor<T>(probe: () => T | undefined, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition not met in time");
}

function fakeClient(): LspClient {
  return new LspClient({ command: process.execPath, args: [FIXTURE] });
}

describe("LspClient", () => {
  test("initialize handshake completes and didOpen yields cached diagnostics", async () => {
    const root = mkdtempSync(join(tmpdir(), "agency-lsp-test-"));
    dirs.push(root);
    const file = join(root, "sample.ts");
    writeFileSync(file, "const x = 1;\n");
    const client = fakeClient();

    try {
      await client.ready;
      client.open(file, "const x = 1;\n", "typescript");

      const diagnostics = await waitFor(() =>
        client.diagnosticsFor(file).length > 0 ? client.diagnosticsFor(file) : undefined,
      );
      expect(diagnostics).toHaveLength(2);
      expect(diagnostics[0]).toMatchObject({
        severity: 1,
        message: "boom",
        line: 2,
        character: 4,
        source: "fake",
      });
      expect(diagnostics[1]).toMatchObject({ severity: 2, message: "meh" });
    } finally {
      await client.close();
    }
  });

  test("references resolves server locations back to plain paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "agency-lsp-test-"));
    dirs.push(root);
    const file = join(root, "sample.ts");
    writeFileSync(file, "const x = 1;\n");
    const client = fakeClient();

    try {
      await client.ready;
      const locations = await client.references(file, 0, 6);
      expect(locations).toEqual([{ path: file, line: 7, character: 1 }]);
    } finally {
      await client.close();
    }
  });

  test("close kills the spawned process", async () => {
    const client = fakeClient();
    await client.ready;
    await client.close();
    await client.close();
  });

  test("a command that cannot spawn rejects the ready promise", async () => {
    const client = new LspClient({
      command: process.execPath,
      args: ["definitely-missing-script-xyz.ts"],
      requestTimeoutMs: 1_000,
    });
    await expect(client.ready).rejects.toThrow();
    await client.close();
  });
});

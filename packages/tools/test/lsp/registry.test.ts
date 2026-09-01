import { describe, expect, test } from "bun:test";
import type { LspClient } from "../../src/lsp/client.ts";
import { createLspRegistry } from "../../src/lsp/registry.ts";

const SERVERS = [
  { command: "fake-ts", extensions: [".ts", ".tsx"], languageId: "typescript" },
  { command: "fake-py", extensions: [".py"], languageId: "python" },
];

describe("createLspRegistry", () => {
  test("routes a path to the server claiming its extension", () => {
    const created: string[] = [];
    const registry = createLspRegistry({
      servers: SERVERS,
      clientFactory: (config) => {
        created.push(config.command);
        return { ready: Promise.resolve() } as unknown as LspClient;
      },
    });

    expect(registry.languageIdFor("src/a.ts")).toBe("typescript");
    expect(registry.languageIdFor("src/b.py")).toBe("python");
    expect(registry.languageIdFor("README.md")).toBeUndefined();

    registry.clientFor("src/a.ts");
    registry.clientFor("src/other.ts");
    expect(created).toEqual(["fake-ts"]);
    expect(registry.all()).toHaveLength(1);
  });

  test("dispose closes every created client once", async () => {
    const closed: string[] = [];
    const registry = createLspRegistry({
      servers: SERVERS,
      clientFactory: (config) =>
        ({
          ready: Promise.resolve(),
          close: async () => {
            closed.push(config.command);
          },
        }) as unknown as LspClient,
    });

    registry.clientFor("a.ts");
    registry.clientFor("b.py");
    await registry.dispose();
    await registry.dispose();
    expect(closed.sort()).toEqual(["fake-py", "fake-ts"]);
  });
});

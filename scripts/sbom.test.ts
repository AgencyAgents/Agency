import { describe, expect, test } from "bun:test";
import { generateSbom, purl, resolvedVersion } from "./sbom.ts";

const KNOWN_INTEGRITY_HEX = "cf83e1357eefb8bdf1542850d66d8007d620b3003e7a6c747d6a91c658b615f838";

const LOCK = {
  workspaces: {
    "": { name: "agency", dependencies: { zod: "^4" } },
    "packages/cli": {
      name: "@agency/cli",
      dependencies: { "@agency/core": "workspace:*", zod: "^4" },
    },
    "packages/core": { name: "@agency/core", dependencies: { zod: "^4" } },
  },
  packages: {
    "@agency/cli": ["@agency/cli@workspace:packages/cli"],
    "@agency/core": ["@agency/core@workspace:packages/core"],
    "@types/node": [
      "@types/node@26.4.0",
      "",
      { dependencies: { "undici-types": "~8.3.0" } },
      "sha512-z4PhNX7vuL3xVChQ1m2AB9YgswA+emx0fWqRxli2Ffg4=",
    ],
    "undici-types": ["undici-types@8.3.0", "", {}, "sha512-z4PhNX7vuL3xVChQ1m2AB9YgswA+emx0fWqRxli2Ffg4="],
    zod: ["zod@4.5.4", "", {}, "sha512-z4PhNX7vuL3xVChQ1m2AB9YgswA+emx0fWqRxli2Ffg4="],
  },
};

const OPTS = { name: "agency", version: "0.1.0", reproducible: true, now: new Date(0) } as const;

describe("purl", () => {
  test("encodes the scope's @, keeps the inner slash", () => {
    expect(purl("@agency/cli", "0.1.0")).toBe("pkg:npm/%40agency/cli@0.1.0");
    expect(purl("zod", "4.5.4")).toBe("pkg:npm/zod@4.5.4");
  });
});

describe("resolvedVersion", () => {
  test("splits on the last @", () => {
    expect(resolvedVersion("zod@4.5.4")).toBe("4.5.4");
    expect(resolvedVersion("@types/node@26.4.0")).toBe("26.4.0");
    expect(resolvedVersion("@agency/cli@workspace:packages/cli")).toBe("workspace:packages/cli");
  });
});

describe("generateSbom", () => {
  const bom = generateSbom(LOCK, OPTS);
  const components = bom.components as unknown as Array<Record<string, unknown>>;
  const byRef = new Map(components.map((c) => [c["bom-ref"], c]));

  test("root component carries name and version", () => {
    const meta = bom.metadata as Record<string, unknown>;
    expect(meta.component).toEqual({
      type: "application",
      "bom-ref": "pkg:npm/agency@0.1.0",
      name: "agency",
      version: "0.1.0",
    });
  });

  test("workspace packages are application components at the release version", () => {
    const cli = byRef.get("pkg:npm/%40agency/cli@0.1.0");
    expect(cli).toMatchObject({ type: "application", name: "@agency/cli", version: "0.1.0" });
  });

  test("external packages are library components with resolved versions", () => {
    expect(byRef.get("pkg:npm/zod@4.5.4")).toMatchObject({ type: "library", name: "zod" });
    expect(byRef.get("pkg:npm/%40types/node@26.4.0")).toMatchObject({
      type: "library",
      name: "@types/node",
    });
  });

  test("lockfile integrity hashes ride along as SHA-512 hex", () => {
    const zod = byRef.get("pkg:npm/zod@4.5.4");
    expect(zod?.hashes).toEqual([{ alg: "SHA-512", content: KNOWN_INTEGRITY_HEX }]);
  });

  test("dependency graph resolves workspace and external refs", () => {
    const deps = bom.dependencies as Array<{ ref: string; dependsOn: string[] }>;
    const byDepRef = new Map(deps.map((d) => [d.ref, d.dependsOn]));
    expect(byDepRef.get("pkg:npm/agency@0.1.0")).toEqual([
      "pkg:npm/%40agency/cli@0.1.0",
      "pkg:npm/%40agency/core@0.1.0",
      "pkg:npm/zod@4.5.4",
    ]);
    expect(byDepRef.get("pkg:npm/%40agency/cli@0.1.0")).toEqual([
      "pkg:npm/%40agency/core@0.1.0",
      "pkg:npm/zod@4.5.4",
    ]);
    expect(byDepRef.get("pkg:npm/%40types/node@26.4.0")).toEqual(["pkg:npm/undici-types@8.3.0"]);
    expect(byDepRef.get("pkg:npm/zod@4.5.4")).toEqual([]);
  });

  test("reproducible mode is byte-identical across runs", () => {
    const again = generateSbom(LOCK, OPTS);
    expect(JSON.stringify(again)).toBe(JSON.stringify(bom));
    expect(bom.serialNumber).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
  });

  test("non-reproducible mode stamps a timestamp and a random serial", () => {
    const stamped = generateSbom(LOCK, { ...OPTS, reproducible: false });
    expect((stamped.metadata as Record<string, unknown>).timestamp).toBe(new Date(0).toISOString());
    expect(stamped.serialNumber).not.toBe(bom.serialNumber);
  });
});

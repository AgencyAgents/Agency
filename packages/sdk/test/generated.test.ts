import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { RPC_METHODS, startHttpGateway } from "@agency/rpc";
import { fetchAgencyDoc, renderSdk } from "../../../scripts/sdk-gen.ts";
import { createSurfaceClient } from "../src/generated.ts";

describe("generated SDK surface", () => {
  test("checked-in generated.ts matches a fresh render from /doc (drift fails loudly)", async () => {
    const handlers: Record<string, () => Promise<unknown>> = {};
    for (const method of RPC_METHODS) handlers[method] = async () => ({ ok: true });
    const gateway = startHttpGateway({ handlers });
    try {
      const doc = await fetchAgencyDoc(`http://127.0.0.1:${gateway.port}/doc`);
      expect(doc.methods.map((m) => m.name).sort()).toEqual([...RPC_METHODS].sort());
      const fresh = renderSdk(doc);
      const checkedIn = readFileSync(new URL("../src/generated.ts", import.meta.url), "utf8");
      expect(fresh).toBe(checkedIn);
    } finally {
      await gateway.close();
    }
  });

  test("every catalogued method is callable through createSurfaceClient", async () => {
    const seen: string[] = [];
    const surface = createSurfaceClient(async (method, params) => {
      seen.push(method);
      return { method, params };
    });
    for (const method of RPC_METHODS) {
      const result = (await surface[method as keyof typeof surface]({ probe: true })) as {
        method: string;
      };
      expect(result.method).toBe(method);
    }
    expect(seen.sort()).toEqual([...RPC_METHODS].sort());
  });
});

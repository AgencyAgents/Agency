import { describe, expect, test } from "bun:test";
import { findUnwired, reachability, wiredClaims } from "./doc-claims.ts";

const sources = new Map([
  [
    "packages/cli/src/entrypoint.ts",
    "import { used } from './lib.ts';\nexport function main() {\n  return used();\n}\n",
  ],
  [
    "packages/core/src/lib.ts",
    "export function used() {\n  return helper();\n}\nfunction helper() {\n  return 1;\n}\n" +
      "export function orphan() {\n  return orphanHelper();\n}\nexport function orphanHelper() {\n  return 2;\n}\n",
  ],
]);
const reach = reachability(sources, (file) => file.endsWith("entrypoint.ts"));

describe("status wired gate", () => {
  test("a symbol the entrypoint reaches through another function is live; an orphan chain is not", () => {
    expect(reach.live.has("helper")).toBe(true);
    expect(reach.live.has("orphan")).toBe(false);
    expect(reach.live.has("orphanHelper")).toBe(false);
  });

  test("a Wired: Yes row that names an orphan fails; a No row and an undeclared name do not", () => {
    const status = [
      "| Item | Built | Wired | Planned |",
      "|---|---|---|---|",
      "| Good (`used`) | Yes | Yes: `main` calls it over `some_rpc` | None |",
      "| Bad (`orphan`) | Yes | Yes: wired | None |",
      "| Honest (`orphanHelper`) | Yes | No: no production caller | None |",
    ].join("\n");
    expect(findUnwired(wiredClaims(status), reach)).toEqual([{ item: "Bad (`orphan`)", symbol: "orphan" }]);
  });
});

import { expect, test } from "bun:test";
import { environmentLayer, parseVars } from "../src/lib/environments.ts";

test("variables parse as a shell writes them, and a line with no valid name is skipped", () => {
  expect(
    parseVars(
      [
        "export NODE_ENV=production",
        'API_URL="https://x.example/a=b"',
        "# OLD=1",
        "BAD NAME=2",
        "1X=3",
        "=4",
        "noeq",
      ].join("\n"),
    ),
  ).toEqual({ NODE_ENV: "production", API_URL: "https://x.example/a=b" });
});

test("full network turns the network on, so a global config cannot take it away", () => {
  const base = { id: "e", name: "E", domains: "a.example, b.example", vars: "", setup: "" };
  expect(environmentLayer({ ...base, network: "full" })).toEqual({ sandbox: { allowNetwork: true } });
  expect(environmentLayer({ ...base, network: "domains" })).toEqual({
    sandbox: { backend: "os", allowNetwork: false, allowedDomains: ["a.example", "b.example"] },
  });
  expect(environmentLayer(undefined)).toEqual({});
});

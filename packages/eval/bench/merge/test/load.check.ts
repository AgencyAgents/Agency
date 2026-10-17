import { expect, test } from "bun:test";
import { load } from "../src/load.ts";

test("a layer overrides a scalar and keeps the rest of an object", () => {
  expect(load({ server: { port: 8080 } }).server).toEqual({ port: 8080, host: "localhost" });
});
test("a list in a layer replaces the list, it does not merge by index", () => {
  expect(load({ plugins: ["auth"] }).plugins).toEqual(["auth"]);
});
test("an empty list clears the list", () => expect(load({ plugins: [] }).plugins).toEqual([]));

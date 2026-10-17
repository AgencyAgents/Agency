import { expect, test } from "bun:test";
import { parseArgs } from "../src/args.ts";
import { portOf } from "../src/cli.ts";

test("--name value", () => expect(parseArgs(["--port", "80"]).flags).toEqual({ port: "80" }));
test("--name=value", () =>
  expect(parseArgs(["--port=8080", "a"])).toEqual({ flags: { port: "8080" }, rest: ["a"] }));
test("a bare flag before another flag", () =>
  expect(parseArgs(["--v", "--x=1"]).flags).toEqual({ v: true, x: "1" }));
test("the port from --port=", () => expect(portOf(["serve", "--port=9000"], {})).toBe(9000));

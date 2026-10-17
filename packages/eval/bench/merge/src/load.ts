import { merge } from "./merge.ts";

const defaults = { name: "app", plugins: ["core", "log", "http"], server: { port: 80, host: "localhost" } };

/** The config of the app: the defaults, then each layer in order. */
export function load(...layers: object[]): typeof defaults {
  return layers.reduce(
    (acc, layer) => merge(acc as never, layer as never),
    defaults as object,
  ) as typeof defaults;
}

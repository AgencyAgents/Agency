type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const isObject = (value: unknown): value is Record<string, Json> =>
  typeof value === "object" && value !== null;

/** A later layer wins; objects merge key by key. */
export function merge(base: Json, layer: Json): Json {
  if (!isObject(base) || !isObject(layer)) return layer;
  const out: Record<string, Json> = { ...(base as Record<string, Json>) };
  for (const [key, value] of Object.entries(layer))
    out[key] = key in out ? merge(out[key] as Json, value) : value;
  return out;
}

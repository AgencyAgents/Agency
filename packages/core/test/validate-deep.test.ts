import { expect, test } from "bun:test";
import { validateToolInput } from "../src/loop.ts";

const schema = {
  type: "object",
  properties: {
    owner: {
      type: "object",
      properties: { name: { type: "string" }, role: { type: "string", enum: ["admin", "user"] } },
      required: ["name"],
    },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "integer" }, tags: { type: "array", items: { enum: ["a", "b"] } } },
        required: ["id"],
      },
    },
    note: { type: ["string", "null"] },
  },
  required: ["owner"],
};

test("the schema check reaches nested objects, arrays of objects, enums in items and type lists", () => {
  const good = { owner: { name: "x", role: "admin" }, items: [{ id: 1, tags: ["a"] }], note: null };
  expect(validateToolInput(schema, good)).toBeUndefined();
  const cases: Array<[unknown, string]> = [
    [{ owner: { name: 5 } }, '"owner.name" must be string, got number'],
    [{ owner: {} }, 'missing required property "owner.name"'],
    [{ owner: { name: "x", role: "root" } }, '"owner.role" must be one of ["admin","user"]'],
    [{ owner: { name: "x" }, items: [{ id: 1 }, { id: "2" }] }, '"items[1].id" must be integer, got string'],
    [{ owner: { name: "x" }, items: [{}] }, 'missing required property "items[0].id"'],
    [
      { owner: { name: "x" }, items: [{ id: 1, tags: ["a", "z"] }] },
      '"items[0].tags[1]" must be one of ["a","b"]',
    ],
    [{ owner: { name: "x" }, note: 5 }, '"note" must be string or null, got number'],
  ];
  for (const [input, message] of cases)
    expect(validateToolInput(schema, input)).toBe(`invalid input: ${message}`);
});

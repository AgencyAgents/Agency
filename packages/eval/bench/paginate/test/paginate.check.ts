import { expect, test } from "bun:test";
import { paginate } from "../src/index.ts";

const items = Array.from({ length: 7 }, (_, i) => i + 1);

test("first page", () => expect(paginate(items, 1, 3)).toEqual({ items: [1, 2, 3], page: 1, pages: 3 }));
test("last page is short", () => expect(paginate(items, 3, 3)).toEqual({ items: [7], page: 3, pages: 3 }));
test("a page past the end is the last page", () => expect(paginate(items, 9, 3).items).toEqual([7]));
test("no items is one empty page", () =>
  expect(paginate([], 1, 3)).toEqual({ items: [], page: 1, pages: 1 }));

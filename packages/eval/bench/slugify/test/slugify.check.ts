import { expect, test } from "bun:test";
import { slugify } from "../src/slugify.ts";

test("plain", () => expect(slugify("Héllo, World!")).toBe("hello-world"));
test("maxLength cuts at a word boundary", () =>
  expect(slugify("the quick brown fox", { maxLength: 12 })).toBe("the-quick"));
test("one long word is cut hard", () => expect(slugify("abcdefghijkl", { maxLength: 5 })).toBe("abcde"));
test("no trailing dash", () => expect(slugify("ab cd ef", { maxLength: 6 })).toBe("ab-cd"));

import { describe, expect, test } from "bun:test";
import { parseGitignoreLine } from "../src/gitignore.ts";

function matcher(lines: string[]): (rel: string) => boolean {
  const rules = lines
    .map(parseGitignoreLine)
    .filter((rule): rule is NonNullable<typeof rule> => rule !== undefined);
  return (relPath: string) => {
    let ignored = false;
    for (const rule of rules) {
      if (rule.test(relPath)) ignored = !rule.negated;
    }
    return ignored;
  };
}

describe("parseGitignoreLine / gitignore filtering", () => {
  test("basename patterns match at any depth", () => {
    const ignore = matcher(["*.log"]);
    expect(ignore("debug.log")).toBe(true);
    expect(ignore("logs/nested/debug.log")).toBe(true);
    expect(ignore("src/app.ts")).toBe(false);
  });

  test("directory patterns cover the directory and everything under it", () => {
    const ignore = matcher(["node_modules/"]);
    expect(ignore("node_modules")).toBe(true);
    expect(ignore("node_modules/pkg/index.js")).toBe(true);
    expect(ignore("src/node_modules-ish")).toBe(false);
  });

  test("anchored patterns (leading slash) match only at the root", () => {
    const ignore = matcher(["/build"]);
    expect(ignore("build")).toBe(true);
    expect(ignore("build/out.js")).toBe(true);
    expect(ignore("sub/build")).toBe(false);
  });

  test("negation overrides an earlier ignore (later match wins)", () => {
    const ignore = matcher(["*.log", "!keep.log"]);
    expect(ignore("debug.log")).toBe(true);
    expect(ignore("keep.log")).toBe(false);
  });

  test("comments and blank lines are skipped", () => {
    expect(parseGitignoreLine("# comment")).toBeUndefined();
    expect(parseGitignoreLine("   ")).toBeUndefined();
  });

  test("double-star globs work through the guard compiler", () => {
    const ignore = matcher(["**/generated/**"]);
    expect(ignore("src/generated/out.ts")).toBe(true);
    expect(ignore("src/handwritten.ts")).toBe(false);
  });
});

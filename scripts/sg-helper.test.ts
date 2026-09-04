import { describe, expect, test } from "bun:test";
import {
  buildSgArgs,
  EMPTY_CATCH_PATTERN,
  EMPTY_CATCH_PATTERNS,
  fallbackEmptyCatch,
  normalizeLang,
  SG_BINARIES,
  SG_LANGS,
  type SgMatch,
} from "./sg-helper.ts";

describe("sg-helper structural search (item 58)", () => {
  test("covers 25 ast-grep languages", () => {
    expect(SG_LANGS.length).toBe(25);
    for (const lang of ["typescript", "tsx", "python", "rust", "go", "ruby"] as const) {
      expect(SG_LANGS).toContain(lang);
    }
  });

  test("probes sg before ast-grep", () => {
    expect(SG_BINARIES[0]).toBe("sg");
    expect(SG_BINARIES).toContain("ast-grep");
  });

  test("empty-catch pattern is structural (metavariables), not an rg regex", () => {
    expect(EMPTY_CATCH_PATTERN).toBe("catch ($E) {}");
    expect(EMPTY_CATCH_PATTERN).toContain("$E");
    expect(EMPTY_CATCH_PATTERNS.c_like).toContain("$");
  });

  test("buildSgArgs emits scan --pattern --lang --json, never an rg line regex", () => {
    expect(buildSgArgs({ pattern: EMPTY_CATCH_PATTERN, lang: "typescript", path: "src" })).toEqual([
      "scan",
      "--pattern",
      "catch ($E) {}",
      "--lang",
      "typescript",
      "--json",
      "src",
    ]);
  });

  test("buildSgArgs supports --rewrite of the matched node", () => {
    const args = buildSgArgs({
      pattern: EMPTY_CATCH_PATTERN,
      lang: "typescript",
      path: "src",
      rewrite: "catch ($E) { console.error($E); }",
    });
    expect(args).toContain("--rewrite");
    expect(args).toContain("catch ($E) { console.error($E); }");
  });

  test("normalizeLang resolves ts/js/py aliases", () => {
    expect(normalizeLang("ts")).toBe("typescript");
    expect(normalizeLang("js")).toBe("javascript");
    expect(normalizeLang("py")).toBe("python");
    expect(normalizeLang("typescript")).toBe("typescript");
  });

  test("fallback finds the two empty catches in the fixture, not the logging one", () => {
    const matches = fallbackEmptyCatch("scripts/fixtures/sg-empty-catch.ts");
    expect(matches.length).toBe(2);
    expect(matches.map((m: SgMatch) => m.line)).toEqual([4, 11]);
  });
});

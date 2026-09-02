import { describe, expect, test } from "bun:test";
import { loadConfig } from "@agency/core";
import { createTheme, DEFAULT_PALETTE } from "../src/theme.ts";
import { getTheme, resolveTheme, THEMES, themeNames } from "../src/themes.ts";
import { Transcript } from "../src/transcript.ts";

describe("resolveTheme", () => {
  test("no name resolves to the default palette (createTheme's default)", () => {
    expect(resolveTheme().palette).toEqual(DEFAULT_PALETTE);
    expect(resolveTheme(undefined).palette).toEqual(DEFAULT_PALETTE);
    expect(resolveTheme("").palette).toEqual(DEFAULT_PALETTE);
  });

  test("a known name resolves to that theme's palette via getTheme", () => {
    expect(resolveTheme("high-contrast").palette).toEqual(THEMES["high-contrast"]!.palette);
    expect(resolveTheme("light").palette).toEqual(THEMES.light!.palette);
  });

  test("an unknown name degrades to the default palette instead of throwing", () => {
    expect(resolveTheme("no-such-theme").palette).toEqual(DEFAULT_PALETTE);
  });
});

describe("theme config key", () => {
  test("the config schema accepts a theme key and flags can select it", () => {
    const config = loadConfig({
      globalDir: "definitely-missing-dir",
      env: {},
      flags: { theme: "high-contrast" },
    });
    expect(config.theme).toBe("high-contrast");
    expect(resolveTheme(config.theme).palette.accent).toBe(37);
  });

  test("theme is optional: configs without it resolve to the default", () => {
    const config = loadConfig({ globalDir: "definitely-missing-dir", env: {} });
    expect(config.theme).toBeUndefined();
    expect(resolveTheme(config.theme).palette).toEqual(DEFAULT_PALETTE);
  });
});

describe("theme system wiring", () => {
  test("getTheme is reachable and every registered name resolves", () => {
    for (const name of themeNames()) {
      expect(getTheme(name)?.name).toBe(name);
      expect(resolveTheme(name).palette).toEqual(THEMES[name]!.palette);
    }
  });

  test("Transcript resolves themeName through resolveTheme when no theme is passed", () => {
    const expected = createTheme(THEMES["high-contrast"]!.palette).style("accent", "Tool: bash", true);
    const transcript = new Transcript({ themeName: "high-contrast", colorEnabled: true, width: 80 });
    transcript.consume({ type: "tool_start", id: "c1", name: "bash" });
    expect(transcript.frame()[0]).toBe(expected);
  });
});

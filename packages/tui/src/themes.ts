import { createTheme, DEFAULT_PALETTE, type Palette, type Theme } from "./theme.ts";

export interface ThemeDefinition {
  name: string;
  palette: Palette;
}

/** Light, dark, and high-contrast palettes. User-definable via config. */
export const THEMES: Record<string, ThemeDefinition> = {
  dark: {
    name: "dark",
    palette: { accent: 36, dim: 90, error: 31, success: 32, warning: 33 },
  },
  light: {
    name: "light",
    palette: { accent: 34, dim: 90, error: 31, success: 32, warning: 33 },
  },
  "high-contrast": {
    name: "high-contrast",
    palette: { accent: 37, dim: 37, error: 91, success: 92, warning: 93 },
  },
};

export function themeNames(): string[] {
  return Object.keys(THEMES).sort();
}

export function getTheme(name: string): ThemeDefinition | undefined {
  return THEMES[name];
}

/**
 * Builds the Theme a surface renders with from a config-selected name
 * (the "theme" config key). Unknown or absent names degrade to the default
 * palette rather than throwing: a typo in config must never take down the UI.
 */
export function resolveTheme(name?: string): Theme {
  const definition = name !== undefined && name !== "" ? getTheme(name) : undefined;
  return createTheme(definition?.palette ?? DEFAULT_PALETTE);
}

export type KeyBinding = string;

export interface KeybindEntry {
  command: string;
  binding: KeyBinding;
}

export interface KeybindPreset {
  name: string;
  bindings: Record<string, KeyBinding>;
}

const DEFAULT_BINDINGS: Record<string, KeyBinding> = {
  "thinking.toggle": "Ctrl+T",
  "thinking.expand": "Ctrl+Shift+T",
  "thinking.collapse": "Ctrl+Alt+T",
  "thinking.expandAll": "Ctrl+Shift+E",
  "thinking.collapseAll": "Ctrl+Shift+C",
  "models.open": "Ctrl+L",
  "models.save": "Ctrl+S",
  "models.cycle": "Ctrl+P",
  "palette.open": "Ctrl+K",
  "help.toggle": "?",
  "browser.open": "Ctrl+B",
  "diff.toggle": "Ctrl+D",
  "session.resume": "Enter",
  "app.quit": "Ctrl+C",
  "app.escape": "Esc",
};

const VIM_BINDINGS: Record<string, KeyBinding> = {
  ...DEFAULT_BINDINGS,
  "palette.open": "Space",
  "help.toggle": "?",
  "browser.open": "gb",
  "diff.toggle": "gd",
};

/**
 * Rebindable keybinds: every action is a named command with a binding,
 * conflicts detected, default and vim presets.
 */
export class KeybindRegistry {
  private bindings = new Map<string, KeyBinding>();
  private readonly presets: Record<string, KeybindPreset> = {
    default: { name: "default", bindings: DEFAULT_BINDINGS },
    vim: { name: "vim", bindings: VIM_BINDINGS },
  };

  constructor(initial: Record<string, KeyBinding> = DEFAULT_BINDINGS) {
    for (const [cmd, binding] of Object.entries(initial)) {
      this.bindings.set(cmd, binding);
    }
  }

  get(command: string): KeyBinding | undefined {
    return this.bindings.get(command);
  }

  set(command: string, binding: KeyBinding): void {
    this.bindings.set(command, binding);
  }

  delete(command: string): void {
    this.bindings.delete(command);
  }

  all(): KeybindEntry[] {
    return [...this.bindings.entries()]
      .map(([command, binding]) => ({ command, binding }))
      .sort((a, b) => a.command.localeCompare(b.command));
  }

  /** Returns conflicting pairs: same binding assigned to multiple commands. */
  conflicts(): Array<{ binding: KeyBinding; commands: string[] }> {
    const byBinding = new Map<KeyBinding, string[]>();
    for (const [cmd, binding] of this.bindings) {
      const list = byBinding.get(binding) ?? [];
      list.push(cmd);
      byBinding.set(binding, list);
    }
    const result: Array<{ binding: KeyBinding; commands: string[] }> = [];
    for (const [binding, commands] of byBinding) {
      if (commands.length > 1) result.push({ binding, commands: commands.sort() });
    }
    return result.sort((a, b) => a.binding.localeCompare(b.binding));
  }

  loadPreset(name: string): boolean {
    const preset = this.presets[name];
    if (!preset) return false;
    this.bindings.clear();
    for (const [cmd, binding] of Object.entries(preset.bindings)) {
      this.bindings.set(cmd, binding);
    }
    return true;
  }

  presetNames(): string[] {
    return Object.keys(this.presets).sort();
  }

  /** Merge per-project overrides, detecting conflicts after merge. */
  applyOverrides(overrides: Record<string, KeyBinding>): Array<{ binding: KeyBinding; commands: string[] }> {
    for (const [cmd, binding] of Object.entries(overrides)) {
      this.bindings.set(cmd, binding);
    }
    return this.conflicts();
  }
}

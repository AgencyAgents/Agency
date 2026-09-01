export interface PaletteCommand {
  name: string;
  description: string;
  binding?: string;
  run: () => void;
}

export interface PaletteEntry {
  command: PaletteCommand;
  score: number;
}

/**
 * Command palette: fuzzy over every command, session, and model.
 * Ctrl+K entrypoint, discoverable without docs.
 */
export class CommandPalette {
  private commands = new Map<string, PaletteCommand>();

  register(command: PaletteCommand): void {
    this.commands.set(command.name, command);
  }

  unregister(name: string): void {
    this.commands.delete(name);
  }

  all(): PaletteCommand[] {
    return [...this.commands.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Simple fuzzy: substring match scored by earliest occurrence. */
  search(query: string): PaletteEntry[] {
    const needle = query.trim().toLowerCase();
    if (needle === "") {
      return this.all().map((c) => ({ command: c, score: 0 }));
    }
    const results: PaletteEntry[] = [];
    for (const command of this.commands.values()) {
      const hay = `${command.name} ${command.description}`.toLowerCase();
      const idx = hay.indexOf(needle);
      if (idx === -1) continue;
      results.push({ command, score: idx });
    }
    results.sort((a, b) => a.score - b.score);
    return results;
  }

  execute(name: string): boolean {
    const cmd = this.commands.get(name);
    if (!cmd) return false;
    cmd.run();
    return true;
  }

  /** Frame for rendering: name + description + binding. */
  frame(query = ""): string[] {
    const entries = query ? this.search(query) : this.all().map((c) => ({ command: c, score: 0 }));
    if (entries.length === 0) return ["(no commands)"];
    return entries.map((e) => {
      const binding = e.command.binding ? ` [${e.command.binding}]` : "";
      return `${e.command.name}${binding} - ${e.command.description}`;
    });
  }
}

import type { Transcript } from "./transcript.ts";

/** Named commands for P6c keybind wiring (Ctrl+T and friends). Every action is
 * a name first: the keybind layer binds keys to these, never to methods. */
export type ThinkingCommandName =
  | "thinking.toggle"
  | "thinking.expand"
  | "thinking.collapse"
  | "thinking.expandAll"
  | "thinking.collapseAll";

export const THINKING_COMMAND_NAMES = [
  "thinking.toggle",
  "thinking.expand",
  "thinking.collapse",
  "thinking.expandAll",
  "thinking.collapseAll",
] as const;

export interface ThinkingCommandArgs {
  /** Targets a specific thinking block; omitted means the most recent one. */
  id?: string;
}

export type ThinkingCommand = (args?: ThinkingCommandArgs) => void;

/** Executes thinking-collapse commands against a Transcript. */
export class ThinkingController {
  private readonly transcript: Transcript;

  constructor(transcript: Transcript) {
    this.transcript = transcript;
  }

  execute(name: ThinkingCommandName, args?: ThinkingCommandArgs): void {
    this.commands()[name](args);
  }

  /** The full command surface, keyed by name for the rebindable-keybind registry. */
  commands(): Record<ThinkingCommandName, ThinkingCommand> {
    return {
      "thinking.toggle": (args) => this.transcript.toggleThinking(args?.id),
      "thinking.expand": (args) => this.transcript.expandThinking(args?.id),
      "thinking.collapse": (args) => this.transcript.collapseThinking(args?.id),
      "thinking.expandAll": () => this.transcript.expandAllThinking(),
      "thinking.collapseAll": () => this.transcript.collapseAllThinking(),
    };
  }
}

import type { LoopEvent } from "@agency/core";
import { t } from "@agency/i18n";
import { reflow } from "./renderer.ts";
import { createTheme, type RenderMode, type StyleKind, type Theme } from "./theme.ts";

/**
 * Structural subset of the tools' ToolSpec the transcript renders with (R3
 * delegation): a tool owns its presentation when it ships renderCall or
 * renderResult; anything else falls back to a one-line summary.
 */
export interface ToolPresentation {
  name: string;
  renderCall?: (input: Record<string, unknown>) => string;
  renderResult?: (result: { content: string; isError?: boolean }) => string;
}

export interface TranscriptOptions {
  theme?: Theme;
  mode?: RenderMode;
  colorEnabled?: boolean;
  width?: number;
  tools?: ToolPresentation[];
}

/** Extra per-event context the RPC layer fills in (LoopEvent itself carries no tool input). */
export interface EventContext {
  toolInput?: Record<string, unknown>;
}

interface TextBlock {
  kind: "text";
  text: string;
}

interface ThinkingBlock {
  kind: "thinking";
  id: string;
  text: string;
  collapsed: boolean;
}

interface ToolBlock {
  kind: "tool";
  id: string;
  name: string;
  input?: Record<string, unknown>;
  result?: { content: string; isError: boolean };
}

interface StatusBlock {
  kind: "status";
  style: StyleKind;
  text: string;
}

type Block = TextBlock | ThinkingBlock | ToolBlock | StatusBlock;

const STOP_STYLES: Record<string, StyleKind> = {
  end_turn: "success",
  stop_sequence: "success",
  tool_use: "accent",
  max_tokens: "warning",
  cancelled: "warning",
  error: "error",
};

/**
 * Consumes the LoopEvent stream and turns it into paintable frames: streaming
 * text, collapsible thinking blocks (collapsed by default, progressive
 * disclosure), tool calls delegated to their ToolSpec renderers, and turn
 * status lines. Pure state plus frame(): the DifferentialRenderer owns pixels.
 */
export class Transcript {
  private readonly theme: Theme;
  private readonly mode: RenderMode;
  private readonly colorEnabled: boolean;
  private readonly width: number;
  private readonly toolByName = new Map<string, ToolPresentation>();
  private blocks: Block[] = [];
  private nextId = 0;

  constructor(options: TranscriptOptions = {}) {
    this.theme = options.theme ?? createTheme();
    this.mode = options.mode ?? "tty";
    this.colorEnabled = options.colorEnabled ?? true;
    this.width = options.width ?? 80;
    for (const tool of options.tools ?? []) this.toolByName.set(tool.name, tool);
  }

  /** Applies one loop event, updating the transcript state. */
  consume(event: LoopEvent, context?: EventContext): void {
    switch (event.type) {
      case "text_delta": {
        this.appendText(event.text);
        break;
      }
      case "thinking_delta": {
        this.appendThinking(event.text);
        break;
      }
      case "tool_start": {
        this.blocks.push({
          kind: "tool",
          id: event.id,
          name: event.name,
          input: context?.toolInput,
        });
        break;
      }
      case "tool_result": {
        const block = this.blocks.find((b): b is ToolBlock => b.kind === "tool" && b.id === event.id);
        if (block) block.result = { content: event.content, isError: event.isError };
        break;
      }
      case "turn_complete": {
        const tokens = event.usage.inputTokens + event.usage.outputTokens;
        this.blocks.push({
          kind: "status",
          style: STOP_STYLES[event.stopReason] ?? "accent",
          text: t("tui.turn.complete", { reason: event.stopReason, tokens }),
        });
        break;
      }
      case "budget_exceeded": {
        this.blocks.push({
          kind: "status",
          style: "warning",
          text: t("tui.budget.exceeded", { tokens: event.spentTokens, cost: event.spentCostUsd }),
        });
        break;
      }
    }
  }

  /** The current frame: styled, reflowed lines ready for DifferentialRenderer.paint. */
  frame(): string[] {
    const lines: string[] = [];
    for (const block of this.blocks) {
      switch (block.kind) {
        case "text": {
          lines.push(...this.wrapPlain(block.text));
          break;
        }
        case "thinking": {
          if (block.collapsed) {
            lines.push(this.styled("dim", t("tui.thinking.collapsed", { chars: block.text.length })));
          } else {
            lines.push(this.styled("dim", t("tui.thinking.label")));
            lines.push(...this.wrapStyled(block.text, "dim"));
          }
          break;
        }
        case "tool": {
          if (block.result === undefined) {
            lines.push(this.styled("accent", this.callText(block)));
          } else {
            const style: StyleKind = block.result.isError ? "error" : "success";
            lines.push(this.styled(style, this.resultText(block)));
          }
          break;
        }
        case "status": {
          lines.push(this.styled(block.style, block.text));
          break;
        }
      }
    }
    return lines;
  }

  // Thinking collapse API (driven by ThinkingController / P6c keybinds).

  toggleThinking(id?: string): void {
    const block = this.thinkingBlock(id);
    if (block) block.collapsed = !block.collapsed;
  }

  expandThinking(id?: string): void {
    const block = this.thinkingBlock(id);
    if (block) block.collapsed = false;
  }

  collapseThinking(id?: string): void {
    const block = this.thinkingBlock(id);
    if (block) block.collapsed = true;
  }

  expandAllThinking(): void {
    for (const block of this.blocks) {
      if (block.kind === "thinking") block.collapsed = false;
    }
  }

  collapseAllThinking(): void {
    for (const block of this.blocks) {
      if (block.kind === "thinking") block.collapsed = true;
    }
  }

  /** Thinking block ids in stream order, for callers targeting a specific block. */
  thinkingIds(): string[] {
    return this.blocks.filter((b): b is ThinkingBlock => b.kind === "thinking").map((b) => b.id);
  }

  /** Whether a thinking block is collapsed; unknown ids report false. */
  isThinkingCollapsed(id: string): boolean {
    const block = this.blocks.find((b): b is ThinkingBlock => b.kind === "thinking" && b.id === id);
    return block?.collapsed ?? false;
  }

  private appendText(text: string): void {
    const last = this.blocks[this.blocks.length - 1];
    if (last?.kind === "text") {
      last.text += text;
      return;
    }
    this.blocks.push({ kind: "text", text });
  }

  private appendThinking(text: string): void {
    const last = this.blocks[this.blocks.length - 1];
    if (last?.kind === "thinking") {
      last.text += text;
      return;
    }
    this.blocks.push({ kind: "thinking", id: this.freshId("th"), text, collapsed: true });
  }

  private thinkingBlock(id?: string): ThinkingBlock | undefined {
    const thinking = this.blocks.filter((b): b is ThinkingBlock => b.kind === "thinking");
    if (thinking.length === 0) return undefined;
    if (id === undefined) return thinking[thinking.length - 1];
    return thinking.find((b) => b.id === id);
  }

  private callText(block: ToolBlock): string {
    const tool = this.toolByName.get(block.name);
    if (tool?.renderCall && block.input !== undefined) {
      return tool.renderCall(block.input);
    }
    return t("tui.tool.call", { name: block.name });
  }

  private resultText(block: ToolBlock): string {
    const tool = this.toolByName.get(block.name);
    if (tool?.renderResult && block.result) {
      return tool.renderResult(block.result);
    }
    if (block.result?.isError) return t("tui.tool.error", { name: block.name });
    return t("tui.tool.result", { name: block.name });
  }

  /** One style-aware line (screen-reader mode swaps glyphs and color for spoken words). */
  private styled(kind: StyleKind, text: string): string {
    if (this.mode === "screen-reader") return this.theme.styledWord(kind, text);
    return this.theme.style(kind, text, this.colorEnabled);
  }

  private wrapPlain(text: string): string[] {
    return reflow(text, this.width).split("\n");
  }

  /** Reflows raw text first, then styles each line so ANSI never skews width math. */
  private wrapStyled(text: string, kind: StyleKind): string[] {
    return reflow(text, this.width)
      .split("\n")
      .map((line) => this.styled(kind, line));
  }

  private freshId(prefix: string): string {
    this.nextId += 1;
    return `${prefix}${this.nextId}`;
  }
}

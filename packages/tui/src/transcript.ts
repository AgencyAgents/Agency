import type { LoopEvent } from "@agency/core";
import { t } from "@agency/i18n";
import { reflow } from "./renderer.ts";
import { type RenderMode, type StyleKind, type Theme } from "./theme.ts";
import { resolveTheme } from "./themes.ts";
import { formatErrorState, getErrorState } from "./error-states.ts";

/**
 * Structural subset of the tools' ToolSpec the transcript renders with (R3
 * delegation): a tool owns its presentation when it ships renderCall or
 * renderResult; anything else falls back to a one-line summary.
 */
export interface ToolPresentation {
  name: string;
  renderCall?: (input: Record<string, unknown>) => string;
  renderResult?: (result: {
    content: string;
    isError?: boolean;
    /** The call's arguments, when the wire event carried them. */
    input?: Record<string, unknown>;
  }) => string;
}

export interface TranscriptOptions {
  theme?: Theme;
  /** Resolved via resolveTheme (getTheme + config "theme" key) when `theme` is omitted. */
  themeName?: string;
  mode?: RenderMode;
  colorEnabled?: boolean;
  width?: number;
  tools?: ToolPresentation[];
  /** Scrollback cap: oldest blocks are dropped beyond this. Default 1000. */
  maxBlocks?: number;
}

/**
 * Extra per-event context the RPC layer fills in (LoopEvent itself carries no
 * tool input on older daemons). The daemon's broadcasts now include the parsed
 * call arguments on every `tool_start` payload; `eventContextOf` extracts them
 * into this shape, and an explicit context wins over the event's own field.
 */
export interface EventContext {
  toolInput?: Record<string, unknown>;
}

interface TextBlock {
  kind: "text";
  text: string;
  rendered?: string[];
}

interface ThinkingBlock {
  kind: "thinking";
  id: string;
  text: string;
  collapsed: boolean;
  rendered?: string[];
}

interface ToolBlock {
  kind: "tool";
  id: string;
  name: string;
  input?: Record<string, unknown>;
  result?: { content: string; isError: boolean };
  startedAt: number;
  rendered?: string[];
}

interface StatusBlock {
  kind: "status";
  style: StyleKind;
  text: string;
  rendered?: string[];
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

const DEFAULT_MAX_BLOCKS = 1000;
const MAX_BLOCK_CHARS = 100_000;

function capBlockText(text: string): string {
  return text.length > MAX_BLOCK_CHARS ? text.slice(-MAX_BLOCK_CHARS) : text;
}

/**
 * Consumes the LoopEvent stream and turns it into paintable frames: streaming
 * text, collapsible thinking blocks (collapsed by default, progressive
 * disclosure), tool calls delegated to their ToolSpec renderers, and turn
 * status lines. Pure state plus frame(): the DifferentialRenderer owns pixels.
 *
 * Frames are built incrementally: each block caches its rendered lines and is
 * re-rendered only after a mutation marks it dirty, so a repaint during token
 * streaming re-wraps the one changed block instead of the whole transcript.
 * Scrollback is capped (oldest blocks dropped) and a single block's text is
 * capped too, so neither memory nor frame size grow without bound.
 */
export class Transcript {
  private readonly theme: Theme;
  private readonly mode: RenderMode;
  private readonly colorEnabled: boolean;
  private readonly width: number;
  private readonly maxBlocks: number;
  private readonly toolByName = new Map<string, ToolPresentation>();
  private blocks: Block[] = [];
  private nextId = 0;

  constructor(options: TranscriptOptions = {}) {
    this.theme = options.theme ?? resolveTheme(options.themeName);
    this.mode = options.mode ?? "tty";
    this.colorEnabled = options.colorEnabled ?? true;
    this.width = options.width ?? 80;
    this.maxBlocks = Math.max(1, options.maxBlocks ?? DEFAULT_MAX_BLOCKS);
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
        this.pushBlock({
          kind: "tool",
          id: event.id,
          name: event.name,
          input: context?.toolInput ?? event.input,
          startedAt: Date.now(),
        });
        break;
      }
      case "tool_result": {
        const block = this.blocks.find((b): b is ToolBlock => b.kind === "tool" && b.id === event.id);
        if (block) {
          if (block.input === undefined) block.input = context?.toolInput;
          block.result = { content: event.content, isError: event.isError };
          block.rendered = undefined;
        }
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
      case "error": {
        const state = getErrorState(event.code);
        if (state) {
          const formatted = formatErrorState(event.code, event.message);
          this.blocks.push({
            kind: "status",
            style: formatted.style,
            text: formatted.text,
          });
        } else {
          this.blocks.push({
            kind: "status",
            style: "error",
            text: t("tui.error.message", { code: event.code, message: event.message }),
          });
        }
        break;
      }
      case "retry": {
        let text = t("tui.retry.message", { attempt: event.attempt, message: event.message });
        if (event.next !== undefined) {
          text += t("tui.retry.next", { next: new Date(event.next).toLocaleTimeString() });
        }
        this.blocks.push({
          kind: "status",
          style: "warning",
          text,
        });
        break;
      }
    }
  }

  /** The current frame: styled, reflowed lines ready for DifferentialRenderer.paint. */
  frame(): string[] {
    const out: string[] = [];
    for (const block of this.blocks) {
      let rendered = block.rendered;
      if (rendered === undefined) {
        rendered = this.renderBlock(block);
        block.rendered = rendered;
      }
      for (const line of rendered) out.push(line);
    }
    return out;
  }

  private renderBlock(block: Block): string[] {
    switch (block.kind) {
      case "text": {
        return this.wrapPlain(block.text);
      }
      case "thinking": {
        if (block.collapsed) {
          return [this.styled("dim", t("tui.thinking.collapsed", { chars: block.text.length }))];
        }
        return [this.styled("dim", t("tui.thinking.label")), ...this.wrapStyled(block.text, "dim")];
      }
      case "tool": {
        if (block.result === undefined) {
          const elapsed = Math.max(0, Math.floor((Date.now() - block.startedAt) / 1000));
          const label = elapsed >= 1 ? `${this.callText(block)}  ${elapsed}s` : this.callText(block);
          return [this.styled("accent", label)];
        }
        const style: StyleKind = block.result.isError ? "error" : "success";
        return [this.styled(style, this.resultText(block))];
      }
      case "status": {
        return [this.styled(block.style, block.text)];
      }
    }
  }

  // Thinking collapse API (driven by ThinkingController / P6c keybinds).

  toggleThinking(id?: string): void {
    const block = this.thinkingBlock(id);
    if (block) {
      block.collapsed = !block.collapsed;
      block.rendered = undefined;
    }
  }

  expandThinking(id?: string): void {
    const block = this.thinkingBlock(id);
    if (block) {
      block.collapsed = false;
      block.rendered = undefined;
    }
  }

  collapseThinking(id?: string): void {
    const block = this.thinkingBlock(id);
    if (block) {
      block.collapsed = true;
      block.rendered = undefined;
    }
  }

  expandAllThinking(): void {
    for (const block of this.blocks) {
      if (block.kind === "thinking") {
        block.collapsed = false;
        block.rendered = undefined;
      }
    }
  }

  collapseAllThinking(): void {
    for (const block of this.blocks) {
      if (block.kind === "thinking") {
        block.collapsed = true;
        block.rendered = undefined;
      }
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
      last.text = capBlockText(last.text + text);
      last.rendered = undefined;
      return;
    }
    this.pushBlock({ kind: "text", text: capBlockText(text) });
  }

  private appendThinking(text: string): void {
    const last = this.blocks[this.blocks.length - 1];
    if (last?.kind === "thinking") {
      last.text = capBlockText(last.text + text);
      last.rendered = undefined;
      return;
    }
    this.pushBlock({ kind: "thinking", id: this.freshId("th"), text: capBlockText(text), collapsed: true });
  }

  private pushBlock(block: Block): void {
    this.blocks.push(block);
    if (this.blocks.length > this.maxBlocks) {
      this.blocks.splice(0, this.blocks.length - this.maxBlocks);
    }
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
      return tool.renderResult({ ...block.result, input: block.input });
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

/**
 * Extracts the per-event context the RPC layer supplies from a broadcast
 * LoopEvent: the loop includes the parsed tool input on every tool_start, and
 * this turns that payload into EventContext.toolInput for Transcript.consume.
 */
export function eventContextOf(event: LoopEvent): EventContext | undefined {
  if (event.type === "tool_start" && event.input !== undefined) {
    return { toolInput: event.input };
  }
  return undefined;
}

/** consume() for events straight off the daemon wire (see eventContextOf). */
export function consumeRpcEvent(transcript: Transcript, event: LoopEvent): void {
  transcript.consume(event, eventContextOf(event));
}

/**
 * Adapter from tool specs (which own their presentation per R3) to the
 * structural subset the Transcript renders with. ToolSpec renderers take
 * narrower typed params than this loose subset allows, so the widening cast
 * is contained here.
 */
export function toolPresentations(specs: Iterable<{ name: string }>): ToolPresentation[] {
  const out: ToolPresentation[] = [];
  for (const spec of specs) {
    const source = spec as unknown as Partial<ToolPresentation>;
    out.push({
      name: spec.name,
      renderCall: source.renderCall,
      renderResult: source.renderResult,
    });
  }
  return out;
}

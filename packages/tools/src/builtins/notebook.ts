import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { requirePathScope } from "@agency/guard";
import type { ToolDeps, ToolSpec } from "../contract.ts";
import type { ReadState } from "../read-state.ts";
import { str, summarize } from "../render.ts";
import type { SnapshotStore } from "../snapshot.ts";

interface Cell {
  cell_type: string;
  id?: string;
  source: string | string[];
  outputs?: Array<Record<string, unknown>>;
  execution_count?: number | null;
  metadata?: Record<string, unknown>;
}
interface Notebook {
  cells: Cell[];
  nbformat?: number;
  nbformat_minor?: number;
}

const MAX_OUTPUT_CHARS = 2_000;
const text = (value: unknown): string =>
  Array.isArray(value) ? value.join("") : typeof value === "string" ? value : "";
const clip = (value: string): string =>
  value.length > MAX_OUTPUT_CHARS
    ? `${value.slice(0, MAX_OUTPUT_CHARS)}\n[output cut at ${MAX_OUTPUT_CHARS} characters]`
    : value;

function parseNotebook(raw: string): Notebook {
  const notebook = JSON.parse(raw) as Notebook;
  if (!Array.isArray(notebook?.cells)) throw new Error("not a Jupyter notebook: it has no cells");
  return notebook;
}

/** The text of one output of a code cell; an image or another rich output is named only. */
function outputText(output: Record<string, unknown>): string {
  if (output.output_type === "stream") return text(output.text);
  if (output.output_type === "error") return `${String(output.ename)}: ${String(output.evalue)}`;
  const data = (output.data ?? {}) as Record<string, unknown>;
  if (data["text/plain"] !== undefined) return text(data["text/plain"]);
  return Object.keys(data)
    .map((mime) => `[${mime} output]`)
    .join(" ");
}

/** A notebook as the model reads it: each cell with its number, type and id, its source and the text of its outputs. */
export function renderNotebook(raw: string): string {
  const notebook = parseNotebook(raw);
  return notebook.cells
    .map((cell, index) => {
      const head = `--- cell ${index} (${cell.cell_type}${cell.id ? `, id ${cell.id}` : ""}) ---`;
      const outputs = (cell.outputs ?? []).map(outputText).filter((out) => out.trim() !== "");
      const tail = outputs.length > 0 ? `\n--- output of cell ${index} ---\n${clip(outputs.join("\n"))}` : "";
      return `${head}\n${text(cell.source)}${tail}`;
    })
    .join("\n\n");
}

/** Jupyter keeps a source as lines that end with their line break. */
const sourceLines = (source: string): string[] => source.split(/(?<=\n)/).filter((line) => line !== "");

export function createNotebookEditTool(
  deps: ToolDeps,
  snapshots: SnapshotStore,
  readState?: ReadState,
): ToolSpec {
  const spec: ToolSpec<{ path: string; cell?: string; source?: string; cell_type?: string; mode?: string }> =
    {
      name: "notebook_edit",
      description:
        "Edits one cell of a Jupyter notebook (.ipynb). mode replace (the default) sets the source of a cell and clears its outputs; insert adds a new cell after the cell (or at the start when cell is absent); delete removes the cell. cell is the number of the cell, as read shows it, or its id.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          cell: {
            type: "string",
            description: "The id of the cell, or its number (from 0) as read shows it.",
          },
          source: { type: "string", description: "The new source of the cell (replace, insert)." },
          cell_type: {
            type: "string",
            enum: ["code", "markdown"],
            description: "insert: the type of the new cell.",
          },
          mode: { type: "string", enum: ["replace", "insert", "delete"] },
        },
        required: ["path"],
      },
      riskTier: "moderate",
      renderCall: (input) =>
        `notebook_edit ${str(input.path)} ${input.mode ?? "replace"} ${String(input.cell ?? "")}`,
      renderResult: (result) =>
        result.isError ? `notebook_edit failed: ${summarize(result.content)}` : summarize(result.content),

      async handler(input, ctx) {
        const resolved = await deps.sandbox.resolvePathGated(input.path, {
          tool: "notebook_edit",
          ask: ctx.requestApproval,
        });
        requirePathScope(deps.identity, deps.capabilities, resolved);
        const fail = (content: string) => ({ content, isError: true as const });
        if (!resolved.toLowerCase().endsWith(".ipynb"))
          return fail("notebook_edit edits .ipynb files only: use edit");
        const raw = readFileSync(resolved, "utf8");
        let notebook: Notebook;
        try {
          notebook = parseNotebook(raw);
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
        const mode = input.mode ?? "replace";
        // An id first: a cell id can be all digits too.
        const cellKey = input.cell === undefined ? undefined : String(input.cell);
        const byId = notebook.cells.findIndex((cell) => cell.id === cellKey);
        const index =
          cellKey === undefined ? undefined : byId >= 0 ? byId : /^\d+$/.test(cellKey) ? Number(cellKey) : -1;
        const found = index !== undefined && index >= 0 && index < notebook.cells.length;
        if (mode !== "insert" && !found)
          return fail(`no cell ${String(input.cell)}: the notebook has ${notebook.cells.length} cells`);
        if (mode === "insert" && input.cell !== undefined && !found)
          return fail(`no cell ${String(input.cell)} to insert after`);
        if (mode !== "delete" && typeof input.source !== "string") return fail("source is required");

        if (mode === "delete") notebook.cells.splice(index as number, 1);
        else if (mode === "insert") {
          const type = input.cell_type === "markdown" ? "markdown" : "code";
          const cell: Cell = {
            cell_type: type,
            // nbformat 4.5 gives each cell an id.
            ...((notebook.nbformat ?? 4) > 4 || (notebook.nbformat_minor ?? 0) >= 5
              ? { id: randomBytes(4).toString("hex") }
              : {}),
            metadata: {},
            source: sourceLines(input.source as string),
            ...(type === "code" ? { execution_count: null, outputs: [] } : {}),
          };
          notebook.cells.splice(index === undefined ? 0 : (index as number) + 1, 0, cell);
        } else {
          const cell = notebook.cells[index as number] as Cell;
          cell.source = sourceLines(input.source as string);
          // The outputs of the old source would mislead.
          if (cell.cell_type === "code") {
            cell.outputs = [];
            cell.execution_count = null;
          }
        }
        snapshots.capture(resolved, raw, ctx.turnId);
        writeFileSync(resolved, `${JSON.stringify(notebook, null, 1)}\n`, "utf8");
        snapshots.recordAfter(resolved);
        readState?.mark(resolved);
        return { content: `${mode} done: ${input.path} has ${notebook.cells.length} cells.` };
      },
    };
  return spec;
}

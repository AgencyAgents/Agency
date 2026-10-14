import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FULL_CAPABILITIES, SandboxBoundary } from "@agency/guard";
import { createNotebookEditTool } from "../../src/builtins/notebook.ts";
import { createReadTool } from "../../src/builtins/read.ts";
import type { ToolDeps } from "../../src/contract.ts";
import { SnapshotStore } from "../../src/snapshot.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const signal = new AbortController().signal;

function setup() {
  const root = mkdtempSync(join(tmpdir(), "agency-notebook-"));
  dirs.push(root);
  const deps: ToolDeps = {
    identity: { type: "user" },
    capabilities: { ...FULL_CAPABILITIES, pathScopes: [root] },
    sandbox: new SandboxBoundary(root),
  };
  const notebook = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: [
      { cell_type: "markdown", id: "intro", metadata: {}, source: ["# Title\n", "Some text"] },
      {
        cell_type: "code",
        id: "c2",
        execution_count: 3,
        metadata: {},
        source: ["x = 1\n", "x + 1"],
        outputs: [
          { output_type: "stream", name: "stdout", text: ["hello\n"] },
          { output_type: "execute_result", execution_count: 3, data: { "text/plain": ["2"] }, metadata: {} },
          { output_type: "display_data", data: { "image/png": "iVBOR" }, metadata: {} },
        ],
      },
    ],
  };
  const file = join(root, "nb.ipynb");
  writeFileSync(file, JSON.stringify(notebook));
  const read = createReadTool(deps);
  const edit = createNotebookEditTool(deps, new SnapshotStore(join(root, ".snapshots")));
  return { root, file, read, edit };
}

test("read shows a notebook as its cells and the text of their outputs", async () => {
  const { read } = setup();
  const { content } = await read.handler({ path: "nb.ipynb" }, { signal });
  expect(content).toBe(
    [
      "--- cell 0 (markdown, id intro) ---",
      "# Title",
      "Some text",
      "",
      "--- cell 1 (code, id c2) ---",
      "x = 1",
      "x + 1",
      "--- output of cell 1 ---",
      "hello",
      "",
      "2",
      "[image/png output]",
    ].join("\n"),
  );
});

test("notebook_edit replaces, inserts and deletes cells, and keeps the notebook valid", async () => {
  const { file, edit } = setup();
  const call = (input: Record<string, unknown>) => edit.handler(input, { signal });
  expect((await call({ path: "nb.ipynb", cell: "1", source: "y = 2\nprint(y)" })).content).toContain(
    "2 cells",
  );
  let nb = JSON.parse(readFileSync(file, "utf8"));
  expect(nb.cells[1]).toMatchObject({
    id: "c2",
    source: ["y = 2\n", "print(y)"],
    outputs: [],
    execution_count: null,
  });

  await call({ path: "nb.ipynb", mode: "insert", cell: "intro", cell_type: "markdown", source: "## Part" });
  nb = JSON.parse(readFileSync(file, "utf8"));
  expect(nb.cells.map((c: { cell_type: string }) => c.cell_type)).toEqual(["markdown", "markdown", "code"]);
  expect(nb.cells[1].id).toMatch(/^[0-9a-f]{8}$/);
  expect(nb.cells[1].outputs).toBeUndefined();

  await call({ path: "nb.ipynb", mode: "insert", source: "import os" });
  nb = JSON.parse(readFileSync(file, "utf8"));
  expect(nb.cells[0]).toMatchObject({ cell_type: "code", source: ["import os"], outputs: [] });

  await call({ path: "nb.ipynb", mode: "delete", cell: "c2" });
  nb = JSON.parse(readFileSync(file, "utf8"));
  expect(nb.cells).toHaveLength(3);
  expect(nb.nbformat).toBe(4);

  expect((await call({ path: "nb.ipynb", cell: "9", source: "x" })).isError).toBe(true);
  expect((await call({ path: "nb.ipynb", cell: "0" })).isError).toBe(true);
  writeFileSync(file.replace("nb.ipynb", "a.py"), "x");
  expect((await call({ path: "a.py", cell: "0", source: "y" })).isError).toBe(true);
});

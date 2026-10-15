import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FULL_CAPABILITIES, SandboxBoundary } from "@agency/guard";
import { createEditTool } from "../src/builtins/edit.ts";
import { SnapshotStore } from "../src/snapshot.ts";
import { syntaxError, syntaxNote } from "../src/syntax.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("syntaxError parses TS, TSX and JSON, and says nothing of a language it has no parser for", () => {
  expect(syntaxError("a.ts", "export const x: number = 1;")).toBeUndefined();
  expect(syntaxError("a.tsx", "const a = <div>hi</div>;")).toBeUndefined();
  expect(syntaxError("a.ts", "const a = 1;\nexport function f( {\n")).toStartWith("2: ");
  expect(syntaxError("a.json", '{"a": 1,}')).toBeDefined();
  expect(syntaxError("a.rb", "def (")).toBeUndefined();
  // A file broken before the change gets no note: tsconfig.json with comments does not parse as JSON.
  expect(syntaxNote("tsconfig.json", "{ // c\n}", "{ // c\n,}")).toBeUndefined();
});

test("an edit that breaks the parse of a file says so in its result", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agency-syntax-")));
  dirs.push(root);
  writeFileSync(join(root, "a.ts"), "export function f() {\n  return 1;\n}\n");
  const edit = createEditTool(
    {
      identity: { type: "user" },
      capabilities: { ...FULL_CAPABILITIES, pathScopes: [root] },
      sandbox: new SandboxBoundary(root),
    },
    new SnapshotStore(join(root, ".snapshots")),
    {},
  );
  const signal = new AbortController().signal;
  const ok = await edit.handler({ path: "a.ts", oldText: "return 1;", newText: "return 2;" }, { signal });
  expect(ok.content).not.toContain("syntax error");
  const broken = await edit.handler(
    { path: "a.ts", oldText: "return 2;\n}", newText: "return 2;" },
    { signal },
  );
  expect(broken.content).toContain("a.ts with a syntax error");
});

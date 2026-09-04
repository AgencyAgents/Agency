import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FULL_CAPABILITIES, SandboxBoundary } from "@agency/guard";
import { createGlobTool } from "../../src/builtins/glob.ts";
import type { ToolDeps } from "../../src/contract.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const signal = new AbortController().signal;

describe("glob: gitignore + mtime sort (A6)", () => {
  test("respects the search root's .gitignore and never lists .git", async () => {
    const root = mkdtempSync(join(tmpdir(), "agency-glob-ignore-"));
    dirs.push(root);
    writeFileSync(join(root, ".gitignore"), "dist/\n*.log\n");
    mkdirSync(join(root, "dist"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "dist", "out.js"), "");
    writeFileSync(join(root, "debug.log"), "");
    writeFileSync(join(root, "src", "app.ts"), "");
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "HEAD"), "");

    const deps: ToolDeps = {
      identity: { type: "user" },
      capabilities: FULL_CAPABILITIES,
      sandbox: new SandboxBoundary(root),
    };
    const tool = createGlobTool(deps);
    const result = await tool.handler({ pattern: "**/*" }, { signal });

    expect(result.content).toContain("src/app.ts");
    expect(result.content).not.toContain("dist/out.js");
    expect(result.content).not.toContain("debug.log");
    expect(result.content).not.toContain(".git");
  });

  test("sorts newest first", async () => {
    const root = mkdtempSync(join(tmpdir(), "agency-glob-mtime-"));
    dirs.push(root);
    const { utimesSync } = await import("node:fs");
    const base = new Date(Date.now() - 4_000);
    const later = new Date(Date.now() - 2_000);
    const newest = new Date();
    writeFileSync(join(root, "old.ts"), "");
    utimesSync(join(root, "old.ts"), base, base);
    writeFileSync(join(root, "mid.ts"), "");
    utimesSync(join(root, "mid.ts"), later, later);
    writeFileSync(join(root, "new.ts"), "");
    utimesSync(join(root, "new.ts"), newest, newest);

    const deps: ToolDeps = {
      identity: { type: "user" },
      capabilities: FULL_CAPABILITIES,
      sandbox: new SandboxBoundary(root),
    };
    const tool = createGlobTool(deps);
    const result = await tool.handler({ pattern: "*.ts" }, { signal });
    const order = result.content.split("\n");
    expect(order.indexOf("new.ts")).toBeLessThan(order.indexOf("mid.ts"));
    expect(order.indexOf("mid.ts")).toBeLessThan(order.indexOf("old.ts"));
  });
});

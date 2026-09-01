import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FULL_CAPABILITIES, SandboxBoundary } from "@agency/guard";
import { createReadTool, imageMimeFor } from "../../src/builtins/read.ts";
import type { ToolDeps } from "../../src/contract.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDeps(): { deps: ToolDeps; root: string } {
  const root = mkdtempSync(join(tmpdir(), "agency-read-test-"));
  dirs.push(root);
  const capabilities = { ...FULL_CAPABILITIES, pathScopes: [root] };
  return { deps: { identity: { type: "user" }, capabilities, sandbox: new SandboxBoundary(root) }, root };
}

const signal = new AbortController().signal;

describe("createReadTool", () => {
  test("reads a file's exact content", async () => {
    const { deps, root } = tempDeps();
    writeFileSync(join(root, "a.ts"), "export const x = 1;\n");

    const tool = createReadTool(deps);
    const result = await tool.handler({ path: "a.ts" }, { signal });

    expect(result.content).toBe("export const x = 1;\n");
    expect(result.isError).toBeFalsy();
  });

  test("rejects a path outside the sandbox root", async () => {
    const { deps } = tempDeps();
    const tool = createReadTool(deps);
    await expect(tool.handler({ path: "../../etc/passwd" }, { signal })).rejects.toThrow();
  });

  test("refuses to read a file over the size limit, suggesting grep instead", async () => {
    const { deps, root } = tempDeps();
    writeFileSync(join(root, "huge.txt"), "x".repeat(1_000_001));

    const tool = createReadTool(deps);
    const result = await tool.handler({ path: "huge.txt" }, { signal });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("grep");
  });

  test("attaches png/jpg/webp files as base64 ImageBlocks", async () => {
    const { deps, root } = tempDeps();
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    writeFileSync(join(root, "shot.png"), bytes);
    writeFileSync(join(root, "photo.jpg"), Buffer.from([0xff, 0xd8, 0xff]));
    writeFileSync(join(root, "pic.webp"), Buffer.from("RIFF"));

    const tool = createReadTool(deps);

    const png = await tool.handler({ path: "shot.png" }, { signal });
    expect(png.content).toContain("image/png");
    expect(png.images).toEqual([{ type: "image", mimeType: "image/png", data: bytes.toString("base64") }]);

    const jpg = await tool.handler({ path: "photo.jpg" }, { signal });
    expect(jpg.images?.[0]?.mimeType).toBe("image/jpeg");

    const webp = await tool.handler({ path: "pic.webp" }, { signal });
    expect(webp.images?.[0]?.mimeType).toBe("image/webp");
  });

  test("uppercase extensions and .jpeg map too; unknown extensions stay text", async () => {
    expect(imageMimeFor("A.PNG")).toBe("image/png");
    expect(imageMimeFor("a.JPEG")).toBe("image/jpeg");
    expect(imageMimeFor("a.txt")).toBeUndefined();
    expect(imageMimeFor("noext")).toBeUndefined();

    const { deps, root } = tempDeps();
    writeFileSync(join(root, "data.bin"), Buffer.from([0, 1, 2]));
    const tool = createReadTool(deps);
    const result = await tool.handler({ path: "data.bin" }, { signal });
    expect(result.images).toBeUndefined();
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileTrustStore } from "@agency/guard";
import {
  AGENTS_MD_TEMPLATE,
  discoverInitDeepDirs,
  generateAgentsMd,
  initDeep,
  renderAgentsTemplate,
} from "../../src/prompt/init-deep.ts";
import { collectAgentsFiles, loadInstructions } from "../../src/prompt/instructions.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(): string {
  const root = mkdtempSync(join(tmpdir(), "agency-init-deep-"));
  dirs.push(root);
  return root;
}

describe("renderAgentsTemplate", () => {
  test("template carries hierarchy contract", () => {
    expect(AGENTS_MD_TEMPLATE).toContain("nearer AGENTS.md overrides");
    const text = renderAgentsTemplate({
      dirRel: "pkg/app",
      dirName: "app",
      isRoot: false,
      children: ["index.ts"],
    });
    expect(text).toContain("pkg/app");
    expect(text).toContain("index.ts");
  });

  test("root rendering names project scope", () => {
    const text = renderAgentsTemplate({ dirRel: "root", dirName: "root", isRoot: true, children: [] });
    expect(text).toContain("project root");
    expect(text).toContain("whole project");
  });
});

describe("generateAgentsMd", () => {
  test("creates AGENTS.md in an empty dir", () => {
    const root = setup();
    const { path, created } = generateAgentsMd(root);
    expect(created).toBe(true);
    expect(path).toBe(join(root, "AGENTS.md"));
    expect(readFileSync(path, "utf8")).toContain("AGENTS.md");
  });

  test("never overwrites an existing AGENTS.md", () => {
    const root = setup();
    writeFileSync(join(root, "AGENTS.md"), "hand-written");
    const { created } = generateAgentsMd(root);
    expect(created).toBe(false);
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe("hand-written");
  });
});

describe("initDeep", () => {
  test("generates hierarchically and skips existing files", () => {
    const root = setup();
    mkdirSync(join(root, "packages", "app"), { recursive: true });
    mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(root, "packages", "AGENTS.md"), "keep me");

    const result = initDeep(root);
    expect(result.created).toContain(join(root, "AGENTS.md"));
    expect(result.created).toContain(join(root, "packages", "app", "AGENTS.md"));
    expect(result.skipped).toContain(join(root, "packages", "AGENTS.md"));
    expect(readFileSync(join(root, "packages", "AGENTS.md"), "utf8")).toBe("keep me");
    expect(result.created.some((p) => p.includes("node_modules"))).toBe(false);
  });

  test("discovery respects depth and dir caps", () => {
    const root = setup();
    mkdirSync(join(root, "a", "b"), { recursive: true });
    expect(discoverInitDeepDirs(root, { maxDepth: 1 })).toEqual([root, join(root, "a")]);
    expect(discoverInitDeepDirs(root, { maxDirs: 1 })).toEqual([root]);
  });

  test("generated files auto-read nearest-first via loadInstructions", () => {
    const root = setup();
    mkdirSync(join(root, "packages", "app"), { recursive: true });
    initDeep(root);
    const trust = createFileTrustStore(join(root, "trust.json"));
    trust.trust(root);
    const fromApp = join(root, "packages", "app");
    const files = collectAgentsFiles(fromApp, root);
    expect(files[0]).toBe(join(fromApp, "AGENTS.md"));
    expect(files).toContain(join(root, "AGENTS.md"));
    const texts = loadInstructions(trust, root, fromApp);
    expect(texts.length).toBeGreaterThanOrEqual(2);
    expect(texts[0]).toContain("packages");
  });
});

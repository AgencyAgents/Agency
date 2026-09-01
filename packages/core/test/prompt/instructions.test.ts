import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileTrustStore } from "@agency/guard";
import { AgencyError } from "@agency/schema";
import { collectAgentsFiles, collectRuleFiles, loadInstructions } from "../../src/prompt/instructions.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "agency-instructions-"));
  dirs.push(root);
  return root;
}

describe("collectAgentsFiles", () => {
  test("walks nearest-directory-first up to the workspace root", () => {
    const root = setup();
    mkdirSync(join(root, "packages", "app"), { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), "root rules");
    writeFileSync(join(root, "packages", "app", "AGENTS.md"), "app rules");

    const files = collectAgentsFiles(join(root, "packages", "app"), root);
    expect(files).toEqual([join(root, "packages", "app", "AGENTS.md"), join(root, "AGENTS.md")]);
  });

  test("returns nothing when no AGENTS.md exists", () => {
    const root = setup();
    expect(collectAgentsFiles(root, root)).toEqual([]);
  });
});

describe("collectRuleFiles", () => {
  test("lists .agency/rules/*.md sorted", () => {
    const root = setup();
    mkdirSync(join(root, ".agency", "rules"), { recursive: true });
    writeFileSync(join(root, ".agency", "rules", "b.md"), "b");
    writeFileSync(join(root, ".agency", "rules", "a.md"), "a");
    writeFileSync(join(root, ".agency", "rules", "ignore.txt"), "not markdown");

    expect(collectRuleFiles(root)).toEqual([
      join(root, ".agency", "rules", "a.md"),
      join(root, ".agency", "rules", "b.md"),
    ]);
  });
});

describe("loadInstructions", () => {
  test("throws PERMISSION_DENIED for an untrusted workspace, without reading any file", () => {
    const root = setup();
    writeFileSync(join(root, "AGENTS.md"), "malicious instructions");
    const trustStore = createFileTrustStore(join(root, "trust.json"));

    expect(() => loadInstructions(trustStore, root)).toThrow(AgencyError);
  });

  test("loads AGENTS.md and rules once the workspace is trusted", () => {
    const root = setup();
    writeFileSync(join(root, "AGENTS.md"), "root rules");
    mkdirSync(join(root, ".agency", "rules"), { recursive: true });
    writeFileSync(join(root, ".agency", "rules", "style.md"), "style rules");

    const trustStore = createFileTrustStore(join(root, "trust.json"));
    trustStore.trust(root);

    expect(loadInstructions(trustStore, root)).toEqual(["root rules", "style rules"]);
  });
});

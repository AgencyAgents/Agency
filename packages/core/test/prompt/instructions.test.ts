import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileTrustStore } from "@agency/guard";
import { AgencyError } from "@agency/schema";
import {
  collectAgentsFiles,
  collectRuleFiles,
  DEFAULT_MAX_INSTRUCTION_BYTES,
  loadInstructions,
} from "../../src/prompt/instructions.ts";

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

  test("discovers CLAUDE.md in the same walk order", () => {
    const root = setup();
    mkdirSync(join(root, "packages", "app"), { recursive: true });
    writeFileSync(join(root, "CLAUDE.md"), "root claude");
    writeFileSync(join(root, "packages", "app", "CLAUDE.md"), "app claude");

    const files = collectAgentsFiles(join(root, "packages", "app"), root);
    expect(files).toEqual([join(root, "packages", "app", "CLAUDE.md"), join(root, "CLAUDE.md")]);
  });

  test("when both exist in the same directory, AGENTS.md comes before CLAUDE.md", () => {
    const root = setup();
    mkdirSync(join(root, "packages", "app"), { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), "root rules");
    writeFileSync(join(root, "CLAUDE.md"), "root claude");
    writeFileSync(join(root, "packages", "app", "AGENTS.md"), "app rules");
    writeFileSync(join(root, "packages", "app", "CLAUDE.md"), "app claude");

    const files = collectAgentsFiles(join(root, "packages", "app"), root);
    expect(files).toEqual([
      join(root, "packages", "app", "AGENTS.md"),
      join(root, "packages", "app", "CLAUDE.md"),
      join(root, "AGENTS.md"),
      join(root, "CLAUDE.md"),
    ]);
  });

  test("returns nothing when neither AGENTS.md nor CLAUDE.md exists", () => {
    const root = setup();
    expect(collectAgentsFiles(root, root)).toEqual([]);
  });

  test("CLAUDE.md in subdir with AGENTS.md in root only", () => {
    const root = setup();
    mkdirSync(join(root, "packages", "app"), { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), "root rules");
    writeFileSync(join(root, "packages", "app", "CLAUDE.md"), "app claude");

    const files = collectAgentsFiles(join(root, "packages", "app"), root);
    expect(files).toEqual([join(root, "packages", "app", "CLAUDE.md"), join(root, "AGENTS.md")]);
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

  test("loads CLAUDE.md alongside AGENTS.md, with AGENTS.md first", () => {
    const root = setup();
    writeFileSync(join(root, "AGENTS.md"), "root rules");
    writeFileSync(join(root, "CLAUDE.md"), "root claude");

    const trustStore = createFileTrustStore(join(root, "trust.json"));
    trustStore.trust(root);

    expect(loadInstructions(trustStore, root)).toEqual(["root rules", "root claude"]);
  });

  test("files under the cap load verbatim", () => {
    const root = setup();
    writeFileSync(join(root, "AGENTS.md"), "short");
    const trustStore = createFileTrustStore(join(root, "trust.json"));
    trustStore.trust(root);

    expect(loadInstructions(trustStore, root, root, { maxFileBytes: 1024 })).toEqual(["short"]);
  });

  test("files over the cap are truncated with a visible notice, at the byte level", () => {
    const root = setup();
    const big = "a".repeat(50) + "b".repeat(50);
    writeFileSync(join(root, "AGENTS.md"), big);
    const trustStore = createFileTrustStore(join(root, "trust.json"));
    trustStore.trust(root);

    const loaded = loadInstructions(trustStore, root, root, { maxFileBytes: 64 });
    expect(loaded).toHaveLength(1);
    const content = loaded[0] ?? "";
    expect(content.startsWith("a".repeat(50) + "b".repeat(14))).toBe(true);
    expect(content).toContain("[instruction file truncated to 64 bytes");
    // Bytes 65..100 of the file never made it in: only the 64 capped bytes plus the notice.
    expect(content).not.toContain("b".repeat(50));
  });

  test("truncation never splits a multi-byte UTF-8 character", () => {
    const root = setup();
    // Each é is 2 bytes; an odd cap lands mid-character.
    writeFileSync(join(root, "AGENTS.md"), "é".repeat(32));
    const trustStore = createFileTrustStore(join(root, "trust.json"));
    trustStore.trust(root);

    const content = loadInstructions(trustStore, root, root, { maxFileBytes: 11 })[0] ?? "";
    expect(content).toContain("[instruction file truncated to 11 bytes");
    expect(content).not.toContain("\uFFFD");
    expect(content.startsWith("é".repeat(5))).toBe(true);
  });

  test("the default cap is a sane bound, not unbounded", () => {
    expect(DEFAULT_MAX_INSTRUCTION_BYTES).toBe(64 * 1024);
  });
});

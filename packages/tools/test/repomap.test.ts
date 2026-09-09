import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateTokens } from "@agency/providers";
import {
  buildRepoMap,
  isRepoMapFresh,
  queryRepoMap,
  REPOMAP_TRUNCATION_MARKER,
  type RepoMapIndex,
  renderRepoMap,
} from "../src/repomap.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "agency-repomap-"));
  dirs.push(root);
  const write = (rel: string, content: string | Buffer): void => {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  };
  write("src/auth.ts", "export function authenticate(user: string) {}\nexport class AuthStore {}\n");
  write(
    "src/login.ts",
    'import { authenticate } from "./auth";\nexport function loginUser(name: string) { return authenticate(name); }\n',
  );
  write("src/noise.ts", "export function unrelatedWidget() {}\n");
  write("README.md", "# docs\n");
  write(".gitignore", "dist/\n");
  write("dist/bundle.ts", "export function authenticate() {}\n");
  write("node_modules/fake/index.ts", "export function authenticate() {}\n");
  write(".git/objects/x", "export function authenticate() {}\n");
  return root;
}

describe("repomap rank", () => {
  test("seeded queries rank target files above noise", () => {
    const index = buildRepoMap(fixture());
    const auth = queryRepoMap(index, "authenticate").map((f) => f.path);
    expect(auth[0]).toBe("src/auth.ts");
    expect(auth.indexOf("src/auth.ts")).toBeLessThan(auth.indexOf("src/noise.ts"));
    const login = queryRepoMap(index, "loginUser").map((f) => f.path);
    expect(login[0]).toBe("src/login.ts");
  });

  test("reference counts boost the imported file", () => {
    const index = buildRepoMap(fixture());
    const auth = index.files.find((f) => f.path === "src/auth.ts");
    const noise = index.files.find((f) => f.path === "src/noise.ts");
    expect(auth?.refs).toBeGreaterThan(noise?.refs ?? 0);
  });
});

describe("repomap budget", () => {
  test("tiny cap forces subset plus marker within cap", () => {
    const rendered = renderRepoMap(buildRepoMap(fixture()), "src", { maxTokens: 10 });
    expect(rendered.truncated).toBe(true);
    expect(rendered.omitted).toBeGreaterThan(0);
    expect(rendered.text).toContain(REPOMAP_TRUNCATION_MARKER);
    expect(estimateTokens(rendered.text)).toBeLessThanOrEqual(40);
  });

  test("default budget renders the full small map without marker", () => {
    const rendered = renderRepoMap(buildRepoMap(fixture()), "authenticate");
    expect(rendered.truncated).toBe(false);
    expect(rendered.text).not.toContain(REPOMAP_TRUNCATION_MARKER);
  });
});

describe("repomap ignore", () => {
  test("node_modules, .git, and gitignored paths excluded on name matches", () => {
    const paths = buildRepoMap(fixture()).files.map((f) => f.path);
    expect(paths).not.toContain("node_modules/fake/index.ts");
    expect(paths).not.toContain(".git/objects/x");
    expect(paths).not.toContain("dist/bundle.ts");
    expect(paths).toContain("src/auth.ts");
    const ranked = queryRepoMap(buildRepoMap(fixture()), "authenticate").map((f) => f.path);
    expect(
      ranked.some((p) => p.includes("node_modules") || p.startsWith(".git/") || p.startsWith("dist/")),
    ).toBe(false);
  });
});

describe("repomap staleness", () => {
  test("mtime-keyed flag trips on edit and clears on rebuild", () => {
    const root = fixture();
    const index = buildRepoMap(root);
    expect(isRepoMapFresh(index)).toBe(true);
    writeFileSync(
      join(root, "src/noise.ts"),
      "export function unrelatedWidget() {}\nexport function extra() {}\n",
    );
    expect(isRepoMapFresh(index)).toBe(false);
    expect(isRepoMapFresh(buildRepoMap(root))).toBe(true);
  });
});

describe("repomap malformed", () => {
  test("binary, huge, symlink-loop, and denied files never crash", () => {
    const root = mkdtempSync(join(tmpdir(), "agency-repomap-"));
    dirs.push(root);
    writeFileSync(join(root, "ok.ts"), "export function fine() {}\n");
    writeFileSync(join(root, "bin.ts"), Buffer.from([0x65, 0x78, 0x70, 0x00, 0xff, 0xfe]));
    writeFileSync(join(root, "huge.ts"), `export function big() {}\n${"x".repeat(300 * 1024)}`);
    const denied = join(root, "denied.ts");
    writeFileSync(denied, "export function hidden() {}\n");
    let chmodOk = true;
    try {
      chmodSync(denied, 0o000);
    } catch {
      chmodOk = false;
    }
    try {
      symlinkSync(root, join(root, "loop"), "dir");
    } catch {
      // symlink privilege absent: loop vector not exercisable here
    }
    let index: RepoMapIndex;
    try {
      index = buildRepoMap(root);
    } finally {
      if (chmodOk) {
        try {
          chmodSync(denied, 0o644);
        } catch {
          // best effort restore before the afterEach rm
        }
      }
    }
    expect(index.files.some((f) => f.path === "ok.ts")).toBe(true);
    expect(index.files.find((f) => f.path === "bin.ts")?.scanned).toBe(false);
    expect(index.files.find((f) => f.path === "huge.ts")?.scanned).toBe(false);
    expect(queryRepoMap(index, "fine")[0]?.path).toBe("ok.ts");
  });
});

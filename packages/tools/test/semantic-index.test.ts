import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSemanticIndex,
  cosineSimilarity,
  DEFAULT_SEMANTIC_THRESHOLD,
  hashedTokenVector,
  isSemanticIndexFresh,
  loadSemanticIndex,
  querySemanticIndex,
  saveSemanticIndex,
} from "../src/semantic-index.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "agency-semantic-"));
  dirs.push(root);
  const write = (rel: string, content: string): void => {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  };
  write(
    "src/auth.ts",
    "export function authenticate(user: string, password: string) {\n" +
      "// verify the user password and mint a session token for login\n" +
      "return { user, sessionToken: password.length };\n}\n" +
      "export class AuthStore {}\n",
  );
  write(
    "src/login.ts",
    "import { authenticate } from './auth';\n" +
      "export function loginUser(name: string) {\n" +
      "// signin entrypoint: redirect to the signin form after logout\n" +
      "return authenticate(name, 'signin-form');\n}\n",
  );
  write(
    "src/widget.ts",
    "export function renderWidget() {\n" +
      "// paint the dashboard widget and refresh the chart layout\n" +
      "return 'widget-chart-layout';\n}\n",
  );
  return root;
}

function rankPaths(root: string, query: string): { path: string; score: number }[] {
  return querySemanticIndex(buildSemanticIndex(root), query).hits;
}

describe("semantic-index recall", () => {
  test("seeded queries recall target files in rank 1", () => {
    const root = fixture();
    const auth = rankPaths(root, "how do I authenticate a user password for a session token");
    const login = rankPaths(root, "signin form login entrypoint after logout");
    const widget = rankPaths(root, "render the dashboard widget chart layout");
    console.log(`recall auth=${auth[0]?.path}:${auth[0]?.score.toFixed(3)}`);
    console.log(`recall login=${login[0]?.path}:${login[0]?.score.toFixed(3)}`);
    console.log(`recall widget=${widget[0]?.path}:${widget[0]?.score.toFixed(3)}`);
    expect(auth[0]?.path).toBe("src/auth.ts");
    expect(login[0]?.path).toBe("src/login.ts");
    expect(widget[0]?.path).toBe("src/widget.ts");
    for (const top of [auth[0], login[0], widget[0]]) {
      expect(top?.score).toBeGreaterThanOrEqual(DEFAULT_SEMANTIC_THRESHOLD);
    }
  });

  test("negative query scores below threshold with zero hits", () => {
    const root = fixture();
    const index = buildSemanticIndex(root);
    const { hits } = querySemanticIndex(index, "quantum photosynthesis orbital entanglement");
    const best = Math.max(
      0,
      ...index.chunks.map((c) =>
        cosineSimilarity(hashedTokenVector("quantum photosynthesis orbital entanglement"), c.vector),
      ),
    );
    console.log(`negative best=${best.toFixed(3)} hits=${hits.length}`);
    expect(best).toBeLessThan(DEFAULT_SEMANTIC_THRESHOLD);
    expect(hits).toEqual([]);
  });

  test("recall is exactly reproducible across runs", () => {
    const root = fixture();
    const index = buildSemanticIndex(root);
    const first = querySemanticIndex(index, "authenticate user session token").hits;
    const second = querySemanticIndex(index, "authenticate user session token").hits;
    expect(second).toEqual(first);
    expect(first.length).toBeGreaterThan(0);
  });
});

describe("semantic-index staleness", () => {
  test("mtime-keyed flag trips on edit and query surfaces it", () => {
    const root = fixture();
    const index = buildSemanticIndex(root);
    expect(isSemanticIndexFresh(index)).toBe(true);
    expect(querySemanticIndex(index, "authenticate user").stale).toBe(false);
    writeFileSync(join(root, "src/widget.ts"), "export function renderWidget() {}\n// touched\n");
    expect(isSemanticIndexFresh(index)).toBe(false);
    const result = querySemanticIndex(index, "authenticate user");
    console.log(`stale flag=${result.stale}`);
    expect(result.stale).toBe(true);
    expect(isSemanticIndexFresh(buildSemanticIndex(root))).toBe(true);
  });
});

describe("semantic-index store", () => {
  test("file-backed round trip preserves recall, corrupt lines skip", () => {
    const root = fixture();
    const index = buildSemanticIndex(root);
    const storePath = join(root, "chunks.jsonl");
    saveSemanticIndex(storePath, index);
    appendFileSync(storePath, "not json at all\n");
    appendFileSync(storePath, '{"kind":"chunk","path":1}\n');
    const warnings: string[] = [];
    const loaded = loadSemanticIndex(storePath, { onWarn: (m) => warnings.push(m) });
    console.log(`store chunks=${loaded.chunks.length} warnings=${warnings.length}`);
    expect(loaded.chunks.length).toBe(index.chunks.length);
    expect(warnings.length).toBe(2);
    const hits = querySemanticIndex(loaded, "authenticate user password session token").hits;
    expect(hits[0]?.path).toBe("src/auth.ts");
  });

  test("missing store loads empty without throwing", () => {
    const loaded = loadSemanticIndex(join(fixture(), "absent.jsonl"), { onWarn: () => {} });
    expect(loaded.chunks).toEqual([]);
    expect(querySemanticIndex(loaded, "authenticate user").hits).toEqual([]);
  });
});

describe("semantic-index malformed", () => {
  test("empty corpus and empty query return no hits", () => {
    const root = mkdtempSync(join(tmpdir(), "agency-semantic-"));
    dirs.push(root);
    const index = buildSemanticIndex(root);
    expect(index.chunks).toEqual([]);
    expect(querySemanticIndex(index, "authenticate user").hits).toEqual([]);
    expect(querySemanticIndex(buildSemanticIndex(fixture()), "").hits).toEqual([]);
    expect(querySemanticIndex(buildSemanticIndex(fixture()), "   ...   ").hits).toEqual([]);
  });
});

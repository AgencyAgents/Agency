import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Git for Windows keeps bash next to git; a bare `bash` there can be the WSL launcher. */
function findBash(): string[] | undefined {
  if (process.platform !== "win32") return ["bash"];
  const git = Bun.which("git");
  if (!git) return undefined;
  const bash = ["..", join("..", "..")]
    .map((up) => join(dirname(git), up, "usr", "bin", "bash.exe"))
    .find((path) => existsSync(path));
  // Login shell: only the profile puts curl and shasum on PATH there.
  return bash ? [bash, "--login"] : undefined;
}

const bash = findBash();
const posix = (path: string) => path.replaceAll("\\", "/");
const ASSET = "agency-linux-x64";
const UNAME = 'uname() { case "$1" in -s) echo Linux ;; -m) echo x86_64 ;; esac; }';
// What a machine with no sha256sum shows the script: the lookup finds nothing and a call fails.
const NO_SHA256SUM =
  'command() { if [ "$1" = -v ] && [ "$2" = sha256sum ]; then return 1; fi; builtin command "$@"; }; ' +
  'sha256sum() { echo "sha256sum: command not found" >&2; return 127; }';

const binary = Buffer.from(`fake agency binary ${crypto.randomUUID()}`);
const digest = createHash("sha256").update(binary).digest("hex");
let checksums = "";
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const name = new URL(request.url).pathname.slice(1);
    if (name === ASSET) return new Response(binary);
    if (name === "checksums.txt") return new Response(checksums);
    return new Response("not found", { status: 404 });
  },
});
const dirs: string[] = [];
afterAll(async () => {
  await server.stop(true);
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

async function install(prelude: string, manifest: string) {
  checksums = manifest;
  const dir = mkdtempSync(join(tmpdir(), "agency-install-"));
  dirs.push(dir);
  const proc = Bun.spawn(
    [...(bash ?? []), "-c", `${prelude}; . "$1"`, "_", posix(join(import.meta.dir, "install.sh"))],
    {
      env: {
        ...process.env,
        AGENCY_VERSION: "9.9.9",
        AGENCY_INSTALL_DIR: posix(dir),
        AGENCY_RELEASE_BASE_URL: `http://127.0.0.1:${server.port}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { code, stderr, installed: join(dir, "agency") };
}

describe.skipIf(!bash)("install.sh", () => {
  test("installs the binary when the checksum agrees", async () => {
    const run = await install(UNAME, `${digest}  ${ASSET}\n`);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    expect(readFileSync(run.installed).equals(binary)).toBe(true);
  });

  test("installs on a machine with no sha256sum, as macOS is", async () => {
    const run = await install(`${UNAME}; ${NO_SHA256SUM}`, `${digest}  ${ASSET}\n`);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    expect(readFileSync(run.installed).equals(binary)).toBe(true);
  });

  test("refuses a binary whose checksum disagrees and writes nothing", async () => {
    const run = await install(UNAME, `${"0".repeat(64)}  ${ASSET}\n`);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("checksum mismatch");
    expect(existsSync(run.installed)).toBe(false);
  });
});

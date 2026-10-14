import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ASSET = "agency-windows-x64.exe";
// Big enough to show the progress bar cost: Windows PowerShell 5.1 needed 1.5 s per MB with the bar.
const binary = Buffer.alloc(16 * 1024 * 1024, 7);
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

async function install(manifest: string, env: Record<string, string> = {}) {
  checksums = manifest;
  const dir = mkdtempSync(join(tmpdir(), "agency-install-ps1-"));
  dirs.push(dir);
  const started = Date.now();
  const proc = Bun.spawn(
    [
      "powershell.exe",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(import.meta.dir, "install.ps1"),
    ],
    {
      env: {
        ...process.env,
        AGENCY_VERSION: "9.9.9",
        AGENCY_INSTALL_DIR: dir,
        AGENCY_RELEASE_BASE_URL: `http://127.0.0.1:${server.port}`,
        // Without this the script adds the directory to the PATH of the user who runs the tests.
        AGENCY_NO_MODIFY_PATH: "1",
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return {
    code,
    said: stdout + stderr,
    seconds: (Date.now() - started) / 1000,
    installed: join(dir, "agency.exe"),
  };
}

describe.skipIf(process.platform !== "win32")("install.ps1", () => {
  test("installs the binary when the checksum agrees, fast, and leaves the user PATH alone", async () => {
    // The checksum file has the form that sha256sum writes on the release runner.
    const run = await install(`${digest}  ${ASSET}\n${"0".repeat(64)}  agency-linux-x64\n`);
    expect(run.said).toContain("install: checksum verified");
    expect(run.code).toBe(0);
    expect(readFileSync(run.installed).equals(binary)).toBe(true);
    expect(run.said).toContain("is not on your PATH");
    expect(run.said).not.toContain("added");
    // 16 MB took about 24 s with the progress bar of Windows PowerShell 5.1.
    expect(run.seconds).toBeLessThan(15);
  }, 60_000);

  test("refuses a binary whose checksum disagrees and writes nothing", async () => {
    const run = await install(`${"0".repeat(64)}  ${ASSET}\n`);
    expect(run.code).toBe(1);
    expect(run.said).toContain("checksum mismatch");
    expect(existsSync(run.installed)).toBe(false);
  }, 60_000);

  test("refuses when the checksum file has no line for the binary", async () => {
    const run = await install(`${digest}  agency-linux-x64\n`);
    expect(run.code).toBe(1);
    expect(run.said).toContain("no checksum for");
    expect(existsSync(run.installed)).toBe(false);
  }, 60_000);

  test("says that there is no ARM64 build, in place of a download error", async () => {
    const run = await install(`${digest}  ${ASSET}\n`, { PROCESSOR_ARCHITECTURE: "ARM64" });
    expect(run.code).toBe(1);
    expect(run.said).toContain("no Windows ARM64 build");
  }, 60_000);
});

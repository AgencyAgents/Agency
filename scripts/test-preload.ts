import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Tests must never touch the real user config or data; spawned children inherit this.
const home = mkdtempSync(join(tmpdir(), "agency-test-home-"));
process.env.AGENCY_HOME = home;
process.on("exit", () => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    // Windows keeps a lingering child's files locked; the temp dir is disposable.
  }
});

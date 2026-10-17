import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Tests must never touch the real user config or data; spawned children inherit this.
const home = mkdtempSync(join(tmpdir(), "agency-test-home-"));
process.env.AGENCY_HOME = home;
// Nor the user files of other agents (`~/.claude/skills` and the others).
process.env.AGENCY_AGENTS_HOME = home;
// A developer's own provider keys must not change what a test sees.
for (const name of Object.keys(process.env)) if (name.endsWith("_API_KEY")) delete process.env[name];
process.on("exit", () => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    // Windows keeps a lingering child's files locked; the temp dir is disposable.
  }
});

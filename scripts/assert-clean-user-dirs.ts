/** CI guard, run after the test shards: fails when a test wrote to the real user dirs. */
import { existsSync } from "node:fs";
import { configDir } from "../packages/core/src/paths.ts";
import { dataDir } from "../packages/core/src/storage.ts";

const env = { ...process.env, AGENCY_HOME: undefined };
const touched = [configDir(env), dataDir(env)].filter((dir) => existsSync(dir));
if (touched.length > 0) {
  console.error(`tests wrote to the real user dirs: ${touched.join(", ")}`);
  process.exit(1);
}
console.log("user dirs untouched");

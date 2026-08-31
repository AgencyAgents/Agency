import { homedir } from "node:os";
import { join } from "node:path";

/** Per-OS config directory. Data/cache/log directories are added when P5 needs them. */
export function configDir(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string {
  if (platform === "win32") {
    return join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Agency");
  }
  if (platform === "darwin") {
    return join(homedir(), ".config", "agency");
  }
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "agency");
}

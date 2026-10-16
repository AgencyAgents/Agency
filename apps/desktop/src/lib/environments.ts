export interface Environment {
  id: string;
  name: string;
  network: "full" | "none" | "domains";
  /** Comma or space separated. */
  domains: string;
  /** NAME=value lines. */
  vars: string;
  setup: string;
}

/** Windows keeps commands off the network only with administrator rights, and its OS sandbox breaks HTTPS. */
export const FULL_NETWORK_ONLY = navigator.userAgent.includes("Windows");

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** NAME=value lines as a shell writes them: `export ` and quotes are allowed, other lines are skipped. */
export function parseVars(text: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const at = line.indexOf("=");
    const name = line
      .slice(0, at)
      .trim()
      .replace(/^export\s+/, "");
    if (at > 0 && NAME.test(name))
      vars[name] = line
        .slice(at + 1)
        .trim()
        .replace(/^(["'])(.*)\1$/, "$2");
  }
  return vars;
}

/** The config layer of a project's environment. Full network says so: a global config may turn it off. */
export function environmentLayer(e: Environment | undefined): Record<string, unknown> {
  if (!e) return {};
  const shellEnv = parseVars(e.vars);
  const domains = e.domains.split(/[\s,]+/).filter(Boolean);
  return {
    sandbox:
      e.network === "full"
        ? { allowNetwork: true }
        : {
            backend: "os",
            allowNetwork: false,
            ...(e.network === "domains" ? { allowedDomains: domains } : {}),
          },
    ...(Object.keys(shellEnv).length > 0 ? { shellEnv } : {}),
    ...(e.setup.trim() ? { setupScript: e.setup } : {}),
  };
}

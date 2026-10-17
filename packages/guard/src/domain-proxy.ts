import { lookup } from "node:dns/promises";
import { BlockList, connect, createServer, isIP, type Socket } from "node:net";

/** Addresses off the internet: this machine, its networks, link-local (cloud metadata), multicast and reserved. */
const PRIVATE = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["224.0.0.0", 3],
] as const)
  PRIVATE.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 127],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  PRIVATE.addSubnet(net, bits, "ipv6");

/** True for an address that is not a public one, and for text that is no address. */
export function isPrivateAddress(address: string): boolean {
  const ip = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1] ?? address;
  const family = isIP(ip);
  return family === 0 || PRIVATE.check(ip, family === 6 ? "ipv6" : "ipv4");
}

/** True when `host` is one of `allowed`: an exact name, or `*.example.com` for the names under it. No regard to case. */
export function hostAllowed(host: string, allowed: readonly string[]): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  // A NUL or another byte that no host name has could make `evil\0.github.com` end with `.github.com`.
  if (!/^[a-z0-9_.-]+$/.test(name) && isIP(name) === 0) return false;
  return allowed.some((pattern) => {
    const p = pattern.toLowerCase();
    return p.startsWith("*.") ? name.endsWith(p.slice(1)) : name === p;
  });
}

/** The host, port and path of a proxy request: `host:port` for CONNECT, an absolute URL for plain HTTP. */
function targetOf(method: string, target: string): { host: string; port: number; path: string } | undefined {
  if (method === "CONNECT") {
    const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(target);
    return m?.[1] && m[2] ? { host: m[1], port: Number(m[2]), path: "" } : undefined;
  }
  try {
    const url = new URL(target);
    if (url.protocol !== "http:") return undefined;
    return {
      host: url.hostname.replace(/^\[|\]$/g, ""),
      port: Number(url.port || 80),
      path: `${url.pathname}${url.search}`,
    };
  } catch {
    return undefined;
  }
}

const MAX_HEAD_BYTES = 64 * 1024;

/**
 * The address to connect to for an allowed host. A name that resolves to a private address is refused, as in Claude
 * Code: else an allowed name whose DNS points at 127.0.0.1 or 169.254.169.254 reaches this machine or the cloud
 * metadata. `localhost` and an address in the list itself pass. The connection goes to the checked address.
 */
async function addressOf(
  host: string,
  allowed: readonly string[],
  resolve: (host: string) => Promise<string[]>,
): Promise<string | { refused: string }> {
  if (host.toLowerCase() === "localhost" || (isIP(host) !== 0 && hostAllowed(host, allowed))) return host;
  const addresses = await resolve(host).catch((): string[] => []);
  const first = addresses[0];
  if (first === undefined) return { refused: `${host} does not resolve` };
  const inside = addresses.find(isPrivateAddress);
  if (inside !== undefined) return { refused: `${host} resolves to the private address ${inside}` };
  return first;
}

const resolveAll = async (host: string): Promise<string[]> =>
  (await lookup(host, { all: true })).map((entry) => entry.address);

export interface DomainProxy {
  /** The TCP port, when it listens on one. */
  port?: number;
  close(): void;
}

/**
 * An HTTP proxy that passes only the hosts of `allowed`: CONNECT for HTTPS, an absolute URL for plain HTTP. The
 * sandbox lets a command reach this proxy and nothing else, so the list holds for every program that uses a proxy.
 */
export function startDomainProxy(
  allowed: readonly string[],
  listen: { path: string } | { host: string; port: number },
  resolveHost: (host: string) => Promise<string[]> = resolveAll,
): Promise<DomainProxy> {
  const server = createServer((client) => {
    let head = Buffer.alloc(0);
    client.on("error", () => {});
    const onData = (chunk: Buffer): void => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) {
        if (head.length > MAX_HEAD_BYTES) client.destroy();
        return;
      }
      client.off("data", onData);
      client.pause();
      const lineEnd = head.indexOf("\r\n");
      const [method = "", target = "", version = "HTTP/1.1"] = head
        .subarray(0, lineEnd)
        .toString("latin1")
        .split(" ");
      const dest = targetOf(method, target);
      const refuse = (why: string): void => {
        client.end(
          `HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\nagency sandbox: ${why}\n`,
        );
      };
      if (!dest || !hostAllowed(dest.host, allowed)) {
        refuse(`${dest?.host ?? target} is not in sandbox.allowedDomains`);
        return;
      }
      void addressOf(dest.host, allowed, resolveHost).then((address) => {
        if (typeof address !== "string") return refuse(address.refused);
        let open = false;
        const upstream: Socket = connect(dest.port, address, () => {
          open = true;
          if (method === "CONNECT") {
            client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            upstream.write(head.subarray(end + 4));
          } else {
            // The site gets the path, not the absolute URL; the rest of the head and the body go as they came.
            upstream.write(
              Buffer.concat([
                Buffer.from(`${method} ${dest.path} ${version}`, "latin1"),
                head.subarray(lineEnd),
              ]),
            );
          }
          client.pipe(upstream);
          upstream.pipe(client);
          client.resume();
        });
        upstream.on("error", () => {
          if (open) client.destroy();
          else client.end("HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n");
        });
        client.on("close", () => upstream.destroy());
      });
    };
    client.on("data", onData);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    const ready = (): void => {
      server.unref();
      const address = server.address();
      resolve({
        ...(typeof address === "object" && address ? { port: address.port } : {}),
        close: () => server.close(),
      });
    };
    if ("path" in listen) server.listen(listen.path, ready);
    else server.listen(listen.port, listen.host, ready);
  });
}

import { connect, createServer, type Socket } from "node:net";

/** True when `host` is one of `allowed`: an exact name, or `*.example.com` for the names under it. No regard to case. */
export function hostAllowed(host: string, allowed: readonly string[]): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
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
      if (!dest || !hostAllowed(dest.host, allowed)) {
        const host = dest?.host ?? target;
        client.end(
          `HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\nagency sandbox: ${host} is not in sandbox.allowedDomains\n`,
        );
        return;
      }
      let open = false;
      const upstream: Socket = connect(dest.port, dest.host, () => {
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

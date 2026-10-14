import { afterAll, describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { hostAllowed, startDomainProxy } from "../src/domain-proxy.ts";

const site = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("site body") });
afterAll(() => site.stop(true));

/** Sends `request` raw to the proxy and returns all that comes back before the proxy or the site closes. */
function ask(port: number, request: string, thenInTunnel?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.write(request));
    let text = "";
    socket.on("data", (d) => {
      text += String(d);
      if (thenInTunnel && text.includes("200 Connection Established\r\n\r\n")) {
        socket.write(thenInTunnel);
        thenInTunnel = undefined;
      }
    });
    socket.on("end", () => resolve(text));
    socket.on("error", reject);
  });
}

describe("domain proxy", () => {
  test("a host matches its exact name, or a *. pattern for the names under it, with no regard to case", () => {
    const allowed = ["github.com", "*.npmjs.org"];
    expect(hostAllowed("GitHub.com", allowed)).toBe(true);
    expect(hostAllowed("github.com.", allowed)).toBe(true);
    expect(hostAllowed("registry.npmjs.org", allowed)).toBe(true);
    expect(hostAllowed("npmjs.org", allowed)).toBe(false);
    expect(hostAllowed("evilgithub.com", allowed)).toBe(false);
    expect(hostAllowed("github.com.evil.net", allowed)).toBe(false);
  });

  test("plain HTTP and a CONNECT tunnel reach an allowed host; another host gets 403 and no connection", async () => {
    const proxy = await startDomainProxy(["localhost"], { host: "127.0.0.1", port: 0 });
    try {
      const port = proxy.port ?? 0;
      const plain = await ask(
        port,
        `GET http://localhost:${site.port}/x HTTP/1.1\r\nHost: localhost:${site.port}\r\nConnection: close\r\n\r\n`,
      );
      expect(plain).toStartWith("HTTP/1.1 200");
      expect(plain).toContain("site body");

      const tunnel = await ask(
        port,
        `CONNECT localhost:${site.port} HTTP/1.1\r\nHost: localhost:${site.port}\r\n\r\n`,
        `GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`,
      );
      expect(tunnel).toStartWith("HTTP/1.1 200 Connection Established");
      expect(tunnel).toContain("site body");

      for (const request of [
        `GET http://127.0.0.1:${site.port}/ HTTP/1.1\r\nHost: localhost\r\n\r\n`,
        `CONNECT 127.0.0.1:${site.port} HTTP/1.1\r\n\r\n`,
        "GET /relative HTTP/1.1\r\nHost: localhost\r\n\r\n",
      ]) {
        const refused = await ask(port, request);
        expect(refused).toStartWith("HTTP/1.1 403");
        expect(refused).not.toContain("site body");
      }
      expect(await ask(port, `CONNECT 127.0.0.1:${site.port} HTTP/1.1\r\n\r\n`)).toContain(
        "127.0.0.1 is not in sandbox.allowedDomains",
      );
    } finally {
      proxy.close();
    }
  });
});

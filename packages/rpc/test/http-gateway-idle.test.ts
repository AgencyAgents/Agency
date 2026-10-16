import { afterEach, expect, test } from "bun:test";
import { type HttpGatewayServer, startHttpGateway } from "../src/http-gateway.ts";

const servers: HttpGatewayServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

async function readUntil(
  reader: { read(): Promise<{ value?: Uint8Array; done: boolean }> },
  needle: string,
): Promise<string> {
  const decoder = new TextDecoder();
  let acc = "";
  while (!acc.includes(needle)) {
    const { value, done } = await reader.read();
    if (done) break;
    acc += decoder.decode(value, { stream: true });
  }
  return acc;
}

test("a silent SSE stream outlives Bun's 10 s idle cutoff and still gets events", async () => {
  const server = startHttpGateway({ handlers: {} });
  servers.push(server);
  const res = await fetch(`http://127.0.0.1:${server.port}/events`);
  const reader = res.body!.getReader();
  await readUntil(reader, "event: state");

  await Bun.sleep(12_000);
  server.publish("late", { n: 1 });

  expect(await readUntil(reader, "event: late")).toContain("event: late");
}, 20_000);

test("onSubscriberCount reports a stream that attaches and one that leaves", async () => {
  const counts: number[] = [];
  const server = startHttpGateway({ handlers: {}, onSubscriberCount: (count) => counts.push(count) });
  servers.push(server);
  const controller = new AbortController();
  const res = await fetch(`http://127.0.0.1:${server.port}/events`, { signal: controller.signal });
  await readUntil(res.body!.getReader(), "event: state");
  expect(counts).toEqual([1]);

  controller.abort();
  const deadline = Date.now() + 2_000;
  while (counts.at(-1) !== 0 && Date.now() < deadline) await Bun.sleep(25);

  expect(counts).toEqual([1, 0]);
});

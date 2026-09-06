import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, startDaemonServer } from "@agency/rpc";
import { connect } from "../src/index.ts";

describe("AgencyClient", () => {
  test("end-to-end over a real daemon: runTurn, cancelTurn, listProviders", async () => {
    const server = await startDaemonServer({
      handlers: {
        run_turn: (raw) => {
          const params = raw as { turnId: string };
          server.broadcast(`turn.${params.turnId}`, { type: "text_delta", text: "hello" });
          return Promise.resolve({
            messages: [{ role: "assistant", content: [{ type: "text", text: "hello" }] }],
            stopReason: "end_turn",
            usage: { inputTokens: 3, outputTokens: 2 },
            budgetExceeded: false,
            cancelled: false,
          });
        },
        cancel_turn: () => Promise.resolve({ cancelled: false }),
        providers_list: () =>
          Promise.resolve({
            all: [{ id: "openai", name: "OpenAI", models: [] }],
            default: { openai: "gpt-5" },
            connected: ["openai"],
          }),
      },
    });

    const client = await connect(server.port);
    const events: unknown[] = [];
    const result = await client.runTurn(
      {
        provider: "openai",
        model: "gpt-5",
        apiKey: "key",
        systemPrompt: "sys",
        session: [],
      },
      (event) => events.push(event),
    );

    expect(result.stopReason).toBe("end_turn");
    expect(result.messages[0]?.content[0]).toMatchObject({ type: "text", text: "hello" });
    expect(events).toEqual([{ type: "text_delta", text: "hello" }]);

    await expect(client.cancelTurn("missing")).resolves.toEqual({ cancelled: false });
    const providers = await client.listProviders();
    expect(providers.connected).toEqual(["openai"]);
    expect(providers.all[0]).toMatchObject({ id: "openai", name: "OpenAI" });

    await client.close();
    await server.close();
  });

  test("protocol version is exported through the SDK's dependency", () => {
    expect(PROTOCOL_VERSION).toBe(2);
  });
});

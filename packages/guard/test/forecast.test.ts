import { describe, expect, test } from "bun:test";
import { AgencyError, ErrorCode } from "@agency/schema";
import { checkCostForecast, estimateDispatchCost } from "../src/forecast.ts";

function agents(count: number, inputPerMTok = 3, outputPerMTok = 15, effort?: string) {
  return Array.from({ length: count }, (_, i) => ({
    model: `model-${i}`,
    inputPerMTok,
    outputPerMTok,
    effort,
  }));
}

describe("estimateDispatchCost", () => {
  test("a five-agent fan-out produces a low..high range that scales with headcount", () => {
    const one = estimateDispatchCost({ briefChars: 4_000, agents: agents(1) });
    const five = estimateDispatchCost({ briefChars: 4_000, agents: agents(5) });
    expect(one.agentCount).toBe(1);
    expect(five.agentCount).toBe(5);
    expect(one.lowUsd).toBeGreaterThan(0);
    expect(one.lowUsd).toBeLessThanOrEqual(one.highUsd);
    expect(five.lowUsd).toBeCloseTo(one.lowUsd * 5, 5);
    expect(five.highUsd).toBeCloseTo(one.highUsd * 5, 5);
  });

  test("a higher effort level costs more than a lower one", () => {
    const low = estimateDispatchCost({ briefChars: 4_000, agents: agents(1, 3, 15, "low") });
    const max = estimateDispatchCost({ briefChars: 4_000, agents: agents(1, 3, 15, "max") });
    expect(max.highUsd).toBeGreaterThan(low.highUsd);
  });

  test("a longer brief raises the input side of the estimate", () => {
    const short = estimateDispatchCost({ briefChars: 1_000, agents: agents(1) });
    const long = estimateDispatchCost({ briefChars: 40_000, agents: agents(1) });
    expect(long.lowUsd).toBeGreaterThan(short.lowUsd);
  });
});

describe("checkCostForecast", () => {
  test("estimates at or below the threshold pass without asking", async () => {
    const estimate = estimateDispatchCost({ briefChars: 1_000, agents: agents(1) });
    await expect(
      checkCostForecast({ estimate, thresholdUsd: estimate.highUsd + 1 }),
    ).resolves.toBeUndefined();
    await expect(checkCostForecast({ estimate })).resolves.toBeUndefined();
  });

  test("above the threshold asks once/always-shaped and proceeds when approved", async () => {
    const estimate = estimateDispatchCost({ briefChars: 10_000, agents: agents(5) });
    let asked: string | undefined;
    await expect(
      checkCostForecast({
        estimate,
        thresholdUsd: 0.01,
        ask: async (request) => {
          asked = request.title;
          return "once";
        },
      }),
    ).resolves.toBeUndefined();
    expect(asked).toContain("estimated cost");
  });

  test("above the threshold with no approval surface refuses before anything spawns", async () => {
    const estimate = estimateDispatchCost({ briefChars: 10_000, agents: agents(5) });
    try {
      await checkCostForecast({ estimate, thresholdUsd: 0.01 });
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(AgencyError);
      expect((error as AgencyError).code).toBe(ErrorCode.PERMISSION_DENIED);
    }
  });

  test("a rejection above the threshold is PERMISSION_DENIED", async () => {
    const estimate = estimateDispatchCost({ briefChars: 10_000, agents: agents(5) });
    try {
      await checkCostForecast({ estimate, thresholdUsd: 0.01, ask: async () => "reject" });
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as AgencyError).code).toBe(ErrorCode.PERMISSION_DENIED);
    }
  });
});

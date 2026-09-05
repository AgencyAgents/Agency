import { describe, expect, test } from "bun:test";
import {
  type CheapRouteInput,
  isCheapEligible,
  pickCheapModel,
  selectModel,
  withCheapFallback,
} from "../src/cheap-router.ts";
import type { ModelInfo } from "../src/registry.ts";

function model(id: string, inputPerMTok: number, releaseDate?: string): ModelInfo {
  return {
    id,
    family: "f",
    contextWindow: 1000,
    maxOutputTokens: 100,
    pricing: { inputPerMTok, outputPerMTok: inputPerMTok },
    capabilities: { tools: false, vision: false, thinking: false },
    ...(releaseDate ? { releaseDate } : {}),
  };
}

describe("cheap router predicate", () => {
  test("titles, summaries, and cheap background work are eligible", () => {
    expect(isCheapEligible("title")).toBe(true);
    expect(isCheapEligible("summary")).toBe(true);
    expect(isCheapEligible("background")).toBe(true);
  });

  test("agentic coding turns are ineligible", () => {
    expect(isCheapEligible("code")).toBe(false);
    expect(isCheapEligible("tool_loop")).toBe(false);
    expect(isCheapEligible(undefined)).toBe(false);
    expect(isCheapEligible("")).toBe(false);
  });

  test("eligible kinds route to the cheap model with a tag", () => {
    const input: CheapRouteInput = { kind: "summary" };
    const sel = selectModel("primary-m", "cheap-m", input);
    expect(sel.model).toBe("cheap-m");
    expect(sel.routed).toBe("cheap");
    expect(sel.tag.length).toBeGreaterThan(0);
    expect(sel.tag).toContain("cheap");
  });

  test("ineligible kinds stay on primary", () => {
    const sel = selectModel("primary-m", "cheap-m", { kind: "code" });
    expect(sel.model).toBe("primary-m");
    expect(sel.routed).toBe("primary");
  });

  test("explicit override always wins over eligibility", () => {
    const sel = selectModel("primary-m", "cheap-m", { kind: "summary", forcePrimary: true });
    expect(sel.model).toBe("primary-m");
    expect(sel.routed).toBe("primary");
    expect(sel.tag).toContain("override");
  });

  test("missing cheap model stays on primary", () => {
    const sel = selectModel("primary-m", undefined, { kind: "summary" });
    expect(sel.model).toBe("primary-m");
    expect(sel.routed).toBe("primary");
  });

  test("fallback runs primary after a cheap failure", async () => {
    const calls: string[] = [];
    const result = await withCheapFallback(
      { model: "cheap-m", routed: "cheap", tag: "route=cheap kind=summary" },
      "primary-m",
      async (m: string) => {
        calls.push(m);
        if (m === "cheap-m") throw new Error("cheap down");
        return "ok";
      },
    );
    expect(result.value).toBe("ok");
    expect(result.model).toBe("primary-m");
    expect(result.fellBack).toBe(true);
    expect(calls).toEqual(["cheap-m", "primary-m"]);
  });

  test("no fallback when cheap succeeds", async () => {
    const result = await withCheapFallback(
      { model: "cheap-m", routed: "cheap", tag: "route=cheap kind=title" },
      "primary-m",
      async () => "fine",
    );
    expect(result.value).toBe("fine");
    expect(result.fellBack).toBe(false);
    expect(result.model).toBe("cheap-m");
  });

  test("primary selections never touch the cheap model", async () => {
    const calls: string[] = [];
    const result = await withCheapFallback(
      { model: "primary-m", routed: "primary", tag: "route=primary kind=code" },
      "primary-m",
      async (m: string) => {
        calls.push(m);
        return "ok";
      },
    );
    expect(calls).toEqual(["primary-m"]);
    expect(result.fellBack).toBe(false);
  });

  test("pickCheapModel prefers lowest cost then newest", () => {
    const picked = pickCheapModel([
      model("old-cheap", 0.5, "2026-01-01"),
      model("new-cheap", 0.5, "2026-06-01"),
      model("pricey", 15, "2026-07-01"),
    ]);
    expect(picked?.id).toBe("new-cheap");
  });
});

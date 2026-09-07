import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Redactor } from "@agency/guard";
import { createFileTelemetrySink, Telemetry } from "../src/telemetry.ts";
import { FEEDBACK_ROUTES, type FeedbackRoute, feedbackEventName, recordFeedbackUsage } from "../src/usage.ts";

function memorySink() {
  const events: Array<{ name: string; fields: Record<string, string | number | boolean | null> }> = [];
  const telemetry = new Telemetry({
    enabled: true,
    redactor: new Redactor(),
    sink: { write: (e) => void events.push({ name: e.name, fields: e.fields }) },
  });
  return { events, telemetry };
}

describe("feedback usage instrumentation", () => {
  test("covers exactly the route/compact/dispatch/gate paths", () => {
    expect([...FEEDBACK_ROUTES].sort()).toEqual(["compact", "dispatch", "gate", "route"]);
  });

  test("every path emits one observable event with its route field", () => {
    const { events, telemetry } = memorySink();
    const routes: FeedbackRoute[] = ["route", "compact", "dispatch", "gate"];
    for (const route of routes) {
      recordFeedbackUsage(telemetry, route, { reason: `${route}-probe` });
    }
    expect(events).toHaveLength(4);
    for (const route of routes) {
      const found = events.filter((e) => e.name === feedbackEventName(route));
      expect(found).toHaveLength(1);
      expect(found[0]!.fields.route).toBe(route);
    }
  });

  test("events persist through the file sink as JSONL", () => {
    const dir = mkdtempSync(join(tmpdir(), "agency-feedback-usage-test-"));
    const path = join(dir, "events.jsonl");
    const telemetry = new Telemetry({
      enabled: true,
      redactor: new Redactor(),
      sink: createFileTelemetrySink(path),
    });
    recordFeedbackUsage(telemetry, "dispatch", { reason: "unknown-handle" });
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as { name: string };
    expect(parsed.name).toBe(feedbackEventName("dispatch"));
    rmSync(dir, { recursive: true, force: true });
  });

  test("disabled telemetry records nothing", () => {
    const { events } = memorySink();
    void events;
    const off = new Telemetry({
      enabled: false,
      redactor: new Redactor(),
      sink: {
        write: () => {
          throw new Error("must not write");
        },
      },
    });
    recordFeedbackUsage(off, "gate", { reason: "pass-clean" });
  });
});

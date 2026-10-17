import { expect, test } from "bun:test";
import { attachVerifyGate, EventBus, HookBlock } from "../src/index.ts";

const after = (bus: EventBus, tool: string, input: Record<string, unknown>, isError = false) =>
  bus.emit("tool.execute.after", { tool, input, result: { content: "", isError }, turnId: "t1" });

const stop = async (bus: EventBus, taskDepth = 0): Promise<string[]> => {
  const { errors } = await bus.emitCollect("turn.stop", { turnId: "t1", taskDepth, stopHookActive: false });
  return errors.filter((e): e is HookBlock => e instanceof HookBlock).map((e) => e.message);
};

test("a turn that changed code and ran no passing check after is sent back once", async () => {
  const bus = new EventBus();
  attachVerifyGate(bus);
  after(bus, "edit", { path: "src/a.ts" });
  after(bus, "bash", { command: "bun test" }, true); // a failing check does not count
  const first = await stop(bus);
  expect(first).toHaveLength(1);
  expect(first[0]).toContain("src/a.ts");
  // Once per turn: the model may say that no check applies.
  expect(await stop(bus)).toEqual([]);
});

test("a passing check after the last edit, a change of prose only, or a worker's turn ends at once", async () => {
  const passed = new EventBus();
  attachVerifyGate(passed);
  after(passed, "write", { path: "src/a.ts" });
  after(passed, "bash", { command: "npx tsc --noEmit && npm test" });
  expect(await stop(passed)).toEqual([]);

  const prose = new EventBus();
  attachVerifyGate(prose);
  after(prose, "edit", { path: "README.md" });
  expect(await stop(prose)).toEqual([]);

  const worker = new EventBus();
  attachVerifyGate(worker);
  after(worker, "edit", { path: "src/a.ts" });
  expect(await stop(worker, 1)).toEqual([]);

  // An edit after the check opens the gate again.
  const late = new EventBus();
  attachVerifyGate(late);
  after(late, "bash", { command: "cargo test" });
  after(late, "edit", { path: "src/lib.rs" });
  expect(await stop(late)).toHaveLength(1);
});

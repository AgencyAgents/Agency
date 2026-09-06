interface FakeStore {
  append(sid: string, entry: { type: string }): Promise<{ id: string }>;
}

declare const todoStore: FakeStore;
declare const logger: { warn(msg: string, fields?: Record<string, unknown>): void };

export async function silent(): Promise<void> {
  try {
    await todoStore.append("s", { type: "x" });
  } catch {}
}

export async function logged(): Promise<void> {
  try {
    await todoStore.append("s", { type: "x" });
  } catch (error: unknown) {
    logger.warn("append failed", { error: String(error) });
  }
}

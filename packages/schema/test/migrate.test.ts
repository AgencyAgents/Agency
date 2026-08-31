import { describe, expect, test } from "bun:test";
import { migrate, MigrationError, type Migration, type VersionedRecord } from "../src/migrate.ts";

// v0 shipped `model` as a bare string. v1 splits it into provider + model.
const v0ToV1: Migration = {
  from: 0,
  to: 1,
  migrate(record) {
    const legacy = record.model as string;
    const [provider, model] = legacy.split("/");
    const { model: _old, ...rest } = record;
    return { ...rest, provider, model };
  },
};

const v1ToV2: Migration = {
  from: 1,
  to: 2,
  migrate(record) {
    return { ...record, thinkingLevel: "off" };
  },
};

const migrations = [v0ToV1, v1ToV2];

describe("migrate", () => {
  test("round-trips a v0 record forward to v2 through both steps", () => {
    const v0: VersionedRecord = {
      schemaVersion: 0,
      model: "anthropic/claude-opus-5",
      sessionId: "s1",
    };

    const result = migrate(v0, migrations, 2);

    expect(result).toEqual({
      schemaVersion: 2,
      provider: "anthropic",
      model: "claude-opus-5",
      sessionId: "s1",
      thinkingLevel: "off",
    });
  });

  test("preserves fields no migration in the chain knows about", () => {
    const v1: VersionedRecord = {
      schemaVersion: 1,
      provider: "openai",
      model: "gpt-5",
      // written by a newer client than this migration chain was authored against
      futureField: { nested: true },
    };

    const result = migrate(v1, migrations, 2);

    expect(result.futureField).toEqual({ nested: true });
    expect(result.thinkingLevel).toBe("off");
  });

  test("is a no-op when already at the target version", () => {
    const v2: VersionedRecord = { schemaVersion: 2, provider: "anthropic", model: "opus", thinkingLevel: "high" };
    expect(migrate(v2, migrations, 2)).toEqual(v2);
  });

  test("throws when no path exists to the target version", () => {
    const v0: VersionedRecord = { schemaVersion: 0, model: "anthropic/claude-opus-5" };
    expect(() => migrate(v0, migrations, 5)).toThrow(MigrationError);
  });

  test("throws when the record is newer than the target version", () => {
    const v2: VersionedRecord = { schemaVersion: 2, provider: "a", model: "b", thinkingLevel: "off" };
    expect(() => migrate(v2, migrations, 1)).toThrow(MigrationError);
  });
});

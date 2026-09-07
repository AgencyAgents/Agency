/**
 * Generic forward-migration framework for anything Agency persists (config, sessions).
 * A migration only touches the fields it cares about; every other key on the record
 * passes through untouched (R5: an older migration must never drop a newer client's field).
 */

export type VersionedRecord = { schemaVersion: number } & Record<string, unknown>;

export interface Migration {
  readonly from: number;
  readonly to: number;
  migrate(record: Record<string, unknown>): Record<string, unknown>;
}

export class MigrationError extends Error {
  constructor(
    readonly fromVersion: number,
    readonly targetVersion: number,
  ) {
    super(`no migration path from schema v${fromVersion} to v${targetVersion}`);
    this.name = "MigrationError";
  }
}

/** Runs every applicable migration in order, returning the record at `targetVersion`. */
export function migrate(
  record: VersionedRecord,
  migrations: readonly Migration[],
  targetVersion: number,
): VersionedRecord {
  let current = record;

  while (current.schemaVersion < targetVersion) {
    const step = migrations.find((m) => m.from === current.schemaVersion);
    if (!step) {
      throw new MigrationError(current.schemaVersion, targetVersion);
    }
    const { schemaVersion: _dropped, ...rest } = current;
    current = { ...step.migrate(rest), schemaVersion: step.to };
  }

  if (current.schemaVersion > targetVersion) {
    throw new MigrationError(current.schemaVersion, targetVersion);
  }

  return current;
}

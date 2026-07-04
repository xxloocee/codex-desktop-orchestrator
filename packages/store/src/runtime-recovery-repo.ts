import {
  ACTIVE_BRIDGE_TURN_STATUSES,
  BridgeTurnStatus
} from "../../domain/src/turn.js";
import type { SqliteDatabase } from "./sqlite.js";

export type RuntimeRecoveryReport = {
  recoveredAt: string;
  timedOutTurns: number;
  orphanedTurns: number;
  clearedSessionLocks: number;
  clearedThreadLocks: number;
  remainingActiveTurns: number;
};

export type RuntimeDoctorReport = {
  checkedAt: string;
  activeTurns: number;
  expiredActiveTurns: number;
  orphanableActiveTurns: number;
  sessionLocks: {
    total: number;
    expired: number;
  };
  threadLocks: {
    total: number;
    expired: number;
  };
};

export class SqliteRuntimeRecoveryStore {
  constructor(private readonly db: SqliteDatabase) {}

  recoverAbandonedState(now = new Date().toISOString()): RuntimeRecoveryReport {
    const timedOutTurns = this.db
      .prepare(
        `UPDATE bridge_turns
         SET status = ?,
             last_error = COALESCE(last_error, ?),
             updated_at = ?
         WHERE status IN (${activeStatusPlaceholders()})
           AND status != ?
           AND deadline_at IS NOT NULL
           AND deadline_at <= ?`
      )
      .run(
        BridgeTurnStatus.TimedOut,
        "Bridge daemon restarted after the turn deadline; marked timed-out.",
        now,
        ...ACTIVE_BRIDGE_TURN_STATUSES,
        BridgeTurnStatus.Queued,
        now
      ).changes;

    const orphanedTurns = this.db
      .prepare(
        `UPDATE bridge_turns
         SET status = ?,
             last_error = COALESCE(last_error, ?),
             updated_at = ?
         WHERE status IN (${activeStatusPlaceholders()})`
      )
      .run(
        BridgeTurnStatus.Orphaned,
        "Bridge daemon restarted before the turn finished; marked orphaned.",
        now,
        ...ACTIVE_BRIDGE_TURN_STATUSES
      ).changes;

    const clearedSessionLocks = this.db.prepare(`DELETE FROM session_locks`).run().changes;
    const clearedThreadLocks = this.db.prepare(`DELETE FROM thread_locks`).run().changes;

    return {
      recoveredAt: now,
      timedOutTurns,
      orphanedTurns,
      clearedSessionLocks,
      clearedThreadLocks,
      remainingActiveTurns: countRows(
        this.db,
        `SELECT COUNT(*) AS count
         FROM bridge_turns
         WHERE status IN (${activeStatusPlaceholders()})`,
        ACTIVE_BRIDGE_TURN_STATUSES
      )
    };
  }

  inspect(now = new Date().toISOString()): RuntimeDoctorReport {
    const hasBridgeTurns = tableExists(this.db, "bridge_turns");
    const hasSessionLocks = tableExists(this.db, "session_locks");
    const hasThreadLocks = tableExists(this.db, "thread_locks");

    return {
      checkedAt: now,
      activeTurns: hasBridgeTurns
        ? countRows(
            this.db,
            `SELECT COUNT(*) AS count
             FROM bridge_turns
             WHERE status IN (${activeStatusPlaceholders()})`,
            ACTIVE_BRIDGE_TURN_STATUSES
          )
        : 0,
      expiredActiveTurns: hasBridgeTurns
        ? countRows(
            this.db,
            `SELECT COUNT(*) AS count
             FROM bridge_turns
             WHERE status IN (${activeStatusPlaceholders()})
               AND status != ?
               AND deadline_at IS NOT NULL
               AND deadline_at <= ?`,
            [...ACTIVE_BRIDGE_TURN_STATUSES, BridgeTurnStatus.Queued, now]
          )
        : 0,
      orphanableActiveTurns: hasBridgeTurns
        ? countRows(
            this.db,
            `SELECT COUNT(*) AS count
             FROM bridge_turns
             WHERE status IN (${activeStatusPlaceholders()})
                AND (status = ? OR deadline_at IS NULL OR deadline_at > ?)`,
            [...ACTIVE_BRIDGE_TURN_STATUSES, BridgeTurnStatus.Queued, now]
          )
        : 0,
      sessionLocks: hasSessionLocks
        ? inspectLockTable(this.db, "session_locks", now)
        : emptyLockReport(),
      threadLocks: hasThreadLocks
        ? inspectLockTable(this.db, "thread_locks", now)
        : emptyLockReport()
    };
  }
}

function activeStatusPlaceholders(): string {
  return ACTIVE_BRIDGE_TURN_STATUSES.map(() => "?").join(", ");
}

function inspectLockTable(
  db: SqliteDatabase,
  tableName: "session_locks" | "thread_locks",
  now: string
): { total: number; expired: number } {
  return {
    total: countRows(db, `SELECT COUNT(*) AS count FROM ${tableName}`),
    expired: countRows(db, `SELECT COUNT(*) AS count FROM ${tableName} WHERE expires_at <= ?`, [now])
  };
}

function emptyLockReport(): { total: number; expired: number } {
  return { total: 0, expired: 0 };
}

function tableExists(db: SqliteDatabase, tableName: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS found
       FROM sqlite_master
       WHERE type = 'table'
         AND name = ?
       LIMIT 1`
    )
    .get(tableName) as { found?: number } | undefined;
  return row?.found === 1;
}

function countRows(
  db: SqliteDatabase,
  sql: string,
  params: readonly unknown[] = []
): number {
  const row = db.prepare(sql).get(...params) as { count?: number } | undefined;
  return Number(row?.count ?? 0);
}

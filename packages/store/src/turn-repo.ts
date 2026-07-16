import {
  ACTIVE_BRIDGE_TURN_STATUSES,
  BridgeTurnStatus,
  type BridgeTurnEventRecord,
  type BridgeTurnRecord,
  type CreateBridgeTurn
} from "../../domain/src/turn.js";
import { TurnEventType, type ToolEventStatus } from "../../domain/src/message.js";
import type { TurnStorePort } from "../../ports/src/store.js";
import type { SqliteDatabase } from "./sqlite.js";

type TurnRow = BridgeTurnRecord;

export class SqliteTurnStore implements TurnStorePort {
  constructor(private readonly db: SqliteDatabase) {}

  async createTurn(turn: CreateBridgeTurn): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO bridge_turns (
          turn_id, session_key, codex_thread_ref, codex_turn_ref, qq_message_id,
          status, started_at, updated_at, deadline_at, last_event_at,
          last_tool_name, last_error, delivered_text_length
        ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0)`
      )
      .run(
        turn.turnId,
        turn.sessionKey,
        turn.codexThreadRef,
        turn.qqMessageId,
        turn.status,
        turn.startedAt,
        turn.startedAt,
        turn.deadlineAt ?? null
      );
  }

  async attachCodexTurn(turnId: string, codexTurnRef: string): Promise<void> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE bridge_turns
         SET codex_turn_ref = ?, updated_at = ?
         WHERE turn_id = ?`
      )
      .run(codexTurnRef, now, turnId);
  }

  async updateCodexThreadRef(turnId: string, codexThreadRef: string | null): Promise<void> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE bridge_turns
         SET codex_thread_ref = ?, updated_at = ?
         WHERE turn_id = ?`
      )
      .run(codexThreadRef, now, turnId);
  }

  async updateStatus(
    turnId: string,
    status: BridgeTurnStatus,
    lastError: string | null = null,
    updatedAt = new Date().toISOString()
  ): Promise<void> {
    this.db
      .prepare(
        `UPDATE bridge_turns
         SET status = ?, last_error = ?, updated_at = ?
         WHERE turn_id = ?`
      )
      .run(status, lastError, updatedAt, turnId);
  }

  async markRunningIfActive(
    turnId: string,
    deadlineAt: string | null,
    preserveDeadline = false
  ): Promise<boolean> {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE bridge_turns
         SET status = ?,
             deadline_at = CASE WHEN ? = 1 THEN deadline_at ELSE ? END,
             updated_at = ?
         WHERE turn_id = ?
           AND status IN (?, ?, ?, ?)`
      )
      .run(
        BridgeTurnStatus.Running,
        preserveDeadline ? 1 : 0,
        deadlineAt,
        now,
        turnId,
        ...ACTIVE_BRIDGE_TURN_STATUSES
      );
    return result.changes > 0;
  }

  async markQueuedIfActive(turnId: string, preserveDeadline = false): Promise<boolean> {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE bridge_turns
         SET status = ?,
             deadline_at = CASE WHEN ? = 1 THEN deadline_at ELSE NULL END,
             updated_at = ?
         WHERE turn_id = ?
           AND status IN (?, ?, ?, ?)`
      )
      .run(
        BridgeTurnStatus.Queued,
        preserveDeadline ? 1 : 0,
        now,
        turnId,
        ...ACTIVE_BRIDGE_TURN_STATUSES
      );
    return result.changes > 0;
  }

  async markStreamingIfActive(
    turnId: string,
    codexTurnRef: string,
    eventAt: string
  ): Promise<boolean> {
    const result = this.db
      .prepare(
        `UPDATE bridge_turns
         SET status = ?,
             codex_turn_ref = COALESCE(codex_turn_ref, ?),
             last_event_at = ?,
             updated_at = ?
         WHERE turn_id = ?
           AND status IN (?, ?, ?, ?)`
      )
      .run(
        BridgeTurnStatus.Streaming,
        codexTurnRef,
        eventAt,
        eventAt,
        turnId,
        ...ACTIVE_BRIDGE_TURN_STATUSES
      );
    return result.changes > 0;
  }

  async markTerminalIfActive(
    turnId: string,
    status: BridgeTurnStatus,
    lastError: string | null = null
  ): Promise<boolean> {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE bridge_turns
         SET status = ?,
             last_error = ?,
             updated_at = ?
         WHERE turn_id = ?
           AND status IN (?, ?, ?, ?)`
      )
      .run(
        status,
        lastError,
        now,
        turnId,
        ...ACTIVE_BRIDGE_TURN_STATUSES
      );
    return result.changes > 0;
  }

  async updateDeadline(turnId: string, deadlineAt: string | null): Promise<void> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE bridge_turns
         SET deadline_at = ?,
             updated_at = ?
         WHERE turn_id = ?`
      )
      .run(deadlineAt, now, turnId);
  }

  async recordTurnEvent(input: {
    sessionKey: string;
    codexTurnRef: string;
    qqMessageId?: string | null;
    status: BridgeTurnStatus;
    eventAt: string;
    eventType?: TurnEventType;
    lastToolName?: string | null;
    toolStatus?: ToolEventStatus | null;
    summary?: string | null;
    lastError?: string | null;
  }): Promise<void> {
    this.db
      .prepare(
        `UPDATE bridge_turns
         SET status = ?,
             last_event_at = ?,
             updated_at = ?,
             last_tool_name = COALESCE(?, last_tool_name),
             last_error = COALESCE(?, last_error),
             codex_turn_ref = COALESCE(codex_turn_ref, ?)
         WHERE turn_id = (
           SELECT turn_id
           FROM bridge_turns
           WHERE session_key = ?
             AND (
               codex_turn_ref = ?
               OR (codex_turn_ref IS NULL AND (? IS NULL OR qq_message_id = ?))
             )
             AND status IN (${ACTIVE_BRIDGE_TURN_STATUSES.map(() => "?").join(", ")})
           ORDER BY CASE WHEN codex_turn_ref = ? THEN 0 ELSE 1 END,
                    CASE WHEN qq_message_id = ? THEN 0 ELSE 1 END,
                    CASE WHEN status = ? THEN 1 ELSE 0 END,
                    started_at DESC
           LIMIT 1
         )`
      )
      .run(
        input.status,
        input.eventAt,
        input.eventAt,
        input.lastToolName ?? null,
        input.lastError ?? null,
        input.codexTurnRef,
        input.sessionKey,
        input.codexTurnRef,
        input.qqMessageId ?? null,
        input.qqMessageId ?? null,
        ...ACTIVE_BRIDGE_TURN_STATUSES,
        input.codexTurnRef,
        input.qqMessageId ?? null,
        BridgeTurnStatus.Queued
      );

    const turn = await this.getTurnByCodexTurn(
      input.sessionKey,
      input.codexTurnRef,
      input.qqMessageId ?? null
    );
    if (turn) {
      this.db
        .prepare(
          `INSERT INTO bridge_turn_events (
             turn_id, event_type, status, event_at, tool_name,
             tool_status, summary, error
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          turn.turnId,
          input.eventType ?? TurnEventType.Status,
          input.status,
          input.eventAt,
          input.lastToolName ?? null,
          input.toolStatus ?? null,
          input.summary ?? null,
          input.lastError ?? null
        );
    }
  }

  async addDeliveredText(turnId: string, textLength: number): Promise<void> {
    if (textLength <= 0) {
      return;
    }

    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE bridge_turns
         SET delivered_text_length = delivered_text_length + ?,
             updated_at = ?
         WHERE turn_id = ?`
      )
      .run(textLength, now, turnId);
  }

  async getCurrentTurn(sessionKey: string): Promise<BridgeTurnRecord | null> {
    const placeholders = ACTIVE_BRIDGE_TURN_STATUSES.map(() => "?").join(", ");
    const row = this.db
      .prepare(
        `SELECT ${TURN_COLUMNS}
         FROM bridge_turns
         WHERE session_key = ?
           AND status IN (${placeholders})
          ORDER BY CASE
                     WHEN status = ? THEN 1
                     ELSE 0
                   END,
                   updated_at DESC
          LIMIT 1`
      )
      .get(
        sessionKey,
        ...ACTIVE_BRIDGE_TURN_STATUSES,
        BridgeTurnStatus.Queued
      ) as TurnRow | undefined;

    return row ?? null;
  }

  async getTurn(turnId: string): Promise<BridgeTurnRecord | null> {
    const row = this.db
      .prepare(
        `SELECT ${TURN_COLUMNS}
         FROM bridge_turns
         WHERE turn_id = ?`
      )
      .get(turnId) as TurnRow | undefined;

    return row ?? null;
  }

  async getTurnByCodexTurn(
    sessionKey: string,
    codexTurnRef: string,
    qqMessageId: string | null = null
  ): Promise<BridgeTurnRecord | null> {
    const row = this.db
      .prepare(
        `SELECT ${TURN_COLUMNS}
         FROM bridge_turns
         WHERE session_key = ?
           AND (
             codex_turn_ref = ?
             OR (codex_turn_ref IS NULL AND (? IS NULL OR qq_message_id = ?))
           )
         ORDER BY CASE WHEN codex_turn_ref = ? THEN 0 ELSE 1 END,
                  CASE WHEN qq_message_id = ? THEN 0 ELSE 1 END,
                  CASE WHEN status = ? THEN 1 ELSE 0 END,
                  started_at DESC
         LIMIT 1`
      )
      .get(
        sessionKey,
        codexTurnRef,
        qqMessageId,
        qqMessageId,
        codexTurnRef,
        qqMessageId,
        BridgeTurnStatus.Queued
      ) as TurnRow | undefined;

    return row ?? null;
  }

  async listRecentTurns(sessionKey: string, limit: number): Promise<BridgeTurnRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT ${TURN_COLUMNS}
         FROM bridge_turns
         WHERE session_key = ?
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .all(sessionKey, Math.max(1, limit)) as TurnRow[];

    return rows;
  }

  async listRecentTurnsAll(limit: number): Promise<BridgeTurnRecord[]> {
    return this.db
      .prepare(
        `SELECT ${TURN_COLUMNS}
         FROM bridge_turns
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .all(Math.max(1, limit)) as TurnRow[];
  }

  async listTurnEvents(turnId: string, limit: number): Promise<BridgeTurnEventRecord[]> {
    const eventTable = this.db
      .prepare(
        `SELECT 1 AS found
         FROM sqlite_master
         WHERE type = 'table' AND name = 'bridge_turn_events'
         LIMIT 1`
      )
      .get() as { found?: number } | undefined;
    if (eventTable?.found !== 1) {
      return [];
    }

    const rows = this.db
      .prepare(
        `SELECT event_id AS eventId,
                turn_id AS turnId,
                event_type AS eventType,
                status,
                event_at AS eventAt,
                tool_name AS toolName,
                tool_status AS toolStatus,
                summary,
                error
         FROM bridge_turn_events
         WHERE turn_id = ?
         ORDER BY event_at DESC, event_id DESC
         LIMIT ?`
      )
      .all(turnId, Math.max(1, limit)) as BridgeTurnEventRecord[];
    return rows.reverse();
  }
}

const TURN_COLUMNS = `
  turn_id AS turnId,
  session_key AS sessionKey,
  codex_thread_ref AS codexThreadRef,
  codex_turn_ref AS codexTurnRef,
  qq_message_id AS qqMessageId,
  status,
  started_at AS startedAt,
  updated_at AS updatedAt,
  deadline_at AS deadlineAt,
  last_event_at AS lastEventAt,
  last_tool_name AS lastToolName,
  last_error AS lastError,
  delivered_text_length AS deliveredTextLength
`;

import {
  DeliveryJobStatus,
  type DeliveryJobRecord,
  type OutboundDraft
} from "../../domain/src/message.js";
import type { DeliveryJobStorePort } from "../../ports/src/store.js";
import type { SqliteDatabase } from "./sqlite.js";

type DeliveryJobRow = {
  jobId: string;
  sessionKey: string;
  status: DeliveryJobStatus;
  attemptCount: number;
  payloadJson: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  nextAttemptAt: string | null;
  deliveredAt: string | null;
  providerMessageId: string | null;
};

export class SqliteDeliveryJobStore implements DeliveryJobStorePort {
  constructor(private readonly db: SqliteDatabase) {}

  async claimDueJobs(input: { limit: number; now: string }): Promise<DeliveryJobRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT ${DELIVERY_JOB_COLUMNS}
         FROM delivery_jobs
         WHERE status = ?
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY created_at ASC
         LIMIT ?`
      )
      .all(DeliveryJobStatus.Pending, input.now, Math.max(1, input.limit)) as DeliveryJobRow[];

    const jobs: DeliveryJobRecord[] = [];
    for (const row of rows) {
      const updated = this.db
        .prepare(
          `UPDATE delivery_jobs
           SET status = ?,
               attempt_count = attempt_count + 1,
               updated_at = ?
           WHERE job_id = ?
             AND status = ?`
        )
        .run(DeliveryJobStatus.InFlight, input.now, row.jobId, DeliveryJobStatus.Pending);
      if (updated.changes === 0) {
        continue;
      }
      jobs.push({
        ...mapDeliveryJobRow(row),
        status: DeliveryJobStatus.InFlight,
        attemptCount: row.attemptCount + 1,
        updatedAt: input.now
      });
    }

    return jobs;
  }

  async markDelivered(input: {
    jobId: string;
    deliveredAt: string;
    providerMessageId?: string | null;
  }): Promise<void> {
    this.db
      .prepare(
        `UPDATE delivery_jobs
         SET status = ?,
             delivered_at = ?,
             provider_message_id = ?,
             last_error = NULL,
             updated_at = ?,
             next_attempt_at = NULL
         WHERE job_id = ?`
      )
      .run(
        DeliveryJobStatus.Delivered,
        input.deliveredAt,
        input.providerMessageId ?? null,
        input.deliveredAt,
        input.jobId
      );
  }

  async markAttemptFailed(input: {
    jobId: string;
    failedAt: string;
    error: string;
    maxAttempts: number;
    retryAfterMs: number;
  }): Promise<void> {
    const row = this.db
      .prepare(`SELECT attempt_count AS attemptCount FROM delivery_jobs WHERE job_id = ?`)
      .get(input.jobId) as { attemptCount: number } | undefined;
    const attempts = row?.attemptCount ?? 0;
    const willRetry = attempts < input.maxAttempts;
    const nextAttemptAt = willRetry
      ? new Date(Date.parse(input.failedAt) + input.retryAfterMs).toISOString()
      : null;

    this.db
      .prepare(
        `UPDATE delivery_jobs
         SET status = ?,
             last_error = ?,
             updated_at = ?,
             next_attempt_at = ?
         WHERE job_id = ?`
      )
      .run(
        willRetry ? DeliveryJobStatus.Pending : DeliveryJobStatus.Failed,
        input.error,
        input.failedAt,
        nextAttemptAt,
        input.jobId
      );
  }

  async recoverInFlight(now: string): Promise<number> {
    const result = this.db
      .prepare(
        `UPDATE delivery_jobs
         SET status = ?,
             last_error = ?,
             updated_at = ?,
             next_attempt_at = NULL
         WHERE status = ?`
      )
      .run(
        DeliveryJobStatus.Failed,
        "Delivery result unknown after restart; not retried automatically.",
        now,
        DeliveryJobStatus.InFlight
      );
    return result.changes;
  }

  async listJobs(input: {
    sessionKey: string;
    statuses?: DeliveryJobStatus[];
    limit: number;
  }): Promise<DeliveryJobRecord[]> {
    const statuses = input.statuses ?? [
      DeliveryJobStatus.Pending,
      DeliveryJobStatus.InFlight,
      DeliveryJobStatus.Failed
    ];
    const placeholders = statuses.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT ${DELIVERY_JOB_COLUMNS}
         FROM delivery_jobs
         WHERE session_key = ?
           AND status IN (${placeholders})
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .all(input.sessionKey, ...statuses, Math.max(1, input.limit)) as DeliveryJobRow[];

    return rows.map(mapDeliveryJobRow);
  }
}

const DELIVERY_JOB_COLUMNS = `
  job_id AS jobId,
  session_key AS sessionKey,
  status,
  attempt_count AS attemptCount,
  payload_json AS payloadJson,
  last_error AS lastError,
  created_at AS createdAt,
  updated_at AS updatedAt,
  next_attempt_at AS nextAttemptAt,
  delivered_at AS deliveredAt,
  provider_message_id AS providerMessageId
`;

function mapDeliveryJobRow(row: DeliveryJobRow): DeliveryJobRecord {
  return {
    jobId: row.jobId,
    sessionKey: row.sessionKey,
    status: row.status,
    attemptCount: row.attemptCount,
    payload: JSON.parse(row.payloadJson) as OutboundDraft,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    nextAttemptAt: row.nextAttemptAt,
    deliveredAt: row.deliveredAt,
    providerMessageId: row.providerMessageId
  };
}

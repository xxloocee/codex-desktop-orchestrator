import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const BetterSqlite3 = require("better-sqlite3") as new (
  filePath: string,
  options?: { readonly?: boolean; fileMustExist?: boolean }
) => SqliteDatabase;

export type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  };
  close(): void;
};

export function createSqliteDatabase(filePath: string): SqliteDatabase {
  if (filePath !== ":memory:") {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  const db = new BetterSqlite3(filePath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS bridge_sessions (
      session_key TEXT PRIMARY KEY,
      account_key TEXT NOT NULL,
      peer_key TEXT NOT NULL,
      chat_type TEXT NOT NULL,
      peer_id TEXT NOT NULL,
      codex_thread_ref TEXT,
      last_codex_turn_id TEXT,
      skill_context_key TEXT,
      status TEXT NOT NULL,
      last_inbound_at TEXT,
      last_outbound_at TEXT,
      last_error TEXT
    );

    CREATE TABLE IF NOT EXISTS message_ledger (
      message_id TEXT PRIMARY KEY,
      session_key TEXT NOT NULL,
      direction TEXT NOT NULL,
      qq_message_ref TEXT,
      codex_turn_ref TEXT,
      content_digest TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS delivery_jobs (
      job_id TEXT PRIMARY KEY,
      session_key TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      next_attempt_at TEXT,
      delivered_at TEXT,
      provider_message_id TEXT
    );

    CREATE TABLE IF NOT EXISTS session_locks (
      session_key TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      locked_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bridge_turns (
      turn_id TEXT PRIMARY KEY,
      session_key TEXT NOT NULL,
      codex_thread_ref TEXT,
      codex_turn_ref TEXT,
      qq_message_id TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deadline_at TEXT,
      last_event_at TEXT,
      last_tool_name TEXT,
      last_error TEXT,
      delivered_text_length INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS thread_locks (
      thread_ref TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      locked_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bridge_turn_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      turn_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      status TEXT NOT NULL,
      event_at TEXT NOT NULL,
      tool_name TEXT,
      tool_status TEXT,
      summary TEXT,
      error TEXT
    );

    CREATE INDEX IF NOT EXISTS bridge_turn_events_turn_id_event_at
      ON bridge_turn_events (turn_id, event_at);
  `);

  ensureColumn(db, "bridge_sessions", "skill_context_key", "TEXT");
  ensureColumn(db, "bridge_sessions", "last_codex_turn_id", "TEXT");
  ensureColumn(db, "bridge_sessions", "conversation_provider", "TEXT");
  ensureColumn(db, "bridge_turns", "codex_turn_ref", "TEXT");
  ensureColumn(db, "bridge_turns", "delivered_text_length", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "delivery_jobs", "next_attempt_at", "TEXT");
  ensureColumn(db, "delivery_jobs", "delivered_at", "TEXT");
  ensureColumn(db, "delivery_jobs", "provider_message_id", "TEXT");
  migrateLegacyPendingDeliveryJobs(db);

  return db;
}

export function openReadonlySqliteDatabase(filePath: string): SqliteDatabase {
  return new BetterSqlite3(filePath, {
    readonly: true,
    fileMustExist: true
  });
}

function migrateLegacyPendingDeliveryJobs(db: SqliteDatabase): void {
  db.prepare(
    `UPDATE delivery_jobs
     SET status = 'delivered',
         delivered_at = updated_at,
         next_attempt_at = NULL
     WHERE status = 'pending'
       AND attempt_count = 0
       AND next_attempt_at IS NULL
       AND delivered_at IS NULL
       AND provider_message_id IS NULL`
  ).run();
}

function ensureColumn(
  db: SqliteDatabase,
  tableName: string,
  columnName: string,
  columnDefinition: string
): void {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: string }>;
  const hasColumn = columns.some((column) => column.name === columnName);
  if (!hasColumn) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
  }
}

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import { describe, expect, it, afterEach, vi } from "vitest";
import { BridgeSessionStatus } from "../../packages/domain/src/session.js";
import { buildPeerKey, buildSessionKey } from "../../packages/orchestrator/src/session-key.js";
import { createSqliteDatabase } from "../../packages/store/src/sqlite.js";
import { SqliteSessionStore } from "../../packages/store/src/session-repo.js";
import { SqliteTranscriptStore } from "../../packages/store/src/message-repo.js";
import { SqliteTurnStore } from "../../packages/store/src/turn-repo.js";
import { SqliteThreadLockStore } from "../../packages/store/src/thread-lock-repo.js";
import { SqliteDeliveryJobStore } from "../../packages/store/src/delivery-job-repo.js";
import { SqliteRuntimeRecoveryStore } from "../../packages/store/src/runtime-recovery-repo.js";
import { BridgeTurnStatus } from "../../packages/domain/src/turn.js";
import { DeliveryJobStatus } from "../../packages/domain/src/message.js";
import type { SqliteDatabase } from "../../packages/store/src/sqlite.js";

const require = createRequire(import.meta.url);
const BetterSqlite3 = require("better-sqlite3") as new (filePath: string) => SqliteDatabase;

describe("sqlite store", () => {
  const tempDirs: string[] = [];
  const openDbs: SqliteDatabase[] = [];

  afterEach(() => {
    while (openDbs.length > 0) {
      openDbs.pop()?.close();
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function createTempDbPath(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "codex-desktop-orchestrator-"));
    tempDirs.push(dir);
    return path.join(dir, "data", "bridge.sqlite");
  }

  function createTempDb(): SqliteDatabase {
    const db = createSqliteDatabase(createTempDbPath());
    openDbs.push(db);
    return db;
  }

  function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;

    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    return { promise, resolve, reject };
  }

  it("persists a session that can be read back as active", async () => {
    const db = createTempDb();
    const sessionStore = new SqliteSessionStore(db);

    const sessionKey = buildSessionKey({
      accountKey: "qqbot:default",
      peerKey: buildPeerKey({ chatType: "c2c", peerId: "abc-123" })
    });

    await sessionStore.createSession({
      sessionKey,
      accountKey: "qqbot:default",
      peerKey: "qq:c2c:abc-123",
      chatType: "c2c",
      peerId: "abc-123",
      codexThreadRef: null,
      lastCodexTurnId: null,
      skillContextKey: null,
      conversationProvider: null,
      status: BridgeSessionStatus.Active,
      lastInboundAt: null,
      lastOutboundAt: null,
      lastError: null
    });

    const session = await sessionStore.getSession(sessionKey);

    expect(session).toEqual({
      sessionKey,
      accountKey: "qqbot:default",
      peerKey: "qq:c2c:abc-123",
      chatType: "c2c",
      peerId: "abc-123",
      codexThreadRef: null,
      lastCodexTurnId: null,
      skillContextKey: null,
      conversationProvider: null,
      status: BridgeSessionStatus.Active,
      lastInboundAt: null,
      lastOutboundAt: null,
      lastError: null
    });
  });

  it("persists and updates the latest codex turn id on the session", async () => {
    const db = createTempDb();
    const sessionStore = new SqliteSessionStore(db);

    const sessionKey = buildSessionKey({
      accountKey: "qqbot:default",
      peerKey: buildPeerKey({ chatType: "c2c", peerId: "abc-456" })
    });

    await sessionStore.createSession({
      sessionKey,
      accountKey: "qqbot:default",
      peerKey: "qq:c2c:abc-456",
      chatType: "c2c",
      peerId: "abc-456",
      codexThreadRef: "codex-thread:page-1:thread-a",
      lastCodexTurnId: null,
      skillContextKey: null,
      conversationProvider: null,
      status: BridgeSessionStatus.Active,
      lastInboundAt: null,
      lastOutboundAt: null,
      lastError: null
    });

    await sessionStore.updateLastCodexTurnId(sessionKey, "turn-local-123");

    await expect(sessionStore.getSession(sessionKey)).resolves.toMatchObject({
      sessionKey,
      lastCodexTurnId: "turn-local-123"
    });
  });

  it("persists turn status and lists active/recent turns", async () => {
    const db = createTempDb();
    const turnStore = new SqliteTurnStore(db);
    const sessionKey = "qqbot:default::qq:c2c:abc-123";

    await turnStore.createTurn({
      turnId: "bridge-turn-1",
      sessionKey,
      codexThreadRef: "codex-app-thread:thread-1",
      qqMessageId: "msg-1",
      status: BridgeTurnStatus.Running,
      startedAt: "2026-07-01T10:00:00.000Z"
    });
    await turnStore.attachCodexTurn("bridge-turn-1", "codex-turn-1");
    await turnStore.addDeliveredText("bridge-turn-1", 12);

    await expect(turnStore.getCurrentTurn(sessionKey)).resolves.toMatchObject({
      turnId: "bridge-turn-1",
      codexTurnRef: "codex-turn-1",
      status: BridgeTurnStatus.Running,
      deliveredTextLength: 12
    });

    await turnStore.recordTurnEvent({
      sessionKey,
      codexTurnRef: "codex-turn-1",
      status: BridgeTurnStatus.Completed,
      eventAt: "2026-07-01T10:00:05.000Z",
      lastToolName: "pnpm run check"
    });

    await expect(turnStore.getCurrentTurn(sessionKey)).resolves.toBeNull();
    await expect(turnStore.listRecentTurns(sessionKey, 5)).resolves.toEqual([
      expect.objectContaining({
        turnId: "bridge-turn-1",
        status: BridgeTurnStatus.Completed,
        lastEventAt: "2026-07-01T10:00:05.000Z",
        lastToolName: "pnpm run check"
      })
    ]);
  });

  it("does not let late turn events overwrite terminal tasks", async () => {
    const db = createTempDb();
    const turnStore = new SqliteTurnStore(db);
    const sessionKey = "qqbot:default::qq:c2c:abc-123";

    for (const status of [
      BridgeTurnStatus.Cancelled,
      BridgeTurnStatus.TimedOut,
      BridgeTurnStatus.Failed,
      BridgeTurnStatus.Orphaned
    ]) {
      const turnId = `bridge-turn-${status}`;
      const codexTurnRef = `codex-turn-${status}`;
      await turnStore.createTurn({
        turnId,
        sessionKey,
        codexThreadRef: "codex-app-thread:thread-1",
        qqMessageId: `msg-${status}`,
        status: BridgeTurnStatus.Running,
        startedAt: "2026-07-01T10:00:00.000Z"
      });
      await turnStore.attachCodexTurn(turnId, codexTurnRef);
      await turnStore.updateStatus(turnId, status);
      await turnStore.recordTurnEvent({
        sessionKey,
        codexTurnRef,
        status: BridgeTurnStatus.Completed,
        eventAt: "2026-07-01T10:00:05.000Z"
      });

      await expect(turnStore.getTurn(turnId)).resolves.toMatchObject({
        status,
        lastEventAt: null
      });
    }
  });

  it("prefers running work over newer queued work as the current turn", async () => {
    const db = createTempDb();
    const turnStore = new SqliteTurnStore(db);
    const sessionKey = "qqbot:default::qq:c2c:abc-123";

    await turnStore.createTurn({
      turnId: "bridge-turn-running",
      sessionKey,
      codexThreadRef: "codex-app-thread:thread-1",
      qqMessageId: "msg-1",
      status: BridgeTurnStatus.Running,
      startedAt: "2026-07-01T10:00:00.000Z"
    });
    await turnStore.createTurn({
      turnId: "bridge-turn-queued",
      sessionKey,
      codexThreadRef: "codex-app-thread:thread-1",
      qqMessageId: "msg-2",
      status: BridgeTurnStatus.Queued,
      startedAt: "2026-07-01T10:01:00.000Z"
    });

    await expect(turnStore.getCurrentTurn(sessionKey)).resolves.toMatchObject({
      turnId: "bridge-turn-running",
      status: BridgeTurnStatus.Running
    });
  });

  it("updates session activity timestamps from inbound and outbound records", async () => {
    const db = createTempDb();
    const sessionStore = new SqliteSessionStore(db);
    const transcriptStore = new SqliteTranscriptStore(db);
    const sessionKey = buildSessionKey({
      accountKey: "qqbot:default",
      peerKey: buildPeerKey({ chatType: "c2c", peerId: "abc-activity" })
    });

    await sessionStore.createSession({
      sessionKey,
      accountKey: "qqbot:default",
      peerKey: "qq:c2c:abc-activity",
      chatType: "c2c",
      peerId: "abc-activity",
      codexThreadRef: null,
      lastCodexTurnId: null,
      skillContextKey: null,
      conversationProvider: null,
      status: BridgeSessionStatus.Active,
      lastInboundAt: null,
      lastOutboundAt: null,
      lastError: null
    });

    await transcriptStore.recordInbound({
      messageId: "msg-activity-1",
      accountKey: "qqbot:default",
      sessionKey,
      peerKey: "qq:c2c:abc-activity",
      chatType: "c2c",
      senderId: "abc-activity",
      text: "ping",
      receivedAt: "2026-07-04T15:11:37.000Z"
    });
    await transcriptStore.recordOutbound({
      draftId: "draft-activity-1",
      sessionKey,
      text: "pong",
      createdAt: "2026-07-04T15:11:40.000Z"
    });

    await expect(sessionStore.getSession(sessionKey)).resolves.toMatchObject({
      lastInboundAt: "2026-07-04T15:11:37.000Z",
      lastOutboundAt: "2026-07-04T15:11:40.000Z"
    });
  });

  it("updates and looks up turn bindings after codex binding is resolved", async () => {
    const db = createTempDb();
    const turnStore = new SqliteTurnStore(db);
    const sessionKey = "qqbot:default::qq:c2c:abc-123";

    await turnStore.createTurn({
      turnId: "bridge-turn-binding",
      sessionKey,
      codexThreadRef: null,
      qqMessageId: "msg-1",
      status: BridgeTurnStatus.Running,
      startedAt: "2026-07-01T10:00:00.000Z"
    });
    await turnStore.updateCodexThreadRef("bridge-turn-binding", "codex-app-thread:thread-1");
    await turnStore.attachCodexTurn("bridge-turn-binding", "codex-turn-1");

    await expect(turnStore.getTurn("bridge-turn-binding")).resolves.toMatchObject({
      codexThreadRef: "codex-app-thread:thread-1",
      codexTurnRef: "codex-turn-1"
    });
    await expect(turnStore.getTurnByCodexTurn(sessionKey, "codex-turn-1")).resolves.toMatchObject({
      turnId: "bridge-turn-binding",
      codexThreadRef: "codex-app-thread:thread-1"
    });
  });

  it("matches cancelled unbound turns for late codex events", async () => {
    const db = createTempDb();
    const turnStore = new SqliteTurnStore(db);
    const sessionKey = "qqbot:default::qq:c2c:abc-123";

    await turnStore.createTurn({
      turnId: "bridge-turn-unbound",
      sessionKey,
      codexThreadRef: "codex-app-thread:thread-1",
      qqMessageId: "msg-1",
      status: BridgeTurnStatus.Running,
      startedAt: "2026-07-01T10:00:00.000Z"
    });
    await turnStore.updateStatus("bridge-turn-unbound", BridgeTurnStatus.Cancelled);

    await expect(turnStore.getTurnByCodexTurn(sessionKey, "codex-turn-late")).resolves.toMatchObject({
      turnId: "bridge-turn-unbound",
      status: BridgeTurnStatus.Cancelled,
      codexTurnRef: null
    });
  });

  it("matches cancelled unbound turns by inbound message before newer queued work", async () => {
    const db = createTempDb();
    const turnStore = new SqliteTurnStore(db);
    const sessionKey = "qqbot:default::qq:c2c:abc-123";

    await turnStore.createTurn({
      turnId: "bridge-turn-cancelled",
      sessionKey,
      codexThreadRef: "codex-app-thread:thread-1",
      qqMessageId: "msg-cancelled",
      status: BridgeTurnStatus.Running,
      startedAt: "2026-07-01T10:00:00.000Z"
    });
    await turnStore.updateStatus("bridge-turn-cancelled", BridgeTurnStatus.Cancelled);
    await turnStore.createTurn({
      turnId: "bridge-turn-queued",
      sessionKey,
      codexThreadRef: "codex-app-thread:thread-1",
      qqMessageId: "msg-queued",
      status: BridgeTurnStatus.Queued,
      startedAt: "2026-07-01T10:01:00.000Z"
    });

    await expect(
      turnStore.getTurnByCodexTurn(sessionKey, "codex-turn-late", "msg-cancelled")
    ).resolves.toMatchObject({
      turnId: "bridge-turn-cancelled",
      status: BridgeTurnStatus.Cancelled
    });
  });

  it("prefers an exact codex turn match over a newer unbound turn", async () => {
    const db = createTempDb();
    const turnStore = new SqliteTurnStore(db);
    const sessionKey = "qqbot:default::qq:c2c:abc-123";

    await turnStore.createTurn({
      turnId: "bridge-turn-exact",
      sessionKey,
      codexThreadRef: "codex-app-thread:thread-1",
      qqMessageId: "msg-1",
      status: BridgeTurnStatus.Streaming,
      startedAt: "2026-07-01T10:00:00.000Z"
    });
    await turnStore.attachCodexTurn("bridge-turn-exact", "codex-turn-1");
    await turnStore.createTurn({
      turnId: "bridge-turn-newer-unbound",
      sessionKey,
      codexThreadRef: "codex-app-thread:thread-1",
      qqMessageId: "msg-2",
      status: BridgeTurnStatus.Running,
      startedAt: "2026-07-01T10:01:00.000Z"
    });

    await expect(turnStore.getTurnByCodexTurn(sessionKey, "codex-turn-1")).resolves.toMatchObject({
      turnId: "bridge-turn-exact"
    });

    await turnStore.recordTurnEvent({
      sessionKey,
      codexTurnRef: "codex-turn-1",
      status: BridgeTurnStatus.Completed,
      eventAt: "2026-07-01T10:02:00.000Z"
    });

    await expect(turnStore.getTurn("bridge-turn-exact")).resolves.toMatchObject({
      status: BridgeTurnStatus.Completed,
      lastEventAt: "2026-07-01T10:02:00.000Z"
    });
    await expect(turnStore.getTurn("bridge-turn-newer-unbound")).resolves.toMatchObject({
      status: BridgeTurnStatus.Running,
      codexTurnRef: null
    });
  });

  it("binds first turn events to the matching inbound message instead of newer queued work", async () => {
    const db = createTempDb();
    const turnStore = new SqliteTurnStore(db);
    const sessionKey = "qqbot:default::qq:c2c:abc-123";

    await turnStore.createTurn({
      turnId: "bridge-turn-running",
      sessionKey,
      codexThreadRef: "codex-app-thread:thread-1",
      qqMessageId: "msg-running",
      status: BridgeTurnStatus.Running,
      startedAt: "2026-07-01T10:00:00.000Z"
    });
    await turnStore.createTurn({
      turnId: "bridge-turn-queued",
      sessionKey,
      codexThreadRef: "codex-app-thread:thread-1",
      qqMessageId: "msg-queued",
      status: BridgeTurnStatus.Queued,
      startedAt: "2026-07-01T10:01:00.000Z"
    });

    await turnStore.recordTurnEvent({
      sessionKey,
      codexTurnRef: "codex-turn-running",
      qqMessageId: "msg-running",
      status: BridgeTurnStatus.Streaming,
      eventAt: "2026-07-01T10:02:00.000Z"
    });

    await expect(turnStore.getTurn("bridge-turn-running")).resolves.toMatchObject({
      codexTurnRef: "codex-turn-running",
      status: BridgeTurnStatus.Streaming,
      lastEventAt: "2026-07-01T10:02:00.000Z"
    });
    await expect(turnStore.getTurn("bridge-turn-queued")).resolves.toMatchObject({
      codexTurnRef: null,
      status: BridgeTurnStatus.Queued,
      lastEventAt: null
    });
  });

  it("records inbound messages and prevents duplicate digests", async () => {
    const db = createTempDb();
    const transcriptStore = new SqliteTranscriptStore(db);

    await transcriptStore.recordInbound({
      messageId: "msg-1",
      accountKey: "qqbot:default",
      sessionKey: "qqbot:default::qq:c2c:abc-123",
      peerKey: "qq:c2c:abc-123",
      chatType: "c2c",
      senderId: "abc-123",
      text: "hello",
      receivedAt: "2026-04-08T10:00:00.000Z"
    });

    await transcriptStore.recordInbound({
      messageId: "msg-1",
      accountKey: "qqbot:default",
      sessionKey: "qqbot:default::qq:c2c:abc-123",
      peerKey: "qq:c2c:abc-123",
      chatType: "c2c",
      senderId: "abc-123",
      text: "hello",
      receivedAt: "2026-04-08T10:00:00.000Z"
    });

    await transcriptStore.recordOutbound({
      draftId: "draft-1",
      sessionKey: "qqbot:default::qq:c2c:abc-123",
      text: "reply",
      createdAt: "2026-04-08T10:00:01.000Z"
    });

    await expect(transcriptStore.hasInbound("msg-1")).resolves.toBe(true);
    await expect(transcriptStore.hasInbound("msg-2")).resolves.toBe(false);
  });

  it("only includes delivered outbound jobs in recent conversation history", async () => {
    const db = createTempDb();
    const transcriptStore = new SqliteTranscriptStore(db);
    const deliveryJobStore = new SqliteDeliveryJobStore(db);
    const sessionKey = "qqbot:default::qq:c2c:abc-123";

    await transcriptStore.recordInbound({
      messageId: "msg-1",
      accountKey: "qqbot:default",
      sessionKey,
      peerKey: "qq:c2c:abc-123",
      chatType: "c2c",
      senderId: "abc-123",
      text: "hello",
      receivedAt: "2026-07-01T10:00:00.000Z"
    });
    await transcriptStore.recordOutbound({
      draftId: "draft-delivered",
      sessionKey,
      text: "delivered reply",
      createdAt: "2026-07-01T10:00:01.000Z"
    });
    await deliveryJobStore.markDelivered({
      jobId: "draft-delivered",
      deliveredAt: "2026-07-01T10:00:02.000Z"
    });
    await transcriptStore.recordOutbound({
      draftId: "draft-failed",
      sessionKey,
      text: "failed reply",
      createdAt: "2026-07-01T10:00:03.000Z"
    });
    await deliveryJobStore.markAttemptFailed({
      jobId: "draft-failed",
      failedAt: "2026-07-01T10:00:04.000Z",
      error: "unknown result",
      maxAttempts: 1,
      retryAfterMs: 30_000
    });
    await transcriptStore.recordOutbound({
      draftId: "draft-in-flight",
      sessionKey,
      text: "in-flight reply",
      createdAt: "2026-07-01T10:00:05.000Z"
    });

    await expect(transcriptStore.listRecentConversation(sessionKey, 10)).resolves.toEqual([
      {
        direction: "inbound",
        text: "hello",
        createdAt: "2026-07-01T10:00:00.000Z"
      },
      {
        direction: "outbound",
        text: "delivered reply",
        createdAt: "2026-07-01T10:00:01.000Z"
      }
    ]);
  });

  it("does not claim legacy pending delivery jobs after migration", async () => {
    const dbPath = createTempDbPath();
    mkdirSync(path.dirname(dbPath), { recursive: true });
    const legacyDb = new BetterSqlite3(dbPath);
    legacyDb.exec(`
      CREATE TABLE delivery_jobs (
        job_id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    legacyDb.prepare(
      `INSERT INTO delivery_jobs (
        job_id, session_key, status, attempt_count, payload_json,
        last_error, created_at, updated_at
      ) VALUES (?, ?, 'pending', 0, ?, NULL, ?, ?)`
    ).run(
      "legacy-draft-1",
      "qqbot:default::qq:c2c:abc-123",
      JSON.stringify({
        draftId: "legacy-draft-1",
        sessionKey: "qqbot:default::qq:c2c:abc-123",
        text: "old reply",
        createdAt: "2026-06-30T10:00:00.000Z"
      }),
      "2026-06-30T10:00:00.000Z",
      "2026-06-30T10:00:00.000Z"
    );
    legacyDb.close();

    const db = createSqliteDatabase(dbPath);
    openDbs.push(db);
    const deliveryJobStore = new SqliteDeliveryJobStore(db);

    await expect(deliveryJobStore.claimDueJobs({
      limit: 5,
      now: "2026-07-01T10:00:00.000Z"
    })).resolves.toEqual([]);
    await expect(deliveryJobStore.listJobs({
      sessionKey: "qqbot:default::qq:c2c:abc-123",
      statuses: [DeliveryJobStatus.Delivered],
      limit: 5
    })).resolves.toEqual([
      expect.objectContaining({
        jobId: "legacy-draft-1",
        status: DeliveryJobStatus.Delivered
      })
    ]);
  });

  it("marks in-flight delivery jobs as failed on restart without retrying", async () => {
    const db = createTempDb();
    const transcriptStore = new SqliteTranscriptStore(db);
    const deliveryJobStore = new SqliteDeliveryJobStore(db);

    await transcriptStore.recordOutbound({
      draftId: "draft-delivery-1",
      sessionKey: "qqbot:default::qq:c2c:abc-123",
      text: "reply",
      createdAt: "2026-07-01T10:00:00.000Z"
    });
    await expect(deliveryJobStore.recoverInFlight("2026-07-01T10:00:01.000Z")).resolves.toBe(1);
    await expect(deliveryJobStore.claimDueJobs({
      limit: 5,
      now: "2026-07-01T10:00:02.000Z"
    })).resolves.toEqual([]);
    await expect(deliveryJobStore.listJobs({
      sessionKey: "qqbot:default::qq:c2c:abc-123",
      statuses: [DeliveryJobStatus.Failed],
      limit: 5
    })).resolves.toEqual([
      expect.objectContaining({
        jobId: "draft-delivery-1",
        status: DeliveryJobStatus.Failed,
        lastError: "Delivery result unknown after restart; not retried automatically."
      })
    ]);
  });

  it("recovers abandoned active turns and lock rows after a restart", async () => {
    const db = createTempDb();
    const turnStore = new SqliteTurnStore(db);
    const recoveryStore = new SqliteRuntimeRecoveryStore(db);
    const sessionKey = "qqbot:default::qq:c2c:abc-123";

    await turnStore.createTurn({
      turnId: "bridge-turn-expired",
      sessionKey,
      codexThreadRef: "codex-app-thread:thread-1",
      qqMessageId: "msg-1",
      status: BridgeTurnStatus.Running,
      startedAt: "2026-07-01T10:00:00.000Z",
      deadlineAt: "2026-07-01T10:05:00.000Z"
    });
    await turnStore.createTurn({
      turnId: "bridge-turn-abandoned",
      sessionKey,
      codexThreadRef: "codex-app-thread:thread-2",
      qqMessageId: "msg-2",
      status: BridgeTurnStatus.Streaming,
      startedAt: "2026-07-01T10:01:00.000Z"
    });
    db.prepare(
      `INSERT INTO session_locks (session_key, owner, locked_at, expires_at)
       VALUES (?, ?, ?, ?)`
    ).run(sessionKey, "previous-process", "2026-07-01T10:00:00.000Z", "2026-07-01T10:01:00.000Z");
    db.prepare(
      `INSERT INTO thread_locks (thread_ref, owner, locked_at, expires_at)
       VALUES (?, ?, ?, ?)`
    ).run("codex-app-thread:thread-1", "previous-process", "2026-07-01T10:00:00.000Z", "2026-07-01T10:01:00.000Z");

    expect(recoveryStore.inspect("2026-07-01T10:06:00.000Z")).toMatchObject({
      activeTurns: 2,
      expiredActiveTurns: 1,
      orphanableActiveTurns: 1,
      sessionLocks: { total: 1, expired: 1 },
      threadLocks: { total: 1, expired: 1 }
    });

    expect(recoveryStore.recoverAbandonedState("2026-07-01T10:06:00.000Z")).toMatchObject({
      timedOutTurns: 1,
      orphanedTurns: 1,
      clearedSessionLocks: 1,
      clearedThreadLocks: 1,
      remainingActiveTurns: 0
    });
    await expect(turnStore.getTurn("bridge-turn-expired")).resolves.toMatchObject({
      status: BridgeTurnStatus.TimedOut,
      lastError: "Bridge daemon restarted after the turn deadline; marked timed-out."
    });
    await expect(turnStore.getTurn("bridge-turn-abandoned")).resolves.toMatchObject({
      status: BridgeTurnStatus.Orphaned,
      lastError: "Bridge daemon restarted before the turn finished; marked orphaned."
    });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM session_locks`).get()).toMatchObject({ count: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM thread_locks`).get()).toMatchObject({ count: 0 });
  });

  it("marks expired queued turns as orphaned instead of timed-out on restart", async () => {
    const db = createTempDb();
    const turnStore = new SqliteTurnStore(db);
    const recoveryStore = new SqliteRuntimeRecoveryStore(db);
    const sessionKey = "qqbot:default::qq:c2c:abc-123";

    await turnStore.createTurn({
      turnId: "bridge-turn-queued-expired",
      sessionKey,
      codexThreadRef: "codex-app-thread:thread-1",
      qqMessageId: "msg-queued",
      status: BridgeTurnStatus.Queued,
      startedAt: "2026-07-01T10:00:00.000Z",
      deadlineAt: "2026-07-01T10:05:00.000Z"
    });

    expect(recoveryStore.inspect("2026-07-01T10:06:00.000Z")).toMatchObject({
      activeTurns: 1,
      expiredActiveTurns: 0,
      orphanableActiveTurns: 1
    });
    expect(recoveryStore.recoverAbandonedState("2026-07-01T10:06:00.000Z")).toMatchObject({
      timedOutTurns: 0,
      orphanedTurns: 1
    });
    await expect(turnStore.getTurn("bridge-turn-queued-expired")).resolves.toMatchObject({
      status: BridgeTurnStatus.Orphaned
    });
  });

  it("claims, retries, and fails delivery jobs", async () => {
    const db = createTempDb();
    const transcriptStore = new SqliteTranscriptStore(db);
    const deliveryJobStore = new SqliteDeliveryJobStore(db);

    await transcriptStore.recordOutbound({
      draftId: "draft-delivery-1",
      sessionKey: "qqbot:default::qq:c2c:abc-123",
      text: "reply",
      createdAt: "2026-07-01T10:00:00.000Z"
    });
    await deliveryJobStore.markAttemptFailed({
      jobId: "draft-delivery-1",
      failedAt: "2026-07-01T10:00:01.000Z",
      error: "network down",
      maxAttempts: 3,
      retryAfterMs: 1_000
    });

    const firstClaim = await deliveryJobStore.claimDueJobs({
      limit: 5,
      now: "2026-07-01T10:00:02.000Z"
    });
    expect(firstClaim).toHaveLength(1);
    expect(firstClaim[0]).toMatchObject({
      jobId: "draft-delivery-1",
      status: DeliveryJobStatus.InFlight,
      attemptCount: 2,
      payload: {
        text: "reply"
      }
    });

    await deliveryJobStore.markAttemptFailed({
      jobId: "draft-delivery-1",
      failedAt: "2026-07-01T10:00:02.000Z",
      error: "network down",
      maxAttempts: 3,
      retryAfterMs: 60_000
    });
    await expect(deliveryJobStore.claimDueJobs({
      limit: 5,
      now: "2026-07-01T10:00:30.000Z"
    })).resolves.toEqual([]);

    const secondClaim = await deliveryJobStore.claimDueJobs({
      limit: 5,
      now: "2026-07-01T10:01:02.000Z"
    });
    expect(secondClaim).toHaveLength(1);
    expect(secondClaim[0].attemptCount).toBe(3);

    await deliveryJobStore.markAttemptFailed({
      jobId: "draft-delivery-1",
      failedAt: "2026-07-01T10:01:03.000Z",
      error: "still down",
      maxAttempts: 3,
      retryAfterMs: 60_000
    });
    await expect(deliveryJobStore.listJobs({
      sessionKey: "qqbot:default::qq:c2c:abc-123",
      statuses: [DeliveryJobStatus.Failed],
      limit: 5
    })).resolves.toEqual([
      expect.objectContaining({
        jobId: "draft-delivery-1",
        status: DeliveryJobStatus.Failed,
        attemptCount: 3,
        lastError: "still down"
      })
    ]);
  });

  it("serializes overlapping work for the same session key", async () => {
    const db = createTempDb();
    const sessionStore = new SqliteSessionStore(db);
    const sessionKey = buildSessionKey({
      accountKey: "qqbot:default",
      peerKey: buildPeerKey({ chatType: "c2c", peerId: "abc-123" })
    });

    const firstTurn = createDeferred<void>();
    const secondEntered: string[] = [];
    const firstEntered = createDeferred<void>();

    const firstWork = sessionStore.withSessionLock(sessionKey, async () => {
      firstEntered.resolve();
      await firstTurn.promise;
    });

    await firstEntered.promise;

    const secondWork = sessionStore.withSessionLock(sessionKey, async () => {
      secondEntered.push("entered");
    });

    expect(secondEntered).toEqual([]);

    firstTurn.resolve();

    await expect(firstWork).resolves.toBeUndefined();
    await expect(secondWork).resolves.toBeUndefined();
    expect(secondEntered).toEqual(["entered"]);
  });

  it("replaces a stale in-db lock left behind by a previous process", async () => {
    const db = createTempDb();
    const sessionStore = new SqliteSessionStore(db);
    const sessionKey = buildSessionKey({
      accountKey: "qqbot:default",
      peerKey: buildPeerKey({ chatType: "c2c", peerId: "abc-123" })
    });

    db.prepare(
      `INSERT INTO session_locks (session_key, owner, locked_at, expires_at)
       VALUES (?, ?, ?, ?)`
    ).run(
      sessionKey,
      "dead-process-owner",
      "2026-04-09T10:00:00.000Z",
      "2099-04-09T10:01:00.000Z"
    );

    const calls: string[] = [];

    await expect(
      sessionStore.withSessionLock(sessionKey, async () => {
        calls.push("entered");
      })
    ).resolves.toBeUndefined();

    expect(calls).toEqual(["entered"]);
    const remainingLocks = db
      .prepare(`SELECT COUNT(*) AS count FROM session_locks WHERE session_key = ?`)
      .get(sessionKey) as { count: number };
    expect(remainingLocks.count).toBe(0);
  });

  it("serializes overlapping work for the same codex thread ref", async () => {
    const db = createTempDb();
    const threadLockStore = new SqliteThreadLockStore(db);
    const threadRef = "codex-app-thread:thread-1";

    const firstTurn = createDeferred<void>();
    const firstEntered = createDeferred<void>();
    const secondEntered: string[] = [];

    const firstWork = threadLockStore.withThreadLock(threadRef, async () => {
      firstEntered.resolve();
      await firstTurn.promise;
    });

    await firstEntered.promise;

    const secondWork = threadLockStore.withThreadLock(threadRef, async () => {
      secondEntered.push("entered");
    });

    expect(secondEntered).toEqual([]);

    firstTurn.resolve();

    await expect(firstWork).resolves.toBeUndefined();
    await expect(secondWork).resolves.toBeUndefined();
    expect(secondEntered).toEqual(["entered"]);
  });

  it("notifies when codex thread work is queued", async () => {
    const db = createTempDb();
    const threadLockStore = new SqliteThreadLockStore(db);
    const threadRef = "codex-app-thread:thread-1";

    const firstTurn = createDeferred<void>();
    const firstEntered = createDeferred<void>();
    const queued: string[] = [];

    const firstWork = threadLockStore.withThreadLock(threadRef, async () => {
      firstEntered.resolve();
      await firstTurn.promise;
    });

    await firstEntered.promise;

    const secondWork = threadLockStore.withThreadLock(
      threadRef,
      async () => undefined,
      {
        onQueued: async () => {
          queued.push("queued");
        }
      }
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queued).toEqual(["queued"]);

    firstTurn.resolve();

    await expect(firstWork).resolves.toBeUndefined();
    await expect(secondWork).resolves.toBeUndefined();
  });

  it("keeps releasing the thread lock when queue notification fails", async () => {
    const db = createTempDb();
    const threadLockStore = new SqliteThreadLockStore(db);
    const threadRef = "codex-app-thread:thread-1";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const firstTurn = createDeferred<void>();
    const firstEntered = createDeferred<void>();
    const secondEntered: string[] = [];

    const firstWork = threadLockStore.withThreadLock(threadRef, async () => {
      firstEntered.resolve();
      await firstTurn.promise;
    });

    await firstEntered.promise;

    const secondWork = threadLockStore.withThreadLock(
      threadRef,
      async () => {
        secondEntered.push("entered");
      },
      {
        onQueued: async () => {
          throw new Error("queue notice failed");
        }
      }
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    firstTurn.resolve();

    await expect(firstWork).resolves.toBeUndefined();
    await expect(secondWork).resolves.toBeUndefined();
    expect(secondEntered).toEqual(["entered"]);
    expect(warnSpy).toHaveBeenCalledWith(
      "[codex-desktop-orchestrator] thread queue notice failed",
      expect.objectContaining({
        threadRef,
        error: "queue notice failed"
      })
    );
    warnSpy.mockRestore();
  });

  it("does not block different codex thread refs on each other", async () => {
    const db = createTempDb();
    const threadLockStore = new SqliteThreadLockStore(db);

    const firstTurn = createDeferred<void>();
    const firstEntered = createDeferred<void>();
    const secondEntered: string[] = [];

    const firstWork = threadLockStore.withThreadLock("codex-app-thread:thread-1", async () => {
      firstEntered.resolve();
      await firstTurn.promise;
    });

    await firstEntered.promise;

    await expect(
      threadLockStore.withThreadLock("codex-app-thread:thread-2", async () => {
        secondEntered.push("entered");
      })
    ).resolves.toBeUndefined();

    firstTurn.resolve();

    await expect(firstWork).resolves.toBeUndefined();
    expect(secondEntered).toEqual(["entered"]);
  });
});

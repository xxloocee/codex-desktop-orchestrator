import { describe, expect, it } from "vitest";
import { TurnEventType, type InboundMessage } from "../../packages/domain/src/message.js";
import { BridgeTurnStatus } from "../../packages/domain/src/turn.js";
import { SqliteDeliveryJobStore } from "../../packages/store/src/delivery-job-repo.js";
import { SqliteTranscriptStore } from "../../packages/store/src/message-repo.js";
import { createSqliteDatabase } from "../../packages/store/src/sqlite.js";
import { SqliteTurnStore } from "../../packages/store/src/turn-repo.js";

describe("turn observability persistence", () => {
  it("loads original inbound messages and records queryable tool events", async () => {
    const db = createSqliteDatabase(":memory:");
    const transcriptStore = new SqliteTranscriptStore(db);
    const turnStore = new SqliteTurnStore(db);
    const deliveryStore = new SqliteDeliveryJobStore(db);
    const message: InboundMessage = {
      messageId: "msg-1",
      accountKey: "qqbot:default",
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      peerKey: "qq:c2c:OPENID123",
      chatType: "c2c",
      senderId: "OPENID123",
      text: "运行测试",
      receivedAt: "2026-07-01T10:00:00.000Z"
    };

    await transcriptStore.recordInbound(message);
    await turnStore.createTurn({
      turnId: "bridge-turn-1",
      sessionKey: message.sessionKey,
      codexThreadRef: "codex-app-thread:thread-1",
      qqMessageId: message.messageId,
      status: BridgeTurnStatus.Running,
      startedAt: message.receivedAt
    });
    await turnStore.recordTurnEvent({
      sessionKey: message.sessionKey,
      codexTurnRef: "codex-turn-1",
      qqMessageId: message.messageId,
      status: BridgeTurnStatus.ToolRunning,
      eventAt: "2026-07-01T10:00:10.000Z",
      eventType: TurnEventType.Status,
      lastToolName: "pnpm test",
      toolStatus: "started",
      summary: "running test suite"
    });
    await transcriptStore.recordOutbound({
      draftId: "draft-1",
      sessionKey: message.sessionKey,
      text: "任务已开始。",
      createdAt: "2026-07-01T10:00:11.000Z"
    });

    await expect(transcriptStore.getInbound(message.messageId)).resolves.toEqual(message);
    await expect(turnStore.listRecentTurnsAll(10)).resolves.toEqual([
      expect.objectContaining({
        turnId: "bridge-turn-1",
        status: BridgeTurnStatus.ToolRunning,
        lastToolName: "pnpm test"
      })
    ]);
    await expect(turnStore.listTurnEvents("bridge-turn-1", 10)).resolves.toEqual([
      expect.objectContaining({
        eventType: TurnEventType.Status,
        status: BridgeTurnStatus.ToolRunning,
        toolName: "pnpm test",
        toolStatus: "started",
        summary: "running test suite"
      })
    ]);
    await expect(deliveryStore.listRecentJobsAll(10)).resolves.toEqual([
      expect.objectContaining({ jobId: "draft-1" })
    ]);
    db.close();
  });
});

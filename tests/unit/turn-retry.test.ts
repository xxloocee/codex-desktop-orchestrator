import { describe, expect, it, vi } from "vitest";
import type { InboundMessage } from "../../packages/domain/src/message.js";
import { BridgeTurnStatus, type BridgeTurnRecord } from "../../packages/domain/src/turn.js";
import type { TranscriptStorePort, TurnStorePort } from "../../packages/ports/src/store.js";
import { TurnRetry } from "../../packages/orchestrator/src/turn-retry.js";

const sessionKey = "qqbot:default::qq:c2c:OPENID123";

function turn(status: BridgeTurnStatus): BridgeTurnRecord {
  return {
    turnId: "bridge-turn-failed-123",
    sessionKey,
    codexThreadRef: "codex-app-thread:thread-1",
    codexTurnRef: "codex-turn-1",
    qqMessageId: "msg-original",
    status,
    startedAt: "2026-07-01T10:00:00.000Z",
    updatedAt: "2026-07-01T10:01:00.000Z",
    deadlineAt: null,
    lastEventAt: null,
    lastToolName: null,
    lastError: null,
    deliveredTextLength: 0
  };
}

function inbound(): InboundMessage {
  return {
    messageId: "msg-original",
    accountKey: "qqbot:default",
    sessionKey,
    peerKey: "qq:c2c:OPENID123",
    chatType: "c2c",
    senderId: "OPENID123",
    text: "重新执行测试",
    receivedAt: "2026-07-01T10:00:00.000Z"
  };
}

function stores(status: BridgeTurnStatus) {
  const turnStore = {
    listRecentTurns: vi.fn().mockResolvedValue([turn(status)])
  } as unknown as TurnStorePort;
  const transcriptStore = {
    getInbound: vi.fn().mockResolvedValue(inbound())
  } as unknown as TranscriptStorePort;
  return { turnStore, transcriptStore };
}

describe("turn retry", () => {
  it("creates a fresh message for a failed task", async () => {
    const { turnStore, transcriptStore } = stores(BridgeTurnStatus.Failed);
    const retry = new TurnRetry({
      turnStore,
      transcriptStore,
      createMessageId: () => "retry-1",
      now: () => new Date("2026-07-01T10:02:00.000Z")
    });

    await expect(
      retry.prepare(sessionKey, "bridge-turn-failed", "msg-retry-command")
    ).resolves.toEqual({
      status: "ready",
      sourceTurnId: "bridge-turn-failed-123",
      message: {
        ...inbound(),
        messageId: "retry:retry-1",
        replyToMessageId: "msg-retry-command",
        retryOfTurnId: "bridge-turn-failed-123",
        receivedAt: "2026-07-01T10:02:00.000Z"
      }
    });
  });

  it("rejects completed tasks", async () => {
    const { turnStore, transcriptStore } = stores(BridgeTurnStatus.Completed);
    const retry = new TurnRetry({ turnStore, transcriptStore });

    await expect(retry.prepare(sessionKey, "bridge-turn-failed")).resolves.toEqual({
      status: "task-not-retryable",
      turnId: "bridge-turn-failed-123",
      turnStatus: BridgeTurnStatus.Completed
    });
  });

  it("reports missing task ids", async () => {
    const { turnStore, transcriptStore } = stores(BridgeTurnStatus.Failed);
    vi.mocked(turnStore.listRecentTurns).mockResolvedValue([]);
    const retry = new TurnRetry({ turnStore, transcriptStore });

    await expect(retry.prepare(sessionKey, "missing")).resolves.toEqual({
      status: "task-not-found",
      requestedTaskId: "missing"
    });
  });
});

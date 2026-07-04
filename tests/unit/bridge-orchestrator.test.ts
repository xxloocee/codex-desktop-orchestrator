import { describe, expect, it, vi } from "vitest";
import { BridgeSessionStatus } from "../../packages/domain/src/session.js";
import type { BridgeSession } from "../../packages/domain/src/session.js";
import { BridgeTurnStatus } from "../../packages/domain/src/turn.js";
import { DesktopDriverError } from "../../packages/domain/src/driver.js";
import {
  MediaArtifactKind,
  TurnEventType,
  type InboundMessage,
  type OutboundDraft
} from "../../packages/domain/src/message.js";
import type { ConversationProviderPort } from "../../packages/ports/src/conversation.js";
import type { QqEgressPort } from "../../packages/ports/src/qq.js";
import type {
  DeliveryJobStorePort,
  SessionStorePort,
  TranscriptStorePort,
  TurnStorePort
} from "../../packages/ports/src/store.js";
import { BridgeOrchestrator } from "../../packages/orchestrator/src/bridge-orchestrator.js";
import { deliverDrafts } from "../../packages/orchestrator/src/job-runner.js";
import { enrichQqOutboundDraft } from "../../packages/orchestrator/src/qq-outbound-draft.js";
import { formatWeixinOutboundDraft } from "../../packages/orchestrator/src/weixin-outbound-format.js";

function createMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: "msg-1",
    accountKey: "qqbot:default",
    sessionKey: "qqbot:default::qq:c2c:abc-123",
    peerKey: "qq:c2c:abc-123",
    chatType: "c2c",
    senderId: "abc-123",
    text: "hello",
    receivedAt: "2026-04-08T10:00:00.000Z",
    ...overrides
  };
}

function createSession(message: InboundMessage): BridgeSession {
  return {
    sessionKey: message.sessionKey,
    accountKey: message.accountKey,
    peerKey: message.peerKey,
    chatType: message.chatType,
    peerId: message.senderId,
    codexThreadRef: "thread-1",
    lastCodexTurnId: null,
    skillContextKey: null,
    conversationProvider: null,
    status: BridgeSessionStatus.NeedsRebind,
    lastInboundAt: null,
    lastOutboundAt: null,
    lastError: "old error"
  };
}

function createTurnStore(): TurnStorePort {
  return {
    createTurn: vi.fn().mockResolvedValue(undefined),
    attachCodexTurn: vi.fn().mockResolvedValue(undefined),
    updateCodexThreadRef: vi.fn().mockResolvedValue(undefined),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    updateDeadline: vi.fn().mockResolvedValue(undefined),
    recordTurnEvent: vi.fn().mockResolvedValue(undefined),
    addDeliveredText: vi.fn().mockResolvedValue(undefined),
    getTurn: vi.fn().mockResolvedValue(null),
    getTurnByCodexTurn: vi.fn().mockResolvedValue(null),
    getCurrentTurn: vi.fn().mockResolvedValue(null),
    listRecentTurns: vi.fn().mockResolvedValue([])
  };
}

function createDeliveryJobStore(): DeliveryJobStorePort {
  return {
    claimDueJobs: vi.fn().mockResolvedValue([]),
    markDelivered: vi.fn().mockResolvedValue(undefined),
    markAttemptFailed: vi.fn().mockResolvedValue(undefined),
    recoverInFlight: vi.fn().mockResolvedValue(0),
    listJobs: vi.fn().mockResolvedValue([])
  };
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

describe("deliverDrafts", () => {
  it("delivers drafts in order", async () => {
    const calls: string[] = [];
    const egress: QqEgressPort = {
      deliver: vi.fn(async (draft: OutboundDraft) => {
        calls.push(draft.draftId);
        return {
          jobId: `job-${draft.draftId}`,
          sessionKey: draft.sessionKey,
          providerMessageId: null,
          deliveredAt: draft.createdAt
        };
      })
    };

    const drafts: OutboundDraft[] = [
      {
        draftId: "draft-1",
        sessionKey: "qqbot:default::qq:c2c:abc-123",
        text: "first",
        createdAt: "2026-04-08T10:00:01.000Z"
      },
      {
        draftId: "draft-2",
        sessionKey: "qqbot:default::qq:c2c:abc-123",
        text: "second",
        createdAt: "2026-04-08T10:00:02.000Z"
      }
    ];

    await deliverDrafts(egress, drafts);

    expect(calls).toEqual(["draft-1", "draft-2"]);
  });
});

describe("BridgeOrchestrator", () => {
  it("returns early when the inbound message was already seen", async () => {
    const transcriptStore: TranscriptStorePort = {
      hasInbound: vi.fn().mockResolvedValue(true),
      recordInbound: vi.fn(),
      recordOutbound: vi.fn(),
      listRecentConversation: vi.fn().mockResolvedValue([])
    };
    const sessionStore: SessionStorePort = {
      getSession: vi.fn(),
      createSession: vi.fn(),
      updateSessionStatus: vi.fn(),
      updateBinding: vi.fn(),
      updateLastCodexTurnId: vi.fn(),
      updateSkillContextKey: vi.fn(),
      updateConversationProvider: vi.fn(),
      withSessionLock: vi.fn()
    };
    const conversationProvider: ConversationProviderPort = {
      runTurn: vi.fn()
    };
    const qqEgress: QqEgressPort = {
      deliver: vi.fn()
    };

    const orchestrator = new BridgeOrchestrator({
      transcriptStore,
      sessionStore,
      conversationProvider,
      qqEgress
    });

    await orchestrator.handleInbound(createMessage());

    expect(transcriptStore.hasInbound).toHaveBeenCalledWith("msg-1");
    expect(sessionStore.withSessionLock).not.toHaveBeenCalled();
    expect(transcriptStore.recordInbound).not.toHaveBeenCalled();
    expect(conversationProvider.runTurn).not.toHaveBeenCalled();
    expect(qqEgress.deliver).not.toHaveBeenCalled();
  });

  it("persists the latest codex turn id when a delivered draft carries one", async () => {
    const message = createMessage();
    const transcriptStore: TranscriptStorePort = {
      hasInbound: vi.fn().mockResolvedValue(false),
      recordInbound: vi.fn(),
      recordOutbound: vi.fn(),
      listRecentConversation: vi.fn().mockResolvedValue([])
    };
    const sessionStore: SessionStorePort = {
      getSession: vi.fn().mockResolvedValue(createSession(message)),
      createSession: vi.fn(),
      updateSessionStatus: vi.fn(),
      updateBinding: vi.fn(),
      updateLastCodexTurnId: vi.fn(),
      updateSkillContextKey: vi.fn(),
      updateConversationProvider: vi.fn(),
      withSessionLock: vi.fn(async (_sessionKey, work) => work())
    };
    const conversationProvider: ConversationProviderPort = {
      runTurn: vi.fn(async (_message, options) => {
        await options?.onDraft?.({
          draftId: "draft-turn-1",
          turnId: "turn-local-123",
          sessionKey: message.sessionKey,
          text: "阶段输出",
          createdAt: "2026-04-19T13:00:01.000Z"
        });
        return [];
      })
    };
    const qqEgress: QqEgressPort = {
      deliver: vi.fn(async (draft: OutboundDraft) => ({
        jobId: `job-${draft.draftId}`,
        sessionKey: draft.sessionKey,
        providerMessageId: null,
        deliveredAt: draft.createdAt
      }))
    };

    const orchestrator = new BridgeOrchestrator({
      transcriptStore,
      sessionStore,
      conversationProvider,
      qqEgress
    });

    await orchestrator.handleInbound(message);

    expect(sessionStore.updateLastCodexTurnId).toHaveBeenCalledWith(
      message.sessionKey,
      "turn-local-123"
    );
  });

  it("records turn lifecycle state while processing an inbound message", async () => {
    const message = createMessage();
    const turnStore = createTurnStore();
    const deliveryJobStore = createDeliveryJobStore();
    const transcriptStore: TranscriptStorePort = {
      hasInbound: vi.fn().mockResolvedValue(false),
      recordInbound: vi.fn(),
      recordOutbound: vi.fn(),
      listRecentConversation: vi.fn().mockResolvedValue([])
    };
    let lockTail = Promise.resolve();
    const sessionStore: SessionStorePort = {
      getSession: vi.fn().mockResolvedValue(createSession(message)),
      createSession: vi.fn(),
      updateSessionStatus: vi.fn(),
      updateBinding: vi.fn(),
      updateLastCodexTurnId: vi.fn(),
      updateSkillContextKey: vi.fn(),
      updateConversationProvider: vi.fn(),
      withSessionLock: vi.fn(async (_sessionKey, work) => {
        const previous = lockTail;
        let release!: () => void;
        const current = new Promise<void>((resolve) => {
          release = resolve;
        });
        lockTail = previous.then(() => current);
        await previous;
        try {
          return await work();
        } finally {
          release();
        }
      })
    };
    const conversationProvider: ConversationProviderPort = {
      runTurn: vi.fn(async (_message, options) => {
        await options?.onDraft?.({
          draftId: "draft-turn-1",
          turnId: "codex-turn-1",
          sessionKey: message.sessionKey,
          text: "reply",
          createdAt: "2026-07-01T10:00:01.000Z"
        });
        return [];
      })
    };
    const qqEgress: QqEgressPort = {
      deliver: vi.fn(async (draft: OutboundDraft) => ({
        jobId: `job-${draft.draftId}`,
        sessionKey: draft.sessionKey,
        providerMessageId: null,
        deliveredAt: draft.createdAt
      }))
    };

    const orchestrator = new BridgeOrchestrator({
      transcriptStore,
      sessionStore,
      turnStore,
      deliveryJobStore,
      conversationProvider,
      qqEgress,
      turnTimeoutMs: 123_000
    });

    await orchestrator.handleInbound(message);

    expect(turnStore.createTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: message.sessionKey,
        qqMessageId: message.messageId,
        status: BridgeTurnStatus.Queued,
        deadlineAt: null
      })
    );
    const bridgeTurnId = vi.mocked(turnStore.createTurn).mock.calls[0]?.[0].turnId;
    const deadlineCall = vi.mocked(turnStore.updateDeadline).mock.calls.find(
      ([calledTurnId, deadlineAt]) => calledTurnId === bridgeTurnId && deadlineAt !== null
    );
    expect(deadlineCall).toBeDefined();
    expect(Date.parse(deadlineCall?.[1] ?? "") - Date.now()).toBeGreaterThan(120_000);
    expect(turnStore.updateStatus).toHaveBeenCalledWith(bridgeTurnId, BridgeTurnStatus.Running);
    expect(turnStore.attachCodexTurn).toHaveBeenCalledWith(bridgeTurnId, "codex-turn-1");
    expect(turnStore.updateStatus).toHaveBeenCalledWith(bridgeTurnId, BridgeTurnStatus.Streaming);
    expect(turnStore.addDeliveredText).toHaveBeenCalledWith(bridgeTurnId, 5);
    expect(deliveryJobStore.markDelivered).toHaveBeenCalledWith({
      jobId: "draft-turn-1",
      deliveredAt: "2026-07-01T10:00:01.000Z",
      providerMessageId: null
    });
    expect(turnStore.updateStatus).toHaveBeenLastCalledWith(
      bridgeTurnId,
      BridgeTurnStatus.Completed,
      null
    );
  });

  it("marks the turn queued before the codex thread lock is acquired", async () => {
    const message = createMessage();
    const turnStore = createTurnStore();
    const transcriptStore: TranscriptStorePort = {
      hasInbound: vi.fn().mockResolvedValue(false),
      recordInbound: vi.fn(),
      recordOutbound: vi.fn(),
      listRecentConversation: vi.fn().mockResolvedValue([])
    };
    const sessionStore: SessionStorePort = {
      getSession: vi.fn().mockResolvedValue(createSession(message)),
      createSession: vi.fn(),
      updateSessionStatus: vi.fn(),
      updateBinding: vi.fn(),
      updateLastCodexTurnId: vi.fn(),
      updateSkillContextKey: vi.fn(),
      updateConversationProvider: vi.fn(),
      withSessionLock: vi.fn(async (_sessionKey, work) => work())
    };
    const releaseTurn = createDeferred<void>();
    const conversationProvider: ConversationProviderPort = {
      runTurn: vi.fn(async (_message, options) => {
        await options?.onQueued?.();
        await releaseTurn.promise;
        await options?.onStarted?.();
        await options?.onDraft?.({
          draftId: "draft-turn-queued",
          turnId: "codex-turn-queued",
          sessionKey: message.sessionKey,
          text: "reply",
          createdAt: "2026-07-01T10:00:01.000Z"
        });
        return [];
      })
    };
    const qqEgress: QqEgressPort = {
      deliver: vi.fn(async (draft: OutboundDraft) => ({
        jobId: `job-${draft.draftId}`,
        sessionKey: draft.sessionKey,
        providerMessageId: null,
        deliveredAt: draft.createdAt
      }))
    };
    const orchestrator = new BridgeOrchestrator({
      sessionStore,
      transcriptStore,
      turnStore,
      conversationProvider,
      qqEgress
    });

    const turnPromise = orchestrator.handleInbound(message);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(turnStore.updateStatus).toHaveBeenCalledWith(
      expect.any(String),
      BridgeTurnStatus.Queued
    );
    releaseTurn.resolve();
    await expect(turnPromise).resolves.toBeUndefined();
    expect(turnStore.updateStatus).toHaveBeenCalledWith(
      expect.any(String),
      BridgeTurnStatus.Running
    );
  });

  it("does not block turn events behind an active inbound turn", async () => {
    const message = createMessage();
    const turnStore = createTurnStore();
    const transcriptStore: TranscriptStorePort = {
      hasInbound: vi.fn().mockResolvedValue(false),
      recordInbound: vi.fn(),
      recordOutbound: vi.fn(),
      listRecentConversation: vi.fn().mockResolvedValue([])
    };
    const sessionStore: SessionStorePort = {
      getSession: vi.fn().mockResolvedValue(createSession(message)),
      createSession: vi.fn(),
      updateSessionStatus: vi.fn(),
      updateBinding: vi.fn(),
      updateLastCodexTurnId: vi.fn(),
      updateSkillContextKey: vi.fn(),
      updateConversationProvider: vi.fn(),
      withSessionLock: vi.fn(async (_sessionKey, work) => work())
    };
    const releaseTurn = createDeferred<OutboundDraft[]>();
    const conversationProvider: ConversationProviderPort = {
      runTurn: vi.fn(() => releaseTurn.promise)
    };
    const qqEgress: QqEgressPort = {
      deliver: vi.fn(async (draft: OutboundDraft) => ({
        jobId: `job-${draft.draftId}`,
        sessionKey: draft.sessionKey,
        providerMessageId: null,
        deliveredAt: draft.createdAt
      }))
    };
    const orchestrator = new BridgeOrchestrator({
      sessionStore,
      transcriptStore,
      turnStore,
      conversationProvider,
      qqEgress
    });

    const inboundPromise = orchestrator.handleInbound(message);
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(orchestrator.handleTurnEvent({
      sessionKey: message.sessionKey,
      turnId: "codex-turn-live",
      sequence: 1,
      eventType: TurnEventType.Status,
      createdAt: "2026-07-01T10:00:05.000Z",
      isFinal: false,
      payload: {
        toolName: "pnpm run check",
        toolStatus: "started"
      }
    })).resolves.toBeUndefined();

    expect(turnStore.recordTurnEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        codexTurnRef: "codex-turn-live",
        status: BridgeTurnStatus.ToolRunning
      })
    );

    releaseTurn.resolve([]);
    await expect(inboundPromise).resolves.toBeUndefined();
  });

  it("serializes codex turns for the same session without blocking turn events", async () => {
    const firstMessage = createMessage({ messageId: "msg-1", text: "first" });
    const secondMessage = createMessage({
      messageId: "msg-2",
      text: "second",
      receivedAt: "2026-04-08T10:00:01.000Z"
    });
    const turnStore = createTurnStore();
    const transcriptStore: TranscriptStorePort = {
      hasInbound: vi.fn().mockResolvedValue(false),
      recordInbound: vi.fn(),
      recordOutbound: vi.fn(),
      listRecentConversation: vi.fn().mockResolvedValue([])
    };
    const sessionStore: SessionStorePort = {
      getSession: vi.fn().mockResolvedValue(createSession(firstMessage)),
      createSession: vi.fn(),
      updateSessionStatus: vi.fn(),
      updateBinding: vi.fn(),
      updateLastCodexTurnId: vi.fn(),
      updateSkillContextKey: vi.fn(),
      updateConversationProvider: vi.fn(),
      withSessionLock: vi.fn(async (_sessionKey, work) => work())
    };
    const firstTurn = createDeferred<OutboundDraft[]>();
    const enteredTurns: string[] = [];
    const conversationProvider: ConversationProviderPort = {
      runTurn: vi.fn(async (message) => {
        enteredTurns.push(message.messageId);
        if (message.messageId === firstMessage.messageId) {
          return firstTurn.promise;
        }
        return [];
      })
    };
    const orchestrator = new BridgeOrchestrator({
      sessionStore,
      transcriptStore,
      turnStore,
      conversationProvider,
      qqEgress: { deliver: vi.fn() }
    });

    const firstPromise = orchestrator.handleInbound(firstMessage);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const secondPromise = orchestrator.handleInbound(secondMessage);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(enteredTurns).toEqual(["msg-1"]);
    const secondBridgeTurnId = vi.mocked(turnStore.createTurn).mock.calls[1]?.[0].turnId;
    expect(turnStore.updateStatus).toHaveBeenCalledWith(
      secondBridgeTurnId,
      BridgeTurnStatus.Queued
    );

    await orchestrator.handleTurnEvent({
      sessionKey: firstMessage.sessionKey,
      turnId: "codex-turn-live",
      sequence: 1,
      eventType: TurnEventType.Status,
      createdAt: "2026-07-01T10:00:05.000Z",
      isFinal: false,
      payload: {
        toolName: "pnpm run check",
        toolStatus: "started"
      }
    });
    expect(turnStore.recordTurnEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        codexTurnRef: "codex-turn-live",
        status: BridgeTurnStatus.ToolRunning
      })
    );

    firstTurn.resolve([]);
    await expect(firstPromise).resolves.toBeUndefined();
    await expect(secondPromise).resolves.toBeUndefined();
    expect(enteredTurns).toEqual(["msg-1", "msg-2"]);
  });

  it("does not start queued work after the task was cancelled", async () => {
    const message = createMessage();
    const turnStore = createTurnStore();
    vi.mocked(turnStore.getTurn).mockResolvedValue({
      turnId: "bridge-turn-cancelled",
      sessionKey: message.sessionKey,
      codexThreadRef: "thread-1",
      codexTurnRef: null,
      qqMessageId: message.messageId,
      status: BridgeTurnStatus.Cancelled,
      startedAt: "2026-07-01T10:00:00.000Z",
      updatedAt: "2026-07-01T10:00:02.000Z",
      deadlineAt: null,
      lastEventAt: null,
      lastToolName: null,
      lastError: null,
      deliveredTextLength: 0
    });

    const transcriptStore: TranscriptStorePort = {
      hasInbound: vi.fn().mockResolvedValue(false),
      recordInbound: vi.fn(),
      recordOutbound: vi.fn(),
      listRecentConversation: vi.fn().mockResolvedValue([])
    };
    const sessionStore: SessionStorePort = {
      getSession: vi.fn().mockResolvedValue(createSession(message)),
      createSession: vi.fn(),
      updateSessionStatus: vi.fn(),
      updateBinding: vi.fn(),
      updateLastCodexTurnId: vi.fn(),
      updateSkillContextKey: vi.fn(),
      updateConversationProvider: vi.fn(),
      withSessionLock: vi.fn(async (_sessionKey, work) => work())
    };
    const conversationProvider: ConversationProviderPort = {
      runTurn: vi.fn(async (_message, options) => {
        await options?.onQueued?.();
        await options?.onStarted?.();
        await options?.onDraft?.({
          draftId: "draft-should-not-run",
          turnId: "codex-turn-queued",
          sessionKey: message.sessionKey,
          text: "late reply",
          createdAt: "2026-07-01T10:00:03.000Z"
        });
        return [];
      })
    };
    const qqEgress: QqEgressPort = {
      deliver: vi.fn()
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const orchestrator = new BridgeOrchestrator({
      sessionStore,
      transcriptStore,
      turnStore,
      conversationProvider,
      qqEgress
    });

    await expect(orchestrator.handleInbound(message)).resolves.toBeUndefined();
    const bridgeTurnId = vi.mocked(turnStore.createTurn).mock.calls[0]?.[0].turnId;
    expect(turnStore.createTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        turnId: bridgeTurnId,
        status: BridgeTurnStatus.Queued
      })
    );
    expect(turnStore.updateStatus).not.toHaveBeenCalledWith(bridgeTurnId, BridgeTurnStatus.Running);
    expect(turnStore.updateStatus).toHaveBeenCalledWith(
      bridgeTurnId,
      BridgeTurnStatus.Cancelled,
      "Bridge turn was cancelled before start"
    );
    expect(conversationProvider.runTurn).not.toHaveBeenCalled();
    expect(transcriptStore.recordOutbound).not.toHaveBeenCalled();
    expect(qqEgress.deliver).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("suppresses duplicate inbound messages with different ids when the content repeats shortly after", async () => {
    const firstMessage = createMessage({
      messageId: "msg-1",
      text: "重复消息",
      receivedAt: "2026-04-10T21:58:49.000Z"
    });
    const secondMessage = createMessage({
      messageId: "msg-2",
      text: "重复消息",
      receivedAt: "2026-04-10T21:59:10.000Z"
    });

    const transcriptStore: TranscriptStorePort = {
      hasInbound: vi.fn().mockResolvedValue(false),
      recordInbound: vi.fn(),
      recordOutbound: vi.fn(),
      listRecentConversation: vi.fn().mockResolvedValue([])
    };
    const sessionStore: SessionStorePort = {
      getSession: vi.fn().mockResolvedValue(null),
      createSession: vi.fn(),
      updateSessionStatus: vi.fn(),
      updateBinding: vi.fn(),
      updateLastCodexTurnId: vi.fn(),
      updateSkillContextKey: vi.fn(),
      updateConversationProvider: vi.fn(),
      withSessionLock: vi.fn(async (_sessionKey, work) => work())
    };
    const conversationProvider: ConversationProviderPort = {
      runTurn: vi.fn().mockResolvedValue([])
    };
    const qqEgress: QqEgressPort = {
      deliver: vi.fn()
    };

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const deliveryJobStore = createDeliveryJobStore();
    const orchestrator = new BridgeOrchestrator({
      transcriptStore,
      sessionStore,
      deliveryJobStore,
      conversationProvider,
      qqEgress
    });

    await orchestrator.handleInbound(firstMessage);
    await orchestrator.handleInbound(secondMessage);

    expect(transcriptStore.recordInbound).toHaveBeenCalledTimes(1);
    expect(transcriptStore.recordInbound).toHaveBeenCalledWith(firstMessage);
    expect(conversationProvider.runTurn).toHaveBeenCalledTimes(1);
    expect(conversationProvider.runTurn).toHaveBeenCalledWith(
      firstMessage,
      expect.objectContaining({
        onDraft: expect.any(Function)
      })
    );
    expect(warnSpy).toHaveBeenCalledWith(
      "[codex-desktop-orchestrator] duplicate inbound suppressed",
      expect.objectContaining({
        messageId: secondMessage.messageId,
        sessionKey: secondMessage.sessionKey
      })
    );
    warnSpy.mockRestore();
  });

  it("suppresses repeated inbound messages within the window even if another message arrived in between", async () => {
    const firstMessage = createMessage({
      messageId: "msg-a1",
      text: "A",
      receivedAt: "2026-04-10T21:58:49.000Z"
    });
    const secondMessage = createMessage({
      messageId: "msg-b1",
      text: "B",
      receivedAt: "2026-04-10T21:58:59.000Z"
    });
    const repeatedFirstMessage = createMessage({
      messageId: "msg-a2",
      text: "A",
      receivedAt: "2026-04-10T21:59:09.000Z"
    });

    const transcriptStore: TranscriptStorePort = {
      hasInbound: vi.fn().mockResolvedValue(false),
      recordInbound: vi.fn(),
      recordOutbound: vi.fn(),
      listRecentConversation: vi.fn().mockResolvedValue([])
    };
    const sessionStore: SessionStorePort = {
      getSession: vi.fn().mockResolvedValue(null),
      createSession: vi.fn(),
      updateSessionStatus: vi.fn(),
      updateBinding: vi.fn(),
      updateLastCodexTurnId: vi.fn(),
      updateSkillContextKey: vi.fn(),
      updateConversationProvider: vi.fn(),
      withSessionLock: vi.fn(async (_sessionKey, work) => work())
    };
    const conversationProvider: ConversationProviderPort = {
      runTurn: vi.fn().mockResolvedValue([])
    };
    const qqEgress: QqEgressPort = {
      deliver: vi.fn()
    };

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const orchestrator = new BridgeOrchestrator({
      transcriptStore,
      sessionStore,
      conversationProvider,
      qqEgress
    });

    await orchestrator.handleInbound(firstMessage);
    await orchestrator.handleInbound(secondMessage);
    await orchestrator.handleInbound(repeatedFirstMessage);

    expect(transcriptStore.recordInbound).toHaveBeenCalledTimes(2);
    expect(transcriptStore.recordInbound).toHaveBeenNthCalledWith(1, firstMessage);
    expect(transcriptStore.recordInbound).toHaveBeenNthCalledWith(2, secondMessage);
    expect(conversationProvider.runTurn).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(
      "[codex-desktop-orchestrator] duplicate inbound suppressed",
      expect.objectContaining({
        messageId: repeatedFirstMessage.messageId,
        sessionKey: repeatedFirstMessage.sessionKey
      })
    );
    warnSpy.mockRestore();
  });

  it("creates a missing session, processes the turn, and activates the session after success", async () => {
    const message = createMessage();
    const drafts: OutboundDraft[] = [
      {
        draftId: "draft-1",
        sessionKey: message.sessionKey,
        text: "reply-1",
        createdAt: "2026-04-08T10:00:01.000Z"
      },
      {
        draftId: "draft-2",
        sessionKey: message.sessionKey,
        text: "reply-2",
        createdAt: "2026-04-08T10:00:02.000Z"
      }
    ];

    const events: string[] = [];
    const transcriptStore: TranscriptStorePort = {
      hasInbound: vi.fn().mockResolvedValue(false),
      recordInbound: vi.fn(async () => {
        events.push("recordInbound");
      }),
      recordOutbound: vi.fn(async (draft: OutboundDraft) => {
        events.push(`recordOutbound:${draft.draftId}`);
      }),
      listRecentConversation: vi.fn().mockResolvedValue([])
    };

    const sessionStore: SessionStorePort = {
      getSession: vi.fn().mockResolvedValue(null),
      createSession: vi.fn(async () => {
        events.push("createSession");
      }),
      updateSessionStatus: vi.fn(async (_sessionKey, status, lastError) => {
        events.push(`updateSessionStatus:${status}:${lastError ?? "null"}`);
      }),
      updateBinding: vi.fn(),
      updateLastCodexTurnId: vi.fn(),
      updateSkillContextKey: vi.fn(),
      updateConversationProvider: vi.fn(),
      withSessionLock: vi.fn(async (_sessionKey, work) => {
        events.push("withSessionLock");
        return work();
      })
    };

    const conversationProvider: ConversationProviderPort = {
      runTurn: vi.fn(async () => {
        events.push("runTurn");
        return drafts;
      })
    };

    const qqEgress: QqEgressPort = {
      deliver: vi.fn(async (draft: OutboundDraft) => {
        events.push(`deliver:${draft.draftId}`);
        return {
          jobId: `job-${draft.draftId}`,
          sessionKey: draft.sessionKey,
          providerMessageId: null,
          deliveredAt: draft.createdAt
        };
      })
    };

    const orchestrator = new BridgeOrchestrator({
      transcriptStore,
      sessionStore,
      conversationProvider,
      qqEgress
    });

    await orchestrator.handleInbound(message);

    expect(sessionStore.createSession).toHaveBeenCalledWith({
      sessionKey: message.sessionKey,
      accountKey: message.accountKey,
      peerKey: message.peerKey,
      chatType: message.chatType,
      peerId: message.senderId,
      codexThreadRef: null,
      lastCodexTurnId: null,
      skillContextKey: null,
      conversationProvider: null,
      status: BridgeSessionStatus.Active,
      lastInboundAt: message.receivedAt,
      lastOutboundAt: null,
      lastError: null
    });
    expect(transcriptStore.recordInbound).toHaveBeenCalledWith(message);
    expect(conversationProvider.runTurn).toHaveBeenCalledWith(
      message,
      expect.objectContaining({
        onDraft: expect.any(Function)
      })
    );
    expect(transcriptStore.recordOutbound).toHaveBeenNthCalledWith(1, drafts[0]);
    expect(transcriptStore.recordOutbound).toHaveBeenNthCalledWith(2, drafts[1]);
    expect(qqEgress.deliver).toHaveBeenNthCalledWith(1, drafts[0]);
    expect(qqEgress.deliver).toHaveBeenNthCalledWith(2, drafts[1]);
    expect(sessionStore.updateSessionStatus).toHaveBeenLastCalledWith(
      message.sessionKey,
      BridgeSessionStatus.Active,
      null
    );
    expect(events).toEqual([
      "withSessionLock",
      "createSession",
      "recordInbound",
      "runTurn",
      "recordOutbound:draft-1",
      "deliver:draft-1",
      "recordOutbound:draft-2",
      "deliver:draft-2",
      "updateSessionStatus:active:null"
    ]);
  });

  it("marks the session as needing rebind when turn execution fails", async () => {
    const message = createMessage();
    const error = new Error("turn failed");
    const turnStore = createTurnStore();

    const transcriptStore: TranscriptStorePort = {
      hasInbound: vi.fn().mockResolvedValue(false),
      recordInbound: vi.fn(),
      recordOutbound: vi.fn(),
      listRecentConversation: vi.fn().mockResolvedValue([])
    };

    const sessionStore: SessionStorePort = {
      getSession: vi.fn().mockResolvedValue(null),
      createSession: vi.fn(),
      updateSessionStatus: vi.fn(),
      updateBinding: vi.fn(),
      updateLastCodexTurnId: vi.fn(),
      updateSkillContextKey: vi.fn(),
      updateConversationProvider: vi.fn(),
      withSessionLock: vi.fn(async (_sessionKey, work) => work())
    };

    const conversationProvider: ConversationProviderPort = {
      runTurn: vi.fn().mockRejectedValue(error)
    };

    const qqEgress: QqEgressPort = {
      deliver: vi.fn()
    };

    const orchestrator = new BridgeOrchestrator({
      transcriptStore,
      sessionStore,
      turnStore,
      conversationProvider,
      qqEgress
    });

    await expect(orchestrator.handleInbound(message)).rejects.toThrow("turn failed");
    const bridgeTurnId = vi.mocked(turnStore.createTurn).mock.calls[0]?.[0].turnId;
    expect(turnStore.updateStatus).toHaveBeenCalledWith(
      bridgeTurnId,
      BridgeTurnStatus.Failed,
      "turn failed"
    );
    expect(sessionStore.updateSessionStatus).toHaveBeenCalledWith(
      message.sessionKey,
      BridgeSessionStatus.NeedsRebind,
      "turn failed"
    );
    expect(qqEgress.deliver).not.toHaveBeenCalled();
  });

  it("continues later drafts when one delivery fails", async () => {
    const message = createMessage();
    const drafts: OutboundDraft[] = [
      {
        draftId: "draft-1",
        sessionKey: message.sessionKey,
        text: "reply-1",
        createdAt: "2026-04-08T10:00:01.000Z"
      },
      {
        draftId: "draft-2",
        sessionKey: message.sessionKey,
        text: "reply-2",
        createdAt: "2026-04-08T10:00:02.000Z"
      }
    ];
    const error = new Error("delivery failed");

    const transcriptStore: TranscriptStorePort = {
      hasInbound: vi.fn().mockResolvedValue(false),
      recordInbound: vi.fn(),
      recordOutbound: vi.fn(),
      listRecentConversation: vi.fn().mockResolvedValue([])
    };

    const sessionStore: SessionStorePort = {
      getSession: vi.fn().mockResolvedValue(null),
      createSession: vi.fn(),
      updateSessionStatus: vi.fn(),
      updateBinding: vi.fn(),
      updateLastCodexTurnId: vi.fn(),
      updateSkillContextKey: vi.fn(),
      updateConversationProvider: vi.fn(),
      withSessionLock: vi.fn(async (_sessionKey, work) => work())
    };

    const conversationProvider: ConversationProviderPort = {
      runTurn: vi.fn().mockResolvedValue(drafts)
    };

    const qqEgress: QqEgressPort = {
      deliver: vi
        .fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce({
          jobId: "job-2",
          sessionKey: message.sessionKey,
          providerMessageId: null,
          deliveredAt: drafts[1].createdAt
        })
    };

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const deliveryJobStore = createDeliveryJobStore();
    const orchestrator = new BridgeOrchestrator({
      transcriptStore,
      sessionStore,
      deliveryJobStore,
      conversationProvider,
      qqEgress
    });

    await expect(orchestrator.handleInbound(message)).resolves.toBeUndefined();
    expect(transcriptStore.recordOutbound).toHaveBeenCalledWith(drafts[0]);
    expect(transcriptStore.recordOutbound).toHaveBeenCalledWith(drafts[1]);
    expect(qqEgress.deliver).toHaveBeenNthCalledWith(1, drafts[0]);
    expect(qqEgress.deliver).toHaveBeenNthCalledWith(2, drafts[1]);
    expect(sessionStore.updateSessionStatus).toHaveBeenCalledWith(
      message.sessionKey,
      BridgeSessionStatus.Active,
      "draft-1: delivery failed"
    );
    expect(deliveryJobStore.markAttemptFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "draft-1",
        error: "delivery failed"
      })
    );
    expect(deliveryJobStore.markDelivered).toHaveBeenCalledWith({
      jobId: "draft-2",
      deliveredAt: drafts[1].createdAt,
      providerMessageId: null
    });
    expect(warnSpy).toHaveBeenCalledWith(
      "[codex-desktop-orchestrator] draft delivery failed",
      expect.objectContaining({
        sessionKey: message.sessionKey,
        messageId: message.messageId,
        draftId: "draft-1",
        error: "delivery failed"
      })
    );
    warnSpy.mockRestore();
  });

  it("keeps the session active when codex reply polling times out", async () => {
    const message = createMessage();
    const turnStore = createTurnStore();

    const transcriptStore: TranscriptStorePort = {
      hasInbound: vi.fn().mockResolvedValue(false),
      recordInbound: vi.fn(),
      recordOutbound: vi.fn(),
      listRecentConversation: vi.fn().mockResolvedValue([])
    };

    const sessionStore: SessionStorePort = {
      getSession: vi.fn().mockResolvedValue(null),
      createSession: vi.fn(),
      updateSessionStatus: vi.fn(),
      updateBinding: vi.fn(),
      updateLastCodexTurnId: vi.fn(),
      updateSkillContextKey: vi.fn(),
      updateConversationProvider: vi.fn(),
      withSessionLock: vi.fn(async (_sessionKey, work) => work())
    };

    const conversationProvider: ConversationProviderPort = {
      runTurn: vi.fn().mockRejectedValue(
        new DesktopDriverError("Codex desktop reply did not arrive before timeout", "reply_timeout")
      )
    };

    const qqEgress: QqEgressPort = {
      deliver: vi.fn()
    };

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const orchestrator = new BridgeOrchestrator({
      transcriptStore,
      sessionStore,
      turnStore,
      conversationProvider,
      qqEgress
    });

    await expect(orchestrator.handleInbound(message)).resolves.toBeUndefined();
    const bridgeTurnId = vi.mocked(turnStore.createTurn).mock.calls[0]?.[0].turnId;
    expect(turnStore.updateStatus).toHaveBeenCalledWith(
      bridgeTurnId,
      BridgeTurnStatus.TimedOut,
      "Codex desktop reply did not arrive before timeout"
    );
    expect(sessionStore.updateSessionStatus).toHaveBeenCalledWith(
      message.sessionKey,
      BridgeSessionStatus.Active,
      "Codex desktop reply did not arrive before timeout"
    );
    expect(qqEgress.deliver).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      "[codex-desktop-orchestrator] recoverable turn error",
      expect.objectContaining({
        messageId: message.messageId,
        sessionKey: message.sessionKey,
        error: "Codex desktop reply did not arrive before timeout"
      })
    );
  });

  it("keeps the session active when Codex rejects the message input", async () => {
    const message = createMessage();
    const turnStore = createTurnStore();

    const transcriptStore: TranscriptStorePort = {
      hasInbound: vi.fn().mockResolvedValue(false),
      recordInbound: vi.fn(),
      recordOutbound: vi.fn(),
      listRecentConversation: vi.fn().mockResolvedValue([])
    };

    const sessionStore: SessionStorePort = {
      getSession: vi.fn().mockResolvedValue(null),
      createSession: vi.fn(),
      updateSessionStatus: vi.fn(),
      updateBinding: vi.fn(),
      updateLastCodexTurnId: vi.fn(),
      updateSkillContextKey: vi.fn(),
      updateConversationProvider: vi.fn(),
      withSessionLock: vi.fn(async (_sessionKey, work) => work())
    };

    const conversationProvider: ConversationProviderPort = {
      runTurn: vi.fn().mockRejectedValue(
        new DesktopDriverError("Codex app-server turn failed: service_error", "service_error")
      )
    };

    const qqEgress: QqEgressPort = {
      deliver: vi.fn()
    };

    const orchestrator = new BridgeOrchestrator({
      transcriptStore,
      sessionStore,
      turnStore,
      conversationProvider,
      qqEgress
    });

    await expect(orchestrator.handleInbound(message)).rejects.toMatchObject({
      reason: "service_error"
    });
    const bridgeTurnId = vi.mocked(turnStore.createTurn).mock.calls[0]?.[0].turnId;
    expect(turnStore.updateStatus).toHaveBeenCalledWith(
      bridgeTurnId,
      BridgeTurnStatus.Failed,
      "Codex app-server turn failed: service_error"
    );
    expect(sessionStore.updateSessionStatus).toHaveBeenCalledWith(
      message.sessionKey,
      BridgeSessionStatus.Active,
      "Codex app-server turn failed: service_error"
    );
    expect(qqEgress.deliver).not.toHaveBeenCalled();
  });

  it("keeps the session active when a turn is cancelled", async () => {
    const message = createMessage();
    const turnStore = createTurnStore();

    const transcriptStore: TranscriptStorePort = {
      hasInbound: vi.fn().mockResolvedValue(false),
      recordInbound: vi.fn(),
      recordOutbound: vi.fn(),
      listRecentConversation: vi.fn().mockResolvedValue([])
    };

    const sessionStore: SessionStorePort = {
      getSession: vi.fn().mockResolvedValue(null),
      createSession: vi.fn(),
      updateSessionStatus: vi.fn(),
      updateBinding: vi.fn(),
      updateLastCodexTurnId: vi.fn(),
      updateSkillContextKey: vi.fn(),
      updateConversationProvider: vi.fn(),
      withSessionLock: vi.fn(async (_sessionKey, work) => work())
    };

    const conversationProvider: ConversationProviderPort = {
      runTurn: vi.fn().mockRejectedValue(
        new DesktopDriverError("Codex app-server turn was cancelled", "turn_cancelled")
      )
    };

    const qqEgress: QqEgressPort = {
      deliver: vi.fn()
    };

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const orchestrator = new BridgeOrchestrator({
      transcriptStore,
      sessionStore,
      turnStore,
      conversationProvider,
      qqEgress
    });

    await expect(orchestrator.handleInbound(message)).resolves.toBeUndefined();
    const bridgeTurnId = vi.mocked(turnStore.createTurn).mock.calls[0]?.[0].turnId;
    expect(turnStore.updateStatus).toHaveBeenCalledWith(
      bridgeTurnId,
      BridgeTurnStatus.Cancelled,
      "Codex app-server turn was cancelled"
    );
    expect(sessionStore.updateSessionStatus).toHaveBeenCalledWith(
      message.sessionKey,
      BridgeSessionStatus.Active,
      "Codex app-server turn was cancelled"
    );
    expect(qqEgress.deliver).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("suppresses later drafts when a task was cancelled cooperatively", async () => {
    const message = createMessage();
    const turnStore = createTurnStore();
    vi.mocked(turnStore.getTurn).mockResolvedValue({
      turnId: "bridge-turn-cancelled",
      sessionKey: message.sessionKey,
      codexThreadRef: "thread-1",
      codexTurnRef: null,
      qqMessageId: message.messageId,
      status: BridgeTurnStatus.Cancelled,
      startedAt: "2026-07-01T10:00:00.000Z",
      updatedAt: "2026-07-01T10:00:01.000Z",
      deadlineAt: null,
      lastEventAt: null,
      lastToolName: null,
      lastError: null,
      deliveredTextLength: 0
    });

    const transcriptStore: TranscriptStorePort = {
      hasInbound: vi.fn().mockResolvedValue(false),
      recordInbound: vi.fn(),
      recordOutbound: vi.fn(),
      listRecentConversation: vi.fn().mockResolvedValue([])
    };

    const sessionStore: SessionStorePort = {
      getSession: vi.fn().mockResolvedValue(createSession(message)),
      createSession: vi.fn(),
      updateSessionStatus: vi.fn(),
      updateBinding: vi.fn(),
      updateLastCodexTurnId: vi.fn(),
      updateSkillContextKey: vi.fn(),
      updateConversationProvider: vi.fn(),
      withSessionLock: vi.fn(async (_sessionKey, work) => work())
    };

    const conversationProvider: ConversationProviderPort = {
      runTurn: vi.fn(async (_message, options) => {
        await options?.onDraft?.({
          draftId: "draft-after-cancel",
          turnId: "codex-turn-1",
          sessionKey: message.sessionKey,
          text: "late reply",
          createdAt: "2026-07-01T10:00:02.000Z"
        });
        return [];
      })
    };

    const qqEgress: QqEgressPort = {
      deliver: vi.fn()
    };

    const orchestrator = new BridgeOrchestrator({
      transcriptStore,
      sessionStore,
      turnStore,
      conversationProvider,
      qqEgress
    });

    await orchestrator.handleInbound(message);

    expect(transcriptStore.recordOutbound).not.toHaveBeenCalled();
    expect(qqEgress.deliver).not.toHaveBeenCalled();
    expect(turnStore.updateStatus).not.toHaveBeenCalledWith(
      expect.any(String),
      BridgeTurnStatus.Completed,
      expect.anything()
    );
  });

  it("suppresses completed turn events that arrive after cancellation", async () => {
    const message = createMessage();
    const turnStore = createTurnStore();
    vi.mocked(turnStore.getTurnByCodexTurn).mockResolvedValue({
      turnId: "bridge-turn-cancelled",
      sessionKey: message.sessionKey,
      codexThreadRef: "thread-1",
      codexTurnRef: "codex-turn-1",
      qqMessageId: message.messageId,
      status: BridgeTurnStatus.Cancelled,
      startedAt: "2026-07-01T10:00:00.000Z",
      updatedAt: "2026-07-01T10:00:02.000Z",
      deadlineAt: null,
      lastEventAt: null,
      lastToolName: null,
      lastError: null,
      deliveredTextLength: 0
    });

    const transcriptStore: TranscriptStorePort = {
      hasInbound: vi.fn().mockResolvedValue(false),
      recordInbound: vi.fn(),
      recordOutbound: vi.fn(),
      listRecentConversation: vi.fn().mockResolvedValue([])
    };
    const sessionStore: SessionStorePort = {
      getSession: vi.fn().mockResolvedValue(createSession(message)),
      createSession: vi.fn(),
      updateSessionStatus: vi.fn(),
      updateBinding: vi.fn(),
      updateLastCodexTurnId: vi.fn(),
      updateSkillContextKey: vi.fn(),
      updateConversationProvider: vi.fn(),
      withSessionLock: vi.fn(async (_sessionKey, work) => work())
    };
    const conversationProvider: ConversationProviderPort = {
      runTurn: vi.fn()
    };
    const qqEgress: QqEgressPort = {
      deliver: vi.fn()
    };
    const orchestrator = new BridgeOrchestrator({
      sessionStore,
      transcriptStore,
      turnStore,
      conversationProvider,
      qqEgress
    });

    await orchestrator.handleTurnEvent({
      sessionKey: message.sessionKey,
      turnId: "codex-turn-1",
      sequence: 1,
      eventType: TurnEventType.Completed,
      createdAt: "2026-07-01T10:00:05.000Z",
      isFinal: true,
      payload: {
        fullText: "late reply",
        replyToMessageId: message.messageId,
        completionReason: "stable"
      }
    });

    expect(sessionStore.updateLastCodexTurnId).not.toHaveBeenCalled();
    expect(turnStore.getTurnByCodexTurn).toHaveBeenCalledWith(
      message.sessionKey,
      "codex-turn-1",
      message.messageId
    );
    expect(turnStore.recordTurnEvent).not.toHaveBeenCalled();
    expect(transcriptStore.recordOutbound).not.toHaveBeenCalled();
    expect(qqEgress.deliver).not.toHaveBeenCalled();
  });

  it("records failed completed turn events as failed without delivering a final draft", async () => {
    const message = createMessage();
    const turnStore = createTurnStore();
    const transcriptStore: TranscriptStorePort = {
      hasInbound: vi.fn().mockResolvedValue(false),
      recordInbound: vi.fn(),
      recordOutbound: vi.fn(),
      listRecentConversation: vi.fn().mockResolvedValue([])
    };
    const sessionStore: SessionStorePort = {
      getSession: vi.fn().mockResolvedValue(createSession(message)),
      createSession: vi.fn(),
      updateSessionStatus: vi.fn(),
      updateBinding: vi.fn(),
      updateLastCodexTurnId: vi.fn(),
      updateSkillContextKey: vi.fn(),
      updateConversationProvider: vi.fn(),
      withSessionLock: vi.fn(async (_sessionKey, work) => work())
    };
    const conversationProvider: ConversationProviderPort = {
      runTurn: vi.fn()
    };
    const qqEgress: QqEgressPort = {
      deliver: vi.fn()
    };
    const orchestrator = new BridgeOrchestrator({
      sessionStore,
      transcriptStore,
      turnStore,
      conversationProvider,
      qqEgress
    });

    await orchestrator.handleTurnEvent({
      sessionKey: message.sessionKey,
      turnId: "codex-turn-failed",
      sequence: 1,
      eventType: TurnEventType.Completed,
      createdAt: "2026-07-01T10:00:05.000Z",
      isFinal: true,
      payload: {
        status: "failed"
      }
    });

    expect(turnStore.recordTurnEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: message.sessionKey,
        codexTurnRef: "codex-turn-failed",
        status: BridgeTurnStatus.Failed,
        lastError: "failed"
      })
    );
    expect(transcriptStore.recordOutbound).not.toHaveBeenCalled();
    expect(qqEgress.deliver).not.toHaveBeenCalled();
  });

  it("records cancelled completed turn events as cancelled", async () => {
    const message = createMessage();
    const turnStore = createTurnStore();
    const transcriptStore: TranscriptStorePort = {
      hasInbound: vi.fn().mockResolvedValue(false),
      recordInbound: vi.fn(),
      recordOutbound: vi.fn(),
      listRecentConversation: vi.fn().mockResolvedValue([])
    };
    const sessionStore: SessionStorePort = {
      getSession: vi.fn().mockResolvedValue(createSession(message)),
      createSession: vi.fn(),
      updateSessionStatus: vi.fn(),
      updateBinding: vi.fn(),
      updateLastCodexTurnId: vi.fn(),
      updateSkillContextKey: vi.fn(),
      updateConversationProvider: vi.fn(),
      withSessionLock: vi.fn(async (_sessionKey, work) => work())
    };
    const orchestrator = new BridgeOrchestrator({
      sessionStore,
      transcriptStore,
      turnStore,
      conversationProvider: { runTurn: vi.fn() },
      qqEgress: { deliver: vi.fn() }
    });

    await orchestrator.handleTurnEvent({
      sessionKey: message.sessionKey,
      turnId: "codex-turn-cancelled",
      sequence: 1,
      eventType: TurnEventType.Completed,
      createdAt: "2026-07-01T10:00:05.000Z",
      isFinal: true,
      payload: {
        status: "cancelled"
      }
    });

    expect(turnStore.recordTurnEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        codexTurnRef: "codex-turn-cancelled",
        status: BridgeTurnStatus.Cancelled,
        lastError: "cancelled"
      })
    );
    expect(transcriptStore.recordOutbound).not.toHaveBeenCalled();
  });

  it("records context length completed turn events as failed", async () => {
    const message = createMessage();
    const turnStore = createTurnStore();
    const transcriptStore: TranscriptStorePort = {
      hasInbound: vi.fn().mockResolvedValue(false),
      recordInbound: vi.fn(),
      recordOutbound: vi.fn(),
      listRecentConversation: vi.fn().mockResolvedValue([])
    };
    const sessionStore: SessionStorePort = {
      getSession: vi.fn().mockResolvedValue(createSession(message)),
      createSession: vi.fn(),
      updateSessionStatus: vi.fn(),
      updateBinding: vi.fn(),
      updateLastCodexTurnId: vi.fn(),
      updateSkillContextKey: vi.fn(),
      updateConversationProvider: vi.fn(),
      withSessionLock: vi.fn(async (_sessionKey, work) => work())
    };
    const orchestrator = new BridgeOrchestrator({
      sessionStore,
      transcriptStore,
      turnStore,
      conversationProvider: { runTurn: vi.fn() },
      qqEgress: { deliver: vi.fn() }
    });
    const status = JSON.stringify({
      message: "Your input exceeds the context window of this model",
      kind: "context_length_exceeded",
      code: "context_length_exceeded"
    });

    await orchestrator.handleTurnEvent({
      sessionKey: message.sessionKey,
      turnId: "codex-turn-context-length",
      sequence: 1,
      eventType: TurnEventType.Completed,
      createdAt: "2026-07-01T10:00:05.000Z",
      isFinal: true,
      payload: {
        status
      }
    });

    expect(turnStore.recordTurnEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        codexTurnRef: "codex-turn-context-length",
        status: BridgeTurnStatus.Failed,
        lastError: status
      })
    );
    expect(transcriptStore.recordOutbound).not.toHaveBeenCalled();
  });

  it("records tool events without delivering tool progress to qq", async () => {
    const message = createMessage();
    const turnStore = createTurnStore();
    const transcriptStore: TranscriptStorePort = {
      hasInbound: vi.fn().mockResolvedValue(false),
      recordInbound: vi.fn(),
      recordOutbound: vi.fn(),
      listRecentConversation: vi.fn().mockResolvedValue([])
    };
    const sessionStore: SessionStorePort = {
      getSession: vi.fn().mockResolvedValue(createSession(message)),
      createSession: vi.fn(),
      updateSessionStatus: vi.fn(),
      updateBinding: vi.fn(),
      updateLastCodexTurnId: vi.fn(),
      updateSkillContextKey: vi.fn(),
      updateConversationProvider: vi.fn(),
      withSessionLock: vi.fn(async (_sessionKey, work) => work())
    };
    const qqEgress: QqEgressPort = {
      deliver: vi.fn()
    };
    const orchestrator = new BridgeOrchestrator({
      sessionStore,
      transcriptStore,
      turnStore,
      conversationProvider: { runTurn: vi.fn() },
      qqEgress
    });

    await orchestrator.handleTurnEvent({
      sessionKey: message.sessionKey,
      turnId: "codex-turn-tool",
      sequence: 1,
      eventType: TurnEventType.Status,
      createdAt: "2026-07-01T10:00:05.000Z",
      isFinal: false,
      payload: {
        toolName: "pnpm run check",
        toolStatus: "started",
        replyToMessageId: message.messageId
      }
    });

    expect(turnStore.recordTurnEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: message.sessionKey,
        codexTurnRef: "codex-turn-tool",
        status: BridgeTurnStatus.ToolRunning,
        lastToolName: "pnpm run check"
      })
    );
    expect(transcriptStore.recordOutbound).not.toHaveBeenCalled();
    expect(qqEgress.deliver).not.toHaveBeenCalled();
  });

  it("does not persist non-terminal failed tool summaries as turn errors", async () => {
    const message = createMessage();
    const turnStore = createTurnStore();
    const transcriptStore: TranscriptStorePort = {
      hasInbound: vi.fn().mockResolvedValue(false),
      recordInbound: vi.fn(),
      recordOutbound: vi.fn(),
      listRecentConversation: vi.fn().mockResolvedValue([])
    };
    const sessionStore: SessionStorePort = {
      getSession: vi.fn().mockResolvedValue(createSession(message)),
      createSession: vi.fn(),
      updateSessionStatus: vi.fn(),
      updateBinding: vi.fn(),
      updateLastCodexTurnId: vi.fn(),
      updateSkillContextKey: vi.fn(),
      updateConversationProvider: vi.fn(),
      withSessionLock: vi.fn(async (_sessionKey, work) => work())
    };
    const orchestrator = new BridgeOrchestrator({
      sessionStore,
      transcriptStore,
      turnStore,
      conversationProvider: { runTurn: vi.fn() },
      qqEgress: { deliver: vi.fn() }
    });

    await orchestrator.handleTurnEvent({
      sessionKey: message.sessionKey,
      turnId: "codex-turn-tool",
      sequence: 1,
      eventType: TurnEventType.Status,
      createdAt: "2026-07-01T10:00:05.000Z",
      isFinal: false,
      payload: {
        toolName: "pnpm run check",
        toolStatus: "failed",
        summary: "exit code 1"
      }
    });

    expect(turnStore.recordTurnEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        status: BridgeTurnStatus.ToolRunning,
        lastToolName: "pnpm run check",
        lastError: null
      })
    );
  });

  it("does not deliver high-frequency tool output progress to qq", async () => {
    const message = createMessage();
    const turnStore = createTurnStore();
    const transcriptStore: TranscriptStorePort = {
      hasInbound: vi.fn().mockResolvedValue(false),
      recordInbound: vi.fn(),
      recordOutbound: vi.fn(),
      listRecentConversation: vi.fn().mockResolvedValue([])
    };
    const sessionStore: SessionStorePort = {
      getSession: vi.fn().mockResolvedValue(createSession(message)),
      createSession: vi.fn(),
      updateSessionStatus: vi.fn(),
      updateBinding: vi.fn(),
      updateLastCodexTurnId: vi.fn(),
      updateSkillContextKey: vi.fn(),
      updateConversationProvider: vi.fn(),
      withSessionLock: vi.fn(async (_sessionKey, work) => work())
    };
    const qqEgress: QqEgressPort = {
      deliver: vi.fn()
    };
    const orchestrator = new BridgeOrchestrator({
      sessionStore,
      transcriptStore,
      turnStore,
      conversationProvider: { runTurn: vi.fn() },
      qqEgress
    });

    await orchestrator.handleTurnEvent({
      sessionKey: message.sessionKey,
      turnId: "codex-turn-tool",
      sequence: 1,
      eventType: TurnEventType.Status,
      createdAt: "2026-07-01T10:00:00.000Z",
      isFinal: false,
      payload: {
        toolName: "pnpm run check",
        toolStatus: "output",
        summary: "first chunk"
      }
    });
    await orchestrator.handleTurnEvent({
      sessionKey: message.sessionKey,
      turnId: "codex-turn-tool",
      sequence: 2,
      eventType: TurnEventType.Status,
      createdAt: "2026-07-01T10:00:10.000Z",
      isFinal: false,
      payload: {
        toolName: "pnpm run check",
        toolStatus: "output",
        summary: "second chunk"
      }
    });

    expect(turnStore.recordTurnEvent).toHaveBeenCalledTimes(2);
    expect(transcriptStore.recordOutbound).not.toHaveBeenCalled();
    expect(qqEgress.deliver).not.toHaveBeenCalled();
  });

  it("delivers incremental drafts as they arrive and does not resend them after runTurn completes", async () => {
    const message = createMessage();
    const firstDraft: OutboundDraft = {
      draftId: "draft-partial-1",
      sessionKey: message.sessionKey,
      text: "先回一句",
      createdAt: "2026-04-10T10:00:01.000Z"
    };
    const secondDraft: OutboundDraft = {
      draftId: "draft-partial-2",
      sessionKey: message.sessionKey,
      text: "补充第二段",
      createdAt: "2026-04-10T10:00:03.000Z"
    };

    const transcriptStore: TranscriptStorePort = {
      hasInbound: vi.fn().mockResolvedValue(false),
      recordInbound: vi.fn(),
      recordOutbound: vi.fn(),
      listRecentConversation: vi.fn().mockResolvedValue([])
    };

    const sessionStore: SessionStorePort = {
      getSession: vi.fn().mockResolvedValue(createSession(message)),
      createSession: vi.fn(),
      updateSessionStatus: vi.fn(),
      updateBinding: vi.fn(),
      updateLastCodexTurnId: vi.fn(),
      updateSkillContextKey: vi.fn(),
      updateConversationProvider: vi.fn(),
      withSessionLock: vi.fn(async (_sessionKey, work) => work())
    };

    const conversationProvider: ConversationProviderPort = {
      runTurn: vi.fn(async (_message, options) => {
        await options?.onDraft?.(firstDraft);
        await options?.onDraft?.(secondDraft);
        return [];
      })
    };

    const qqEgress: QqEgressPort = {
      deliver: vi.fn(async (draft: OutboundDraft) => ({
        jobId: `job-${draft.draftId}`,
        sessionKey: draft.sessionKey,
        providerMessageId: null,
        deliveredAt: draft.createdAt
      }))
    };

    const orchestrator = new BridgeOrchestrator({
      transcriptStore,
      sessionStore,
      conversationProvider,
      qqEgress
    });

    await orchestrator.handleInbound(message);

    expect(transcriptStore.recordOutbound).toHaveBeenNthCalledWith(1, firstDraft);
    expect(transcriptStore.recordOutbound).toHaveBeenNthCalledWith(2, secondDraft);
    expect(qqEgress.deliver).toHaveBeenNthCalledWith(1, firstDraft);
    expect(qqEgress.deliver).toHaveBeenNthCalledWith(2, secondDraft);
    expect(qqEgress.deliver).toHaveBeenCalledTimes(2);
    expect(conversationProvider.runTurn).toHaveBeenCalledWith(
      message,
      expect.objectContaining({
        onDraft: expect.any(Function)
      })
    );
  });

  it("does not trim repeated independent incremental draft text", async () => {
    const message = createMessage();
    const firstDraft: OutboundDraft = {
      draftId: "draft-repeat-1",
      turnId: "turn-repeat-1",
      sessionKey: message.sessionKey,
      text: "same chunk",
      createdAt: "2026-04-10T10:00:01.000Z"
    };
    const secondDraft: OutboundDraft = {
      draftId: "draft-repeat-2",
      turnId: "turn-repeat-1",
      sessionKey: message.sessionKey,
      text: "same chunk",
      createdAt: "2026-04-10T10:00:03.000Z"
    };

    const transcriptStore: TranscriptStorePort = {
      hasInbound: vi.fn().mockResolvedValue(false),
      recordInbound: vi.fn(),
      recordOutbound: vi.fn(),
      listRecentConversation: vi.fn().mockResolvedValue([])
    };

    const sessionStore: SessionStorePort = {
      getSession: vi.fn().mockResolvedValue(createSession(message)),
      createSession: vi.fn(),
      updateSessionStatus: vi.fn(),
      updateBinding: vi.fn(),
      updateLastCodexTurnId: vi.fn(),
      updateSkillContextKey: vi.fn(),
      updateConversationProvider: vi.fn(),
      withSessionLock: vi.fn(async (_sessionKey, work) => work())
    };

    const conversationProvider: ConversationProviderPort = {
      runTurn: vi.fn(async (_message, options) => {
        await options?.onDraft?.(firstDraft);
        await options?.onDraft?.(secondDraft);
        return [];
      })
    };

    const qqEgress: QqEgressPort = {
      deliver: vi.fn(async (draft: OutboundDraft) => ({
        jobId: `job-${draft.draftId}`,
        sessionKey: draft.sessionKey,
        providerMessageId: null,
        deliveredAt: draft.createdAt
      }))
    };

    const orchestrator = new BridgeOrchestrator({
      transcriptStore,
      sessionStore,
      conversationProvider,
      qqEgress
    });

    await orchestrator.handleInbound(message);

    expect(transcriptStore.recordOutbound).toHaveBeenNthCalledWith(1, firstDraft);
    expect(transcriptStore.recordOutbound).toHaveBeenNthCalledWith(2, secondDraft);
    expect(qqEgress.deliver).toHaveBeenNthCalledWith(1, firstDraft);
    expect(qqEgress.deliver).toHaveBeenNthCalledWith(2, secondDraft);
    expect(qqEgress.deliver).toHaveBeenCalledTimes(2);
  });

  it("flushes only the missing tail text when a completed turn event carries a longer full text", async () => {
    const message = createMessage();
    const firstDraft: OutboundDraft = {
      draftId: "draft-partial-1",
      turnId: "turn-1",
      sessionKey: message.sessionKey,
      text: "前半段",
      createdAt: "2026-04-12T12:00:01.000Z"
    };

    const transcriptStore: TranscriptStorePort = {
      hasInbound: vi.fn().mockResolvedValue(false),
      recordInbound: vi.fn(),
      recordOutbound: vi.fn(),
      listRecentConversation: vi.fn().mockResolvedValue([])
    };

    const sessionStore: SessionStorePort = {
      getSession: vi.fn().mockResolvedValue(createSession(message)),
      createSession: vi.fn(),
      updateSessionStatus: vi.fn(),
      updateBinding: vi.fn(),
      updateLastCodexTurnId: vi.fn(),
      updateSkillContextKey: vi.fn(),
      updateConversationProvider: vi.fn(),
      withSessionLock: vi.fn(async (_sessionKey, work) => work())
    };

    let orchestrator!: BridgeOrchestrator;
    const conversationProvider: ConversationProviderPort = {
      runTurn: vi.fn(async (_message, options) => {
        await options?.onDraft?.(firstDraft);
        await orchestrator.handleTurnEvent({
          sessionKey: message.sessionKey,
          turnId: "turn-1",
          sequence: 2,
          eventType: TurnEventType.Completed,
          createdAt: "2026-04-12T12:00:03.000Z",
          isFinal: true,
          payload: {
            fullText: "前半段后半段",
            replyToMessageId: message.messageId,
            completionReason: "stable"
          }
        });
        return [];
      })
    };

    const qqEgress: QqEgressPort = {
      deliver: vi.fn(async (draft: OutboundDraft) => ({
        jobId: `job-${draft.draftId}`,
        sessionKey: draft.sessionKey,
        providerMessageId: null,
        deliveredAt: draft.createdAt
      }))
    };

    orchestrator = new BridgeOrchestrator({
      transcriptStore,
      sessionStore,
      conversationProvider,
      qqEgress,
      draftFormatter: (draft) => formatWeixinOutboundDraft(enrichQqOutboundDraft(draft))
    });

    await orchestrator.handleInbound(message);

    expect(qqEgress.deliver).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ text: "前半段", turnId: "turn-1" })
    );
    expect(qqEgress.deliver).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ text: "后半段", replyToMessageId: message.messageId })
    );
  });

  it("does not redeliver the returned final draft after a completed event flushed the same text", async () => {
    const message = createMessage();
    const finalDraft: OutboundDraft = {
      draftId: "draft-final-1",
      turnId: "turn-final-1",
      sessionKey: message.sessionKey,
      text: "final reply",
      createdAt: "2026-04-12T12:00:04.000Z"
    };

    const transcriptStore: TranscriptStorePort = {
      hasInbound: vi.fn().mockResolvedValue(false),
      recordInbound: vi.fn(),
      recordOutbound: vi.fn(),
      listRecentConversation: vi.fn().mockResolvedValue([])
    };

    const sessionStore: SessionStorePort = {
      getSession: vi.fn().mockResolvedValue(createSession(message)),
      createSession: vi.fn(),
      updateSessionStatus: vi.fn(),
      updateBinding: vi.fn(),
      updateLastCodexTurnId: vi.fn(),
      updateSkillContextKey: vi.fn(),
      updateConversationProvider: vi.fn(),
      withSessionLock: vi.fn(async (_sessionKey, work) => work())
    };

    let orchestrator!: BridgeOrchestrator;
    const conversationProvider: ConversationProviderPort = {
      runTurn: vi.fn(async () => {
        await orchestrator.handleTurnEvent({
          sessionKey: message.sessionKey,
          turnId: "turn-final-1",
          sequence: 1,
          eventType: TurnEventType.Completed,
          createdAt: "2026-04-12T12:00:03.000Z",
          isFinal: true,
          payload: {
            fullText: "final reply",
            replyToMessageId: message.messageId,
            completionReason: "stable"
          }
        });
        return [finalDraft];
      })
    };

    const qqEgress: QqEgressPort = {
      deliver: vi.fn(async (draft: OutboundDraft) => ({
        jobId: `job-${draft.draftId}`,
        sessionKey: draft.sessionKey,
        providerMessageId: null,
        deliveredAt: draft.createdAt
      }))
    };

    orchestrator = new BridgeOrchestrator({
      transcriptStore,
      sessionStore,
      conversationProvider,
      qqEgress
    });

    await orchestrator.handleInbound(message);

    expect(qqEgress.deliver).toHaveBeenCalledTimes(1);
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({ text: "final reply", turnId: "turn-final-1" })
    );
    expect(transcriptStore.recordOutbound).toHaveBeenCalledTimes(1);
  });

  it("marks completed tail flush delivery failures before propagating them", async () => {
    const message = createMessage();
    const firstDraft: OutboundDraft = {
      draftId: "draft-partial-1",
      turnId: "turn-1",
      sessionKey: message.sessionKey,
      text: "first half",
      createdAt: "2026-04-12T12:00:01.000Z"
    };

    const transcriptStore: TranscriptStorePort = {
      hasInbound: vi.fn().mockResolvedValue(false),
      recordInbound: vi.fn(),
      recordOutbound: vi.fn(),
      listRecentConversation: vi.fn().mockResolvedValue([])
    };

    const sessionStore: SessionStorePort = {
      getSession: vi.fn().mockResolvedValue(createSession(message)),
      createSession: vi.fn(),
      updateSessionStatus: vi.fn(),
      updateBinding: vi.fn(),
      updateLastCodexTurnId: vi.fn(),
      updateSkillContextKey: vi.fn(),
      updateConversationProvider: vi.fn(),
      withSessionLock: vi.fn(async (_sessionKey, work) => work())
    };
    const deliveryJobStore = createDeliveryJobStore();

    let orchestrator!: BridgeOrchestrator;
    const conversationProvider: ConversationProviderPort = {
      runTurn: vi.fn(async (_message, options) => {
        await options?.onDraft?.(firstDraft);
        await orchestrator.handleTurnEvent({
          sessionKey: message.sessionKey,
          turnId: "turn-1",
          sequence: 2,
          eventType: TurnEventType.Completed,
          createdAt: "2026-04-12T12:00:03.000Z",
          isFinal: true,
          payload: {
            fullText: "first half plus tail",
            replyToMessageId: message.messageId,
            completionReason: "stable"
          }
        });
        return [];
      })
    };

    const qqEgress: QqEgressPort = {
      deliver: vi
        .fn()
        .mockResolvedValueOnce({
          jobId: "job-draft-partial-1",
          sessionKey: message.sessionKey,
          providerMessageId: null,
          deliveredAt: firstDraft.createdAt
        })
        .mockRejectedValueOnce(new Error("tail send failed"))
    };

    orchestrator = new BridgeOrchestrator({
      transcriptStore,
      sessionStore,
      deliveryJobStore,
      conversationProvider,
      qqEgress
    });

    await expect(orchestrator.handleInbound(message)).rejects.toThrow("tail send failed");
    expect(deliveryJobStore.markAttemptFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "tail send failed",
        maxAttempts: 1
      })
    );
  });

  it("does not duplicate completed flush when incremental drafts trim whitespace between segments", async () => {
    const message = createMessage();
    const firstDraft: OutboundDraft = {
      draftId: "draft-partial-1",
      turnId: "turn-2",
      sessionKey: message.sessionKey,
      text: "hello",
      createdAt: "2026-04-12T12:10:01.000Z"
    };
    const secondDraft: OutboundDraft = {
      draftId: "draft-partial-2",
      turnId: "turn-2",
      sessionKey: message.sessionKey,
      text: "world",
      createdAt: "2026-04-12T12:10:02.000Z"
    };

    const transcriptStore: TranscriptStorePort = {
      hasInbound: vi.fn().mockResolvedValue(false),
      recordInbound: vi.fn(),
      recordOutbound: vi.fn(),
      listRecentConversation: vi.fn().mockResolvedValue([])
    };

    const sessionStore: SessionStorePort = {
      getSession: vi.fn().mockResolvedValue(createSession(message)),
      createSession: vi.fn(),
      updateSessionStatus: vi.fn(),
      updateBinding: vi.fn(),
      updateLastCodexTurnId: vi.fn(),
      updateSkillContextKey: vi.fn(),
      updateConversationProvider: vi.fn(),
      withSessionLock: vi.fn(async (_sessionKey, work) => work())
    };

    let orchestrator!: BridgeOrchestrator;
    const conversationProvider: ConversationProviderPort = {
      runTurn: vi.fn(async (_message, options) => {
        await options?.onDraft?.(firstDraft);
        await options?.onDraft?.(secondDraft);
        await orchestrator.handleTurnEvent({
          sessionKey: message.sessionKey,
          turnId: "turn-2",
          sequence: 3,
          eventType: TurnEventType.Completed,
          createdAt: "2026-04-12T12:10:03.000Z",
          isFinal: true,
          payload: {
            fullText: "hello world",
            replyToMessageId: message.messageId,
            completionReason: "stable"
          }
        });
        return [];
      })
    };

    const qqEgress: QqEgressPort = {
      deliver: vi.fn(async (draft: OutboundDraft) => ({
        jobId: `job-${draft.draftId}`,
        sessionKey: draft.sessionKey,
        providerMessageId: null,
        deliveredAt: draft.createdAt
      }))
    };

    orchestrator = new BridgeOrchestrator({
      transcriptStore,
      sessionStore,
      conversationProvider,
      qqEgress
    });

    await orchestrator.handleInbound(message);

    expect(qqEgress.deliver).toHaveBeenCalledTimes(2);
    expect(qqEgress.deliver).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ text: "hello", turnId: "turn-2" })
    );
    expect(qqEgress.deliver).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ text: "world", turnId: "turn-2" })
    );
  });

  it("does not resend media artifacts on completed turn events after a media-only draft already delivered them", async () => {
    const message = createMessage();
    const mediaDraft: OutboundDraft = {
      draftId: "draft-media-1",
      turnId: "turn-3",
      sessionKey: message.sessionKey,
      text: "",
      mediaArtifacts: [
        {
          kind: MediaArtifactKind.Image,
          sourceUrl: "/tmp/demo.jpg",
          localPath: "/tmp/demo.jpg",
          mimeType: "image/jpeg",
          fileSize: 1024,
          originalName: "demo.jpg"
        }
      ],
      createdAt: "2026-04-12T12:20:01.000Z"
    };

    const transcriptStore: TranscriptStorePort = {
      hasInbound: vi.fn().mockResolvedValue(false),
      recordInbound: vi.fn(),
      recordOutbound: vi.fn(),
      listRecentConversation: vi.fn().mockResolvedValue([])
    };

    const sessionStore: SessionStorePort = {
      getSession: vi.fn().mockResolvedValue(createSession(message)),
      createSession: vi.fn(),
      updateSessionStatus: vi.fn(),
      updateBinding: vi.fn(),
      updateLastCodexTurnId: vi.fn(),
      updateSkillContextKey: vi.fn(),
      updateConversationProvider: vi.fn(),
      withSessionLock: vi.fn(async (_sessionKey, work) => work())
    };

    let orchestrator!: BridgeOrchestrator;
    const conversationProvider: ConversationProviderPort = {
      runTurn: vi.fn(async (_message, options) => {
        await options?.onDraft?.(mediaDraft);
        await orchestrator.handleTurnEvent({
          sessionKey: message.sessionKey,
          turnId: "turn-3",
          sequence: 2,
          eventType: TurnEventType.Completed,
          createdAt: "2026-04-12T12:20:03.000Z",
          isFinal: true,
          payload: {
            fullText: "<qqmedia>/tmp/demo.jpg</qqmedia>",
            replyToMessageId: message.messageId,
            completionReason: "stable"
          }
        });
        return [];
      })
    };

    const qqEgress: QqEgressPort = {
      deliver: vi.fn(async (draft: OutboundDraft) => ({
        jobId: `job-${draft.draftId}`,
        sessionKey: draft.sessionKey,
        providerMessageId: null,
        deliveredAt: draft.createdAt
      }))
    };

    orchestrator = new BridgeOrchestrator({
      transcriptStore,
      sessionStore,
      conversationProvider,
      qqEgress,
      draftFormatter: (draft) => formatWeixinOutboundDraft(enrichQqOutboundDraft(draft))
    });

    await orchestrator.handleInbound(message);

    expect(qqEgress.deliver).toHaveBeenCalledTimes(1);
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        turnId: "turn-3",
        mediaArtifacts: [
          expect.objectContaining({
            localPath: "/tmp/demo.jpg"
          })
        ]
      })
    );
  });
});

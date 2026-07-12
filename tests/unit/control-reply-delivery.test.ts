import { describe, expect, it, vi } from "vitest";
import type {
  DeliveryRecord,
  InboundMessage,
  OutboundDraft
} from "../../packages/domain/src/message.js";
import type { QqEgressPort } from "../../packages/ports/src/qq.js";
import type {
  DeliveryJobStorePort,
  TranscriptStorePort
} from "../../packages/ports/src/store.js";
import { ControlReplyDelivery } from "../../apps/bridge-daemon/src/control-reply-delivery.js";

function createMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: "message-1",
    accountKey: "qqbot:default",
    sessionKey: "qqbot:default::qq:c2c:OPENID123",
    peerKey: "qq:c2c:OPENID123",
    chatType: "c2c",
    senderId: "OPENID123",
    text: "/help",
    receivedAt: "2026-07-08T10:00:00.000Z",
    ...overrides
  };
}

function createTranscriptStore(events: string[] = []): TranscriptStorePort {
  return {
    recordInbound: vi.fn().mockResolvedValue(undefined),
    recordOutbound: vi.fn(async (draft: OutboundDraft) => {
      events.push(`recordOutbound:${draft.draftId}`);
    }),
    hasInbound: vi.fn().mockResolvedValue(false),
    listRecentConversation: vi.fn().mockResolvedValue([])
  };
}

function createDeliveryJobStore(events: string[] = []): DeliveryJobStorePort {
  return {
    claimDueJobs: vi.fn().mockResolvedValue([]),
    markDelivered: vi.fn(async (input) => {
      events.push(`markDelivered:${input.jobId}`);
    }),
    markAttemptFailed: vi.fn(async (input) => {
      events.push(`markAttemptFailed:${input.jobId}`);
    }),
    recoverInFlight: vi.fn().mockResolvedValue(0),
    listJobs: vi.fn().mockResolvedValue([])
  };
}

function createEgress(result: DeliveryRecord, events: string[] = []): QqEgressPort {
  return {
    deliver: vi.fn(async (draft: OutboundDraft) => {
      events.push(`deliver:${draft.draftId}`);
      return result;
    })
  };
}

describe("control reply delivery", () => {
  it("records, delivers, and marks successful synchronous delivery", async () => {
    const events: string[] = [];
    const draft: OutboundDraft = {
      draftId: "draft-1",
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      text: "control reply",
      createdAt: "2026-07-08T10:00:01.000Z",
      replyToMessageId: "message-1"
    };
    const delivery: DeliveryRecord = {
      jobId: draft.draftId,
      sessionKey: draft.sessionKey,
      providerMessageId: "provider-1",
      deliveredAt: "2026-07-08T10:00:02.000Z"
    };
    const transcriptStore = createTranscriptStore(events);
    const deliveryJobStore = createDeliveryJobStore(events);
    const qqEgress = createEgress(delivery, events);
    const service = new ControlReplyDelivery({
      transcriptStore,
      deliveryJobStore,
      qqEgress
    });

    await service.deliverDraft(draft);

    expect(transcriptStore.recordOutbound).toHaveBeenCalledWith(draft);
    expect(qqEgress.deliver).toHaveBeenCalledWith(draft);
    expect(deliveryJobStore.markDelivered).toHaveBeenCalledWith({
      jobId: "draft-1",
      deliveredAt: "2026-07-08T10:00:02.000Z",
      providerMessageId: "provider-1"
    });
    expect(deliveryJobStore.markAttemptFailed).not.toHaveBeenCalled();
    expect(events).toEqual([
      "recordOutbound:draft-1",
      "deliver:draft-1",
      "markDelivered:draft-1"
    ]);
  });

  it("marks synchronous delivery failure and rethrows delivery errors", async () => {
    const events: string[] = [];
    const error = new Error("delivery failed");
    const draft: OutboundDraft = {
      draftId: "draft-2",
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      text: "control reply",
      createdAt: "2026-07-08T10:00:01.000Z",
      replyToMessageId: "message-1"
    };
    const transcriptStore = createTranscriptStore(events);
    const deliveryJobStore = createDeliveryJobStore(events);
    const qqEgress: QqEgressPort = {
      deliver: vi.fn(async (sentDraft: OutboundDraft) => {
        events.push(`deliver:${sentDraft.draftId}`);
        throw error;
      })
    };
    const service = new ControlReplyDelivery({
      transcriptStore,
      deliveryJobStore,
      qqEgress
    });

    await expect(service.deliverDraft(draft)).rejects.toThrow(error);

    expect(transcriptStore.recordOutbound).toHaveBeenCalledWith(draft);
    expect(qqEgress.deliver).toHaveBeenCalledWith(draft);
    expect(deliveryJobStore.markDelivered).not.toHaveBeenCalled();
    expect(deliveryJobStore.markAttemptFailed).toHaveBeenCalledWith({
      jobId: "draft-2",
      failedAt: expect.any(String),
      error: "delivery failed",
      maxAttempts: 1,
      retryAfterMs: 30_000
    });
    expect(events).toEqual([
      "recordOutbound:draft-2",
      "deliver:draft-2",
      "markAttemptFailed:draft-2"
    ]);
  });

  it("builds reply drafts with deterministic id, timestamp, session, text, and reply target", async () => {
    const delivery: DeliveryRecord = {
      jobId: "reply-draft-1",
      sessionKey: "qqbot:default::qq:group:GROUP123",
      providerMessageId: "provider-1",
      deliveredAt: "2026-07-08T10:00:02.000Z"
    };
    const transcriptStore = createTranscriptStore();
    const deliveryJobStore = createDeliveryJobStore();
    const qqEgress = createEgress(delivery);
    const service = new ControlReplyDelivery({
      transcriptStore,
      deliveryJobStore,
      qqEgress,
      createDraftId: () => "reply-draft-1",
      now: () => new Date("2026-07-08T10:00:01.000Z")
    });
    const message = createMessage({
      messageId: "source-message-1",
      sessionKey: "qqbot:default::qq:group:GROUP123",
      peerKey: "qq:group:GROUP123",
      chatType: "group"
    });

    await service.deliverControlReply(message, "control text");

    const expectedDraft: OutboundDraft = {
      draftId: "reply-draft-1",
      sessionKey: "qqbot:default::qq:group:GROUP123",
      text: "control text",
      createdAt: "2026-07-08T10:00:01.000Z",
      replyToMessageId: "source-message-1"
    };
    expect(transcriptStore.recordOutbound).toHaveBeenCalledWith(expectedDraft);
    expect(qqEgress.deliver).toHaveBeenCalledWith(expectedDraft);
  });
});

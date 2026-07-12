import { randomUUID } from "node:crypto";
import type { InboundMessage, OutboundDraft } from "../../../packages/domain/src/message.js";
import {
  markSynchronousDeliveryFailure,
  markSynchronousDeliveryResult
} from "../../../packages/orchestrator/src/delivery-worker.js";
import type { QqEgressPort } from "../../../packages/ports/src/qq.js";
import type {
  DeliveryJobStorePort,
  TranscriptStorePort
} from "../../../packages/ports/src/store.js";

type ControlReplyDeliveryDeps = {
  transcriptStore: TranscriptStorePort;
  qqEgress: QqEgressPort;
  deliveryJobStore?: DeliveryJobStorePort;
  createDraftId?: () => string;
  now?: () => Date;
};

export class ControlReplyDelivery {
  private readonly createDraftId: () => string;
  private readonly now: () => Date;

  constructor(private readonly deps: ControlReplyDeliveryDeps) {
    this.createDraftId = deps.createDraftId ?? randomUUID;
    this.now = deps.now ?? (() => new Date());
  }

  async deliverControlReply(message: InboundMessage, text: string): Promise<void> {
    const draft: OutboundDraft = {
      draftId: this.createDraftId(),
      sessionKey: message.sessionKey,
      text,
      createdAt: this.now().toISOString(),
      replyToMessageId: message.messageId
    };

    await this.deliverDraft(draft);
  }

  async deliverDraft(draft: OutboundDraft): Promise<void> {
    await this.deps.transcriptStore.recordOutbound(draft);
    try {
      const delivery = await this.deps.qqEgress.deliver(draft);
      await markSynchronousDeliveryResult(this.deps.deliveryJobStore, draft, delivery);
    } catch (error) {
      await markSynchronousDeliveryFailure(this.deps.deliveryJobStore, draft, error);
      throw error;
    }
  }
}

import type { OutboundDraft, TurnEvent } from "../../domain/src/message.js";
import type { QqEgressPort } from "../../ports/src/qq.js";
import type {
  DeliveryJobStorePort,
  TranscriptStorePort,
  TurnStorePort
} from "../../ports/src/store.js";
import {
  markSynchronousDeliveryFailure,
  markSynchronousDeliveryResult
} from "./delivery-worker.js";

export class TurnDeliveryCoordinator {
  constructor(
    private readonly deps: {
      transcriptStore: TranscriptStorePort;
      turnStore?: TurnStorePort;
      deliveryJobStore?: DeliveryJobStorePort;
      qqEgress: QqEgressPort;
    }
  ) {}

  async deliverBridgeTurnDraft(draft: OutboundDraft, bridgeTurnId: string): Promise<void> {
    await this.deps.transcriptStore.recordOutbound(draft);
    try {
      const delivery = await this.deps.qqEgress.deliver(draft);
      await markSynchronousDeliveryResult(
        this.deps.deliveryJobStore,
        draft,
        delivery
      );
      await this.deps.turnStore?.addDeliveredText(bridgeTurnId, draft.text.length);
    } catch (error) {
      await markSynchronousDeliveryFailure(this.deps.deliveryJobStore, draft, error);
      throw error;
    }
  }

  async deliverCodexTurnEventDraft(event: TurnEvent, draft: OutboundDraft): Promise<void> {
    await this.deps.transcriptStore.recordOutbound(draft);
    try {
      const delivery = await this.deps.qqEgress.deliver(draft);
      await markSynchronousDeliveryResult(
        this.deps.deliveryJobStore,
        draft,
        delivery
      );
      const turn = await this.deps.turnStore?.getTurnByCodexTurn(
        event.sessionKey,
        event.turnId,
        event.payload.replyToMessageId ?? null
      );
      if (turn) {
        await this.deps.turnStore?.addDeliveredText(turn.turnId, draft.text.length);
      }
    } catch (error) {
      await markSynchronousDeliveryFailure(this.deps.deliveryJobStore, draft, error);
      throw error;
    }
  }
}

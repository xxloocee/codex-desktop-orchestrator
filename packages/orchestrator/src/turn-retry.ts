import { randomUUID } from "node:crypto";
import type { InboundMessage } from "../../domain/src/message.js";
import { BridgeTurnStatus } from "../../domain/src/turn.js";
import type { TranscriptStorePort, TurnStorePort } from "../../ports/src/store.js";
import { doesTurnIdMatchRequest } from "./turn-control.js";

export type RetryTurnPreparation =
  | { status: "tracking-not-configured" }
  | { status: "task-not-found"; requestedTaskId: string }
  | { status: "task-not-retryable"; turnId: string; turnStatus: BridgeTurnStatus }
  | { status: "original-message-not-found"; turnId: string }
  | { status: "ready"; sourceTurnId: string; message: InboundMessage };

const RETRYABLE_TURN_STATUSES = new Set<BridgeTurnStatus>([
  BridgeTurnStatus.Failed,
  BridgeTurnStatus.TimedOut,
  BridgeTurnStatus.Orphaned
]);

export class TurnRetry {
  constructor(
    private readonly input: {
      turnStore?: TurnStorePort;
      transcriptStore: TranscriptStorePort;
      createMessageId?: () => string;
      now?: () => Date;
    }
  ) {}

  async prepare(
    sessionKey: string,
    requestedTaskId: string,
    replyToMessageId?: string
  ): Promise<RetryTurnPreparation> {
    if (!this.input.turnStore || !this.input.transcriptStore.getInbound) {
      return { status: "tracking-not-configured" };
    }

    const turns = await this.input.turnStore.listRecentTurns(sessionKey, 100);
    const turn = turns.find((candidate) =>
      doesTurnIdMatchRequest(candidate.turnId, requestedTaskId)
    );
    if (!turn) {
      return { status: "task-not-found", requestedTaskId };
    }
    if (!RETRYABLE_TURN_STATUSES.has(turn.status)) {
      return {
        status: "task-not-retryable",
        turnId: turn.turnId,
        turnStatus: turn.status
      };
    }

    const original = await this.input.transcriptStore.getInbound(turn.qqMessageId);
    if (!original) {
      return { status: "original-message-not-found", turnId: turn.turnId };
    }

    return {
      status: "ready",
      sourceTurnId: turn.turnId,
      message: {
        ...original,
        messageId: `retry:${this.input.createMessageId?.() ?? randomUUID()}`,
        ...(replyToMessageId ? { replyToMessageId } : {}),
        retryOfTurnId: turn.turnId,
        receivedAt: (this.input.now?.() ?? new Date()).toISOString()
      }
    };
  }
}

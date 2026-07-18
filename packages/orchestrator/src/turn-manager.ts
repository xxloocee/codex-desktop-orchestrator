import { randomUUID } from "node:crypto";
import { buildMediaArtifactFromReference } from "../../adapters/qq/src/qq-media-parser.js";
import type { DesktopDriverError } from "../../domain/src/driver.js";
import type { OutboundDraft, TurnEvent } from "../../domain/src/message.js";
import type { BridgeTurnStatus } from "../../domain/src/turn.js";
import type { TurnStorePort } from "../../ports/src/store.js";
import {
  getTurnEventBridgeStatus,
  isTerminalTurnStatus,
  readTurnEventError
} from "./turn-event-reducer.js";
import { TurnLifecycle } from "./turn-lifecycle.js";
import {
  computePendingTurnText,
  filterPendingArtifacts,
  isEmptyDraft,
  TurnOutputTracker,
  type TurnState
} from "./turn-output-tracker.js";
import { SessionTurnScheduler } from "./turn-scheduler.js";

export type TurnEventReduction = {
  status: BridgeTurnStatus;
  lastError: string | null;
  isTerminal: boolean;
};

type DraftFormatter = (draft: OutboundDraft) => OutboundDraft;

export class TurnManager {
  private readonly scheduler = new SessionTurnScheduler();
  private readonly outputTracker = new TurnOutputTracker();
  private readonly lifecycle: TurnLifecycle;

  constructor(input: { turnStore?: TurnStorePort; turnTimeoutMs?: number }) {
    this.lifecycle = new TurnLifecycle(input);
  }

  runWithSessionQueue<T>(
    sessionKey: string,
    onQueued: (() => Promise<void>) | undefined,
    work: () => Promise<T>
  ): Promise<T> {
    return this.scheduler.run(sessionKey, onQueued, work);
  }

  getOrCreateOutputState(event: TurnEvent): TurnState {
    return this.outputTracker.getOrCreate(event);
  }

  beginOutputTurn(sessionKey: string, messageId: string): void {
    this.outputTracker.beginTurn(sessionKey, messageId);
  }

  shouldIgnoreOutputEvent(event: TurnEvent): boolean {
    return this.outputTracker.shouldIgnoreEvent(event);
  }

  hasObservedTurnEvent(sessionKey: string, turnId: string): boolean {
    return this.outputTracker.hasObservedTurnEvent(sessionKey, turnId);
  }

  isLatestFinalFlushed(sessionKey: string): boolean {
    return this.outputTracker.isLatestFinalFlushed(sessionKey);
  }

  recordDeliveredDraft(draft: OutboundDraft): void {
    this.outputTracker.recordDeliveredDraft(draft);
  }

  filterAlreadyDeliveredDraft(draft: OutboundDraft): OutboundDraft {
    return this.outputTracker.filterAlreadyDeliveredDraft(draft);
  }

  reduceTurnEvent(event: TurnEvent): TurnEventReduction {
    const lastError = readTurnEventError(event);
    const status = getTurnEventBridgeStatus(event, lastError);
    return {
      status,
      lastError,
      isTerminal: isTerminalTurnStatus(status)
    };
  }

  applyEventText(event: TurnEvent, state: TurnState): void {
    if (typeof event.payload.fullText === "string") {
      state.assembledText = event.payload.fullText;
    } else if (typeof event.payload.text === "string" && event.payload.text.length > 0) {
      state.assembledText += event.payload.text;
    }
  }

  markFinalFlushed(state: TurnState): void {
    state.completed = true;
    state.finalFlushed = true;
  }

  buildFinalDraft(
    event: TurnEvent,
    state: TurnState,
    draftFormatter: DraftFormatter
  ): OutboundDraft | null {
    const pendingText = computePendingTurnText(state.sentText, state.assembledText);
    if (!pendingText && !(event.payload.mediaReferences?.length)) {
      this.markFinalFlushed(state);
      return null;
    }

    const draft = draftFormatter(buildTurnEventDraft(event, pendingText));
    const pendingArtifacts = filterPendingArtifacts(draft.mediaArtifacts ?? [], state.sentArtifactKeys);
    const normalizedDraft =
      pendingArtifacts.length === (draft.mediaArtifacts?.length ?? 0)
        ? draft
        : {
            ...draft,
            mediaArtifacts: pendingArtifacts
          };

    if (isEmptyDraft(normalizedDraft)) {
      state.sentText = state.assembledText;
      this.markFinalFlushed(state);
      return null;
    }

    return normalizedDraft;
  }

  markFinalDelivered(state: TurnState, draft: OutboundDraft): void {
    this.recordDeliveredDraft(draft);
    this.markFinalFlushed(state);
  }

  markQueued(turnId: string, options: { preserveDeadline?: boolean } = {}): Promise<void> {
    return this.lifecycle.markQueued(turnId, options);
  }

  markRunning(
    turnId: string,
    options: { preserveDeadline?: boolean } = {}
  ): Promise<void> {
    return this.lifecycle.markRunning(turnId, options);
  }

  markCompleted(turnId: string, lastError: string | null = null): Promise<void> {
    return this.lifecycle.markCompleted(turnId, lastError);
  }

  markFailed(turnId: string, lastError: string | null): Promise<void> {
    return this.lifecycle.markFailed(turnId, lastError);
  }

  markRecoverable(
    turnId: string,
    status: BridgeTurnStatus,
    lastError: string | null
  ): Promise<void> {
    return this.lifecycle.markRecoverable(turnId, status, lastError);
  }

  assertCanStart(turnId: string): Promise<void> {
    return this.lifecycle.assertCanStart(turnId);
  }

  isCancelled(turnId: string): Promise<boolean> {
    return this.lifecycle.isCancelled(turnId);
  }

  isCodexTurnCancelled(
    sessionKey: string,
    codexTurnRef: string,
    qqMessageId: string | null
  ): Promise<boolean> {
    return this.lifecycle.isCodexTurnCancelled(sessionKey, codexTurnRef, qqMessageId);
  }

  isTerminal(turnId: string): Promise<boolean> {
    return this.lifecycle.isTerminal(turnId);
  }

  shouldIgnoreCodexTurnEvent(
    sessionKey: string,
    codexTurnRef: string,
    qqMessageId: string | null
  ): Promise<boolean> {
    return this.lifecycle.shouldIgnoreCodexTurnEvent(sessionKey, codexTurnRef, qqMessageId);
  }

  runWithDeadline<T>(
    turnId: string,
    work: () => Promise<T>,
    onTimeout?: (error: DesktopDriverError) => Promise<boolean>
  ): Promise<T> {
    return this.lifecycle.runWithDeadline(turnId, work, onTimeout);
  }

  classifyRecoverableError(error: unknown): BridgeTurnStatus | null {
    return this.lifecycle.classifyRecoverableError(error);
  }

  buildRecoverableStatusText(status: BridgeTurnStatus, error: unknown): string {
    return this.lifecycle.buildRecoverableStatusText(status, error);
  }
}

function buildTurnEventDraft(event: TurnEvent, text: string): OutboundDraft {
  return {
    draftId: randomUUID(),
    turnId: event.turnId,
    sessionKey: event.sessionKey,
    text,
    ...(event.payload.mediaReferences?.length
      ? {
          mediaArtifacts: event.payload.mediaReferences.map((reference) =>
            buildMediaArtifactFromReference(reference)
          )
        }
      : {}),
    createdAt: event.createdAt,
    ...(event.payload.deliveryReplyToMessageId ?? event.payload.replyToMessageId
      ? {
          replyToMessageId:
            event.payload.deliveryReplyToMessageId ?? event.payload.replyToMessageId
        }
      : {})
  };
}

import { randomUUID } from "node:crypto";
import { BridgeSessionStatus, type BridgeSession } from "../../domain/src/session.js";
import {
  TurnEventType,
  type InboundMessage,
  type MediaArtifact,
  type OutboundDraft,
  type TurnEvent
} from "../../domain/src/message.js";
import { BridgeTurnStatus } from "../../domain/src/turn.js";
import { DesktopDriverError } from "../../domain/src/driver.js";
import type { ConversationProviderPort } from "../../ports/src/conversation.js";
import type { QqEgressPort } from "../../ports/src/qq.js";
import type {
  DeliveryJobStorePort,
  SessionStorePort,
  TranscriptStorePort,
  TurnStorePort
} from "../../ports/src/store.js";
import {
  markSynchronousDeliveryFailure,
  markSynchronousDeliveryResult
} from "./delivery-worker.js";

type BridgeOrchestratorDeps = {
  sessionStore: SessionStorePort;
  transcriptStore: TranscriptStorePort;
  turnStore?: TurnStorePort;
  deliveryJobStore?: DeliveryJobStorePort;
  conversationProvider: ConversationProviderPort;
  qqEgress: QqEgressPort;
  draftFormatter?: (draft: OutboundDraft) => OutboundDraft;
  turnTimeoutMs?: number;
};

type TurnState = {
  lastSequence: number;
  assembledText: string;
  sentText: string;
  sentArtifactKeys: Set<string>;
  lastEventAt: string | null;
  completed: boolean;
  finalFlushed: boolean;
};

export class BridgeOrchestrator {
  private readonly recentInboundFingerprints = new Map<
    string,
    Array<{ fingerprint: string; receivedAtMs: number; messageId: string }>
  >();
  private readonly turnStates = new Map<string, TurnState>();
  private readonly sessionTurnTails = new Map<string, Promise<void>>();
  private readonly draftFormatter: (draft: OutboundDraft) => OutboundDraft;
  private readonly turnTimeoutMs: number;

  constructor(private readonly deps: BridgeOrchestratorDeps) {
    this.draftFormatter = deps.draftFormatter ?? ((draft) => draft);
    this.turnTimeoutMs = deps.turnTimeoutMs ?? 10 * 60_000;
  }

  async handleInbound(message: InboundMessage): Promise<void> {
    const alreadySeen = await this.deps.transcriptStore.hasInbound(message.messageId);
    if (alreadySeen) {
      return;
    }

    let turnId: string | null = null;
    await this.deps.sessionStore.withSessionLock(message.sessionKey, async () => {
      const seenInsideLock = await this.deps.transcriptStore.hasInbound(message.messageId);
      if (seenInsideLock) {
        return;
      }

      if (this.isLikelyDuplicateInbound(message)) {
        console.warn("[codex-desktop-orchestrator] duplicate inbound suppressed", {
          messageId: message.messageId,
          sessionKey: message.sessionKey
        });
        return;
      }

      const existing = await this.deps.sessionStore.getSession(message.sessionKey);
      if (!existing) {
        const created: BridgeSession = {
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
        };

        await this.deps.sessionStore.createSession(created);
      }

      await this.deps.transcriptStore.recordInbound(message);
      this.rememberInbound(message);

      turnId = randomUUID();
      const turnStartedAt = new Date().toISOString();
      await this.deps.turnStore?.createTurn({
        turnId,
        sessionKey: message.sessionKey,
        codexThreadRef: existing?.codexThreadRef ?? null,
        qqMessageId: message.messageId,
        status: BridgeTurnStatus.Queued,
        startedAt: turnStartedAt,
        deadlineAt: null
      });
    });

    if (!turnId) {
      return;
    }
    const bridgeTurnId = turnId;

    await this.runWithSessionTurnQueue(
      message.sessionKey,
      async () => {
        await this.deps.turnStore?.updateStatus(bridgeTurnId, BridgeTurnStatus.Queued);
        await this.deps.turnStore?.updateDeadline(bridgeTurnId, null);
      },
      async () => {
        try {
          if (await this.isTurnCancelled(bridgeTurnId)) {
            throw new DesktopDriverError(
              "Bridge turn was cancelled before start",
              "turn_cancelled"
            );
          }
          await this.deps.turnStore?.updateStatus(bridgeTurnId, BridgeTurnStatus.Running);
          await this.deps.turnStore?.updateDeadline(
            bridgeTurnId,
            new Date(Date.now() + this.turnTimeoutMs).toISOString()
          );
          const deliveredDraftIds = new Set<string>();
          const deliveryErrors: string[] = [];
          let taskStartedDraftSent = false;
          const handleDraft = async (draft: OutboundDraft) => {
            if (await this.isTurnCancelled(bridgeTurnId)) {
              return;
            }
            if (deliveredDraftIds.has(draft.draftId)) {
              return;
            }
            deliveredDraftIds.add(draft.draftId);
            if (draft.turnId) {
              await this.deps.turnStore?.attachCodexTurn(bridgeTurnId, draft.turnId);
              await this.deps.turnStore?.updateStatus(bridgeTurnId, BridgeTurnStatus.Streaming);
              await this.deps.sessionStore.updateLastCodexTurnId(message.sessionKey, draft.turnId);
            }
            const formattedDraft = this.draftFormatter(draft);
            const pendingDraft = this.filterAlreadyDeliveredDraft(formattedDraft);
            if (isEmptyDraft(pendingDraft)) {
              return;
            }
            await this.deps.transcriptStore.recordOutbound(pendingDraft);
            try {
              const delivery = await this.deps.qqEgress.deliver(pendingDraft);
              await markSynchronousDeliveryResult(
                this.deps.deliveryJobStore,
                pendingDraft,
                delivery
              );
              await this.deps.turnStore?.addDeliveredText(bridgeTurnId, pendingDraft.text.length);
              this.recordDeliveredDraft(pendingDraft);
            } catch (error) {
              await markSynchronousDeliveryFailure(
                this.deps.deliveryJobStore,
                pendingDraft,
                error
              );
              const reason = error instanceof Error ? error.message : String(error);
              deliveryErrors.push(`${pendingDraft.draftId}: ${reason}`);
              console.warn("[codex-desktop-orchestrator] draft delivery failed", {
                sessionKey: message.sessionKey,
                messageId: message.messageId,
                draftId: pendingDraft.draftId,
                error: reason
              });
            }
          };
          const deliverTaskStarted = async () => {
            if (taskStartedDraftSent) {
              return;
            }
            taskStartedDraftSent = true;
            await handleDraft({
              draftId: `task-started:${message.messageId}`,
              sessionKey: message.sessionKey,
              text: "任务已开始。",
              createdAt: new Date().toISOString(),
              replyToMessageId: message.messageId
            });
          };

          const drafts = await this.deps.conversationProvider.runTurn(message, {
            onQueued: async () => {
              await this.deps.turnStore?.updateStatus(bridgeTurnId, BridgeTurnStatus.Queued);
              await this.deps.turnStore?.updateDeadline(bridgeTurnId, null);
            },
            onStarted: async () => {
              if (await this.isTurnCancelled(bridgeTurnId)) {
                throw new DesktopDriverError(
                  "Bridge turn was cancelled before start",
                  "turn_cancelled"
                );
              }
              await this.deps.turnStore?.updateStatus(bridgeTurnId, BridgeTurnStatus.Running);
              await this.deps.turnStore?.updateDeadline(
                bridgeTurnId,
                new Date(Date.now() + this.turnTimeoutMs).toISOString()
              );
              await deliverTaskStarted();
            },
            onThreadBound: async (codexThreadRef) => {
              await this.deps.turnStore?.updateCodexThreadRef(bridgeTurnId, codexThreadRef);
            },
            onDraft: handleDraft
          });

          for (const draft of drafts) {
            await handleDraft(draft);
          }

          await this.deps.sessionStore.updateSessionStatus(
            message.sessionKey,
            BridgeSessionStatus.Active,
            deliveryErrors.length > 0 ? deliveryErrors.at(-1) ?? null : null
          );
          if (await this.isTurnCancelled(bridgeTurnId)) {
            return;
          }
          await this.deps.turnStore?.updateStatus(
            bridgeTurnId,
            BridgeTurnStatus.Completed,
            deliveryErrors.length > 0 ? deliveryErrors.at(-1) ?? null : null
          );
        } catch (error) {
          const lastError = error instanceof Error ? error.message : String(error);
          if (error instanceof DesktopDriverError && error.reason === "service_error") {
            await this.deps.turnStore?.updateStatus(bridgeTurnId, BridgeTurnStatus.Failed, lastError);
            await this.deps.sessionStore.updateSessionStatus(
              message.sessionKey,
              BridgeSessionStatus.Active,
              lastError
            );
            throw error;
          }

          const recoverableStatus = getRecoverableTurnStatus(error);
          if (recoverableStatus) {
            await this.deps.turnStore?.updateStatus(bridgeTurnId, recoverableStatus, lastError);
            await this.deps.sessionStore.updateSessionStatus(
              message.sessionKey,
              BridgeSessionStatus.Active,
              lastError
            );
            console.warn("[codex-desktop-orchestrator] recoverable turn error", {
              messageId: message.messageId,
              sessionKey: message.sessionKey,
              error: lastError
            });
            return;
          }

          await this.deps.turnStore?.updateStatus(bridgeTurnId, BridgeTurnStatus.Failed, lastError);
          await this.deps.sessionStore.updateSessionStatus(
            message.sessionKey,
            BridgeSessionStatus.NeedsRebind,
            lastError
          );
          throw error;
        }
      }
    );
  }

  async handleTurnEvent(event: TurnEvent): Promise<void> {
    await this.deps.sessionStore.withSessionLock(event.sessionKey, async () => {
      const state = this.getOrCreateTurnState(event);
      if (event.sequence <= state.lastSequence) {
        return;
      }

      if (
        await this.isCodexTurnCancelled(
          event.sessionKey,
          event.turnId,
          event.payload.replyToMessageId ?? null
        )
      ) {
        return;
      }

      const lastError = readTurnEventError(event);
      const eventStatus = getTurnEventBridgeStatus(event, lastError);

      await this.deps.sessionStore.updateLastCodexTurnId(event.sessionKey, event.turnId);
      await this.deps.turnStore?.recordTurnEvent({
        sessionKey: event.sessionKey,
        codexTurnRef: event.turnId,
        qqMessageId: event.payload.replyToMessageId ?? null,
        status: eventStatus,
        eventAt: event.createdAt,
        lastToolName: event.payload.toolName ?? null,
        lastError
      });

      state.lastSequence = event.sequence;
      state.lastEventAt = event.createdAt;
      if (isTerminalTurnStatus(eventStatus) && eventStatus !== BridgeTurnStatus.Completed) {
        state.completed = true;
        state.finalFlushed = true;
        return;
      }

      if (typeof event.payload.fullText === "string") {
        state.assembledText = event.payload.fullText;
      } else if (typeof event.payload.text === "string" && event.payload.text.length > 0) {
        state.assembledText += event.payload.text;
      }

      if (event.eventType !== TurnEventType.Completed) {
        return;
      }

      const pendingText = computePendingTurnText(state.sentText, state.assembledText);
      if (!pendingText) {
        state.completed = true;
        state.finalFlushed = true;
        return;
      }

      const draft = this.draftFormatter({
        draftId: randomUUID(),
        turnId: event.turnId,
        sessionKey: event.sessionKey,
        text: pendingText,
        createdAt: event.createdAt,
        ...(event.payload.replyToMessageId
          ? { replyToMessageId: event.payload.replyToMessageId }
          : {})
      });

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
        state.completed = true;
        state.finalFlushed = true;
        return;
      }

      await this.deps.transcriptStore.recordOutbound(normalizedDraft);
      try {
        const delivery = await this.deps.qqEgress.deliver(normalizedDraft);
        await markSynchronousDeliveryResult(
          this.deps.deliveryJobStore,
          normalizedDraft,
          delivery
        );
      } catch (error) {
        await markSynchronousDeliveryFailure(this.deps.deliveryJobStore, normalizedDraft, error);
        throw error;
      }
      this.recordDeliveredDraft(normalizedDraft);
      state.sentText = state.assembledText;
      state.completed = true;
      state.finalFlushed = true;
    });
  }

  private isLikelyDuplicateInbound(message: InboundMessage): boolean {
    const receivedAtMs = Date.parse(message.receivedAt);
    if (!Number.isFinite(receivedAtMs)) {
      return false;
    }

    const records = this.getRecentInboundRecords(message.sessionKey, receivedAtMs);
    if (!records.length) {
      return false;
    }

    const fingerprint = buildInboundFingerprint(message);
    return records.some(
      (record) =>
        record.fingerprint === fingerprint
        && receivedAtMs - record.receivedAtMs >= 0
        && receivedAtMs - record.receivedAtMs <= 90_000
    );
  }

  private rememberInbound(message: InboundMessage): void {
    const receivedAtMs = Date.parse(message.receivedAt);
    if (!Number.isFinite(receivedAtMs)) {
      return;
    }

    const records = this.getRecentInboundRecords(message.sessionKey, receivedAtMs);
    records.push({
      fingerprint: buildInboundFingerprint(message),
      receivedAtMs,
      messageId: message.messageId
    });
    this.recentInboundFingerprints.set(message.sessionKey, records);
  }

  private getRecentInboundRecords(
    sessionKey: string,
    referenceTimeMs: number
  ): Array<{ fingerprint: string; receivedAtMs: number; messageId: string }> {
    for (const [key, records] of this.recentInboundFingerprints.entries()) {
      const retained = records.filter((record) => referenceTimeMs - record.receivedAtMs <= 120_000);
      if (retained.length > 0) {
        this.recentInboundFingerprints.set(key, retained);
      } else {
        this.recentInboundFingerprints.delete(key);
      }
    }

    return [...(this.recentInboundFingerprints.get(sessionKey) ?? [])];
  }

  private getOrCreateTurnState(event: TurnEvent): TurnState {
    const key = buildTurnStateKey(event.sessionKey, event.turnId);
    const existing = this.turnStates.get(key);
    if (existing) {
      return existing;
    }

    const created: TurnState = {
      lastSequence: 0,
      assembledText: "",
      sentText: "",
      sentArtifactKeys: new Set<string>(),
      lastEventAt: null,
      completed: false,
      finalFlushed: false
    };
    this.turnStates.set(key, created);
    return created;
  }

  private recordDeliveredDraft(draft: OutboundDraft): void {
    if (!draft.turnId) {
      return;
    }

    const key = buildTurnStateKey(draft.sessionKey, draft.turnId);
    const state = this.turnStates.get(key) ?? {
      lastSequence: 0,
      assembledText: "",
      sentText: "",
      sentArtifactKeys: new Set<string>(),
      lastEventAt: null,
      completed: false,
      finalFlushed: false
    };
    state.sentText += draft.text;
    for (const artifact of draft.mediaArtifacts ?? []) {
      state.sentArtifactKeys.add(buildArtifactKey(artifact));
    }
    this.turnStates.set(key, state);
  }

  private filterAlreadyDeliveredDraft(draft: OutboundDraft): OutboundDraft {
    if (!draft.turnId) {
      return draft;
    }

    const state = this.turnStates.get(buildTurnStateKey(draft.sessionKey, draft.turnId));
    if (!state?.finalFlushed) {
      return draft;
    }

    const pendingText = computePendingTurnText(state.sentText, draft.text);
    const pendingArtifacts = filterPendingArtifacts(draft.mediaArtifacts ?? [], state.sentArtifactKeys);
    if (
      pendingText === draft.text
      && pendingArtifacts.length === (draft.mediaArtifacts?.length ?? 0)
    ) {
      return draft;
    }

    return {
      ...draft,
      text: pendingText,
      mediaArtifacts: pendingArtifacts
    };
  }

  private async isTurnCancelled(turnId: string): Promise<boolean> {
    const turn = await this.deps.turnStore?.getTurn(turnId);
    return turn?.status === BridgeTurnStatus.Cancelled;
  }

  private async isCodexTurnCancelled(
    sessionKey: string,
    codexTurnRef: string,
    qqMessageId: string | null
  ): Promise<boolean> {
    const turn = await this.deps.turnStore?.getTurnByCodexTurn(
      sessionKey,
      codexTurnRef,
      qqMessageId
    );
    return turn?.status === BridgeTurnStatus.Cancelled;
  }

  private async runWithSessionTurnQueue<T>(
    sessionKey: string,
    onQueued: (() => Promise<void>) | undefined,
    work: () => Promise<T>
  ): Promise<T> {
    const isQueued = this.sessionTurnTails.has(sessionKey);
    const previousTail = this.sessionTurnTails.get(sessionKey) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const currentTail = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const queuedTail = previousTail.then(() => currentTail, () => currentTail);

    this.sessionTurnTails.set(sessionKey, queuedTail);
    if (isQueued) {
      try {
        await onQueued?.();
      } catch (error) {
        console.warn("[codex-desktop-orchestrator] session queue notice failed", {
          sessionKey,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    await previousTail;
    try {
      return await work();
    } finally {
      releaseCurrent();
      if (this.sessionTurnTails.get(sessionKey) === queuedTail) {
        this.sessionTurnTails.delete(sessionKey);
      }
    }
  }
}

function getRecoverableTurnStatus(error: unknown): BridgeTurnStatus | null {
  if (!(error instanceof DesktopDriverError)) {
    return null;
  }

  if (error.reason === "reply_timeout") {
    return BridgeTurnStatus.TimedOut;
  }

  if (error.reason === "turn_cancelled") {
    return BridgeTurnStatus.Cancelled;
  }

  return null;
}

function readTurnEventError(event: TurnEvent): string | null {
  const status = event.payload.status?.trim();
  if (!status || event.eventType !== TurnEventType.Completed) {
    return null;
  }

  return status;
}

function getTurnEventBridgeStatus(event: TurnEvent, lastError: string | null): BridgeTurnStatus {
  if (event.payload.toolStatus === "silence-timeout") {
    return BridgeTurnStatus.TimedOut;
  }

  if (event.eventType === TurnEventType.Status && event.payload.toolStatus) {
    return BridgeTurnStatus.ToolRunning;
  }

  if (event.eventType !== TurnEventType.Completed) {
    return BridgeTurnStatus.Streaming;
  }

  if (!lastError) {
    return BridgeTurnStatus.Completed;
  }

  if (/cancel|abort|interrupt/i.test(lastError)) {
    return BridgeTurnStatus.Cancelled;
  }

  if (/timeout/i.test(lastError)) {
    return BridgeTurnStatus.TimedOut;
  }

  return BridgeTurnStatus.Failed;
}

function isTerminalTurnStatus(status: BridgeTurnStatus): boolean {
  return (
    status === BridgeTurnStatus.Completed
    || status === BridgeTurnStatus.Failed
    || status === BridgeTurnStatus.TimedOut
    || status === BridgeTurnStatus.Cancelled
  );
}

function buildInboundFingerprint(message: InboundMessage): string {
  const mediaFingerprint = (message.mediaArtifacts ?? [])
    .map((artifact) =>
      [
        artifact.kind,
        artifact.localPath || "",
        artifact.sourceUrl || "",
        artifact.originalName || ""
      ].join("::")
    )
    .join("|");

  return [
    message.accountKey,
    message.sessionKey,
    message.senderId,
    message.chatType,
    message.text.trim(),
    mediaFingerprint
  ].join("||");
}

function buildTurnStateKey(sessionKey: string, turnId: string): string {
  return `${sessionKey}::${turnId}`;
}

function computePendingTurnText(sentText: string, fullText: string): string {
  if (!fullText) {
    return "";
  }

  if (!sentText) {
    return fullText;
  }

  if (fullText.startsWith(sentText)) {
    return fullText.slice(sentText.length);
  }

  if (stripWhitespace(fullText) === stripWhitespace(sentText)) {
    return "";
  }

  const overlap = findSuffixPrefixOverlap(sentText, fullText);
  if (overlap > 0) {
    return fullText.slice(overlap);
  }

  return fullText;
}

function findSuffixPrefixOverlap(previous: string, next: string): number {
  const maxLength = Math.min(previous.length, next.length);
  for (let length = maxLength; length > 0; length -= 1) {
    if (previous.slice(-length) === next.slice(0, length)) {
      return length;
    }
  }

  return 0;
}

function stripWhitespace(value: string): string {
  return value.replace(/\s+/g, "");
}

function filterPendingArtifacts(
  artifacts: MediaArtifact[],
  sentArtifactKeys: Set<string>
): MediaArtifact[] {
  return artifacts.filter((artifact) => !sentArtifactKeys.has(buildArtifactKey(artifact)));
}

function buildArtifactKey(artifact: MediaArtifact): string {
  return [
    artifact.kind,
    artifact.localPath || "",
    artifact.sourceUrl || "",
    artifact.originalName || ""
  ].join("::");
}

function isEmptyDraft(draft: OutboundDraft): boolean {
  return !draft.text.trim() && !(draft.mediaArtifacts?.length);
}

import { randomUUID } from "node:crypto";
import { BridgeSessionStatus, type BridgeSession } from "../../domain/src/session.js";
import {
  TurnEventType,
  type InboundMessage,
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
  isEmptyDraft
} from "./turn-output-tracker.js";
import { TurnManager } from "./turn-manager.js";
import { TurnDeliveryCoordinator } from "./turn-delivery-coordinator.js";

type BridgeOrchestratorDeps = {
  sessionStore: SessionStorePort;
  transcriptStore: TranscriptStorePort;
  turnStore?: TurnStorePort;
  deliveryJobStore?: DeliveryJobStorePort;
  conversationProvider: ConversationProviderPort;
  qqEgress: QqEgressPort;
  draftFormatter?: (draft: OutboundDraft) => OutboundDraft;
  turnHeartbeatIntervalMs?: number;
  turnTimeoutMs?: number;
  interruptTurn?: (sessionKey: string) => Promise<boolean>;
};

const DEFAULT_TURN_HEARTBEAT_INTERVAL_MS = 5 * 60_000;

export class BridgeOrchestrator {
  private readonly recentInboundFingerprints = new Map<
    string,
    Array<{ fingerprint: string; receivedAtMs: number; messageId: string }>
  >();
  private readonly turnManager: TurnManager;
  private readonly turnDeliveryCoordinator: TurnDeliveryCoordinator;
  private readonly draftFormatter: (draft: OutboundDraft) => OutboundDraft;
  private readonly turnHeartbeatIntervalMs: number;

  constructor(private readonly deps: BridgeOrchestratorDeps) {
    this.turnManager = new TurnManager({
      turnStore: deps.turnStore,
      turnTimeoutMs: deps.turnTimeoutMs
    });
    this.turnDeliveryCoordinator = new TurnDeliveryCoordinator({
      transcriptStore: deps.transcriptStore,
      turnStore: deps.turnStore,
      deliveryJobStore: deps.deliveryJobStore,
      qqEgress: deps.qqEgress
    });
    this.draftFormatter = deps.draftFormatter ?? ((draft) => draft);
    this.turnHeartbeatIntervalMs =
      deps.turnHeartbeatIntervalMs ?? DEFAULT_TURN_HEARTBEAT_INTERVAL_MS;
  }

  async handleInbound(message: InboundMessage): Promise<void> {
    const deliveryReplyToMessageId = message.replyToMessageId ?? message.messageId;
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
        await this.turnManager.markQueued(bridgeTurnId);
      },
      async () => {
        let deliverFinalStatusDraft: ((text: string) => Promise<void>) | null = null;
        let stopTurnHeartbeat: (() => Promise<void>) | null = null;
        let turnCallbacksClosed = false;
        let hardTimeoutError: DesktopDriverError | null = null;
        try {
          this.turnManager.beginOutputTurn(message.sessionKey, message.messageId);
          await this.turnManager.markRunning(bridgeTurnId);
          const deliveredDraftIds = new Set<string>();
          const deliveryErrors: string[] = [];
          let taskStartedDraftSent = false;
          let heartbeatStarted = false;
          let heartbeatClosed = false;
          let heartbeatTimer: NodeJS.Timeout | null = null;
          let heartbeatInFlight: Promise<void> | null = null;
          const handleDraft = async (
            draft: OutboundDraft,
            options: { allowTerminal?: boolean; ignoreClosed?: boolean } = {}
          ) => {
            if (!options.ignoreClosed && turnCallbacksClosed) {
              return;
            }
            if (await this.turnManager.isTerminal(bridgeTurnId)) {
              if (!options.allowTerminal || await this.turnManager.isCancelled(bridgeTurnId)) {
                return;
              }
            }
            if (deliveredDraftIds.has(draft.draftId)) {
              return;
            }
            deliveredDraftIds.add(draft.draftId);
            if (draft.turnId) {
              if (this.deps.turnStore?.markStreamingIfActive) {
                const streaming = await this.deps.turnStore.markStreamingIfActive(
                  bridgeTurnId,
                  draft.turnId,
                  draft.createdAt
                );
                if (!streaming) {
                  return;
                }
              } else {
                await this.deps.turnStore?.attachCodexTurn(bridgeTurnId, draft.turnId);
                await this.deps.turnStore?.updateStatus(bridgeTurnId, BridgeTurnStatus.Streaming);
              }
              await this.deps.sessionStore.updateLastCodexTurnId(message.sessionKey, draft.turnId);
            }
            const formattedDraft = this.draftFormatter(draft);
            const pendingDraft = this.turnManager.filterAlreadyDeliveredDraft(formattedDraft);
            if (isEmptyDraft(pendingDraft)) {
              return;
            }
            try {
              await this.turnDeliveryCoordinator.deliverBridgeTurnDraft(pendingDraft, bridgeTurnId);
              this.turnManager.recordDeliveredDraft(pendingDraft);
            } catch (error) {
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
          const handleProviderDraft = async (draft: OutboundDraft) => {
            if (
              draft.turnId
              && this.turnManager.hasObservedTurnEvent(draft.sessionKey, draft.turnId)
            ) {
              return;
            }
            await handleDraft(draft);
          };
          const deliverStatusDraft = async (
            draftId: string,
            text: string,
            options: { allowTerminal?: boolean } = {}
          ) => {
            await handleDraft({
              draftId,
              sessionKey: message.sessionKey,
              text,
              createdAt: new Date().toISOString(),
              replyToMessageId: deliveryReplyToMessageId
            }, { ...options, ignoreClosed: true });
          };
          deliverFinalStatusDraft = async (text: string) => {
            await deliverStatusDraft(
              `task-ended:${message.messageId}`,
              text,
              { allowTerminal: true }
            );
          };
          const startHeartbeat = () => {
            if (heartbeatStarted || this.turnHeartbeatIntervalMs <= 0) {
              return;
            }
            heartbeatStarted = true;
            heartbeatTimer = setTimeout(() => {
              heartbeatTimer = null;
              heartbeatInFlight = this.deps.sessionStore.withSessionLock(message.sessionKey, async () => {
                if (
                  heartbeatClosed
                  || this.turnManager.isLatestFinalFlushed(message.sessionKey)
                ) {
                  return;
                }
                await deliverStatusDraft(
                  `task-heartbeat:${message.messageId}`,
                  "任务仍在运行，完成后会一次性回复。"
                );
              }).catch((error) => {
                console.warn("[codex-desktop-orchestrator] task heartbeat failed", {
                  messageId: message.messageId,
                  sessionKey: message.sessionKey,
                  error: error instanceof Error ? error.message : String(error)
                });
              });
            }, this.turnHeartbeatIntervalMs);
          };
          stopTurnHeartbeat = async () => {
            heartbeatClosed = true;
            if (heartbeatTimer) {
              clearTimeout(heartbeatTimer);
              heartbeatTimer = null;
            }
            await heartbeatInFlight;
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
              replyToMessageId: deliveryReplyToMessageId
            });
          };

          const drafts = await this.turnManager.runWithDeadline(
            bridgeTurnId,
            () => this.deps.conversationProvider.runTurn(message, {
              onQueued: async () => {
                if (turnCallbacksClosed || await this.turnManager.isTerminal(bridgeTurnId)) {
                  return;
                }
                await this.turnManager.markQueued(bridgeTurnId, { preserveDeadline: true });
              },
              onStarted: async () => {
                if (hardTimeoutError) {
                  throw hardTimeoutError;
                }
                if (turnCallbacksClosed) {
                  return;
                }
                await this.turnManager.markRunning(
                  bridgeTurnId,
                  { preserveDeadline: true }
                );
                await deliverTaskStarted();
                startHeartbeat();
              },
              onThreadBound: async (codexThreadRef) => {
                if (turnCallbacksClosed || await this.turnManager.isTerminal(bridgeTurnId)) {
                  return;
                }
                await this.deps.turnStore?.updateCodexThreadRef(bridgeTurnId, codexThreadRef);
              },
              onDraft: handleProviderDraft
            }),
            async (error) => {
              hardTimeoutError = error;
              turnCallbacksClosed = true;
              try {
                return await this.deps.interruptTurn?.(message.sessionKey) ?? false;
              } catch (interruptError) {
                console.warn("[codex-desktop-orchestrator] hard timeout interrupt failed", {
                  messageId: message.messageId,
                  sessionKey: message.sessionKey,
                  error: interruptError instanceof Error
                    ? interruptError.message
                    : String(interruptError)
                });
                return false;
              }
            }
          );

          for (const draft of drafts) {
            await handleDraft(draft);
          }

          await stopTurnHeartbeat?.();
          await this.deps.sessionStore.updateSessionStatus(
            message.sessionKey,
            BridgeSessionStatus.Active,
            deliveryErrors.length > 0 ? deliveryErrors.at(-1) ?? null : null
          );
          if (await this.turnManager.isCancelled(bridgeTurnId)) {
            return;
          }
          await this.turnManager.markCompleted(
            bridgeTurnId,
            deliveryErrors.length > 0 ? deliveryErrors.at(-1) ?? null : null
          );
        } catch (error) {
          turnCallbacksClosed = true;
          await stopTurnHeartbeat?.();
          const lastError = error instanceof Error ? error.message : String(error);
          if (error instanceof DesktopDriverError && error.reason === "service_error") {
            await this.turnManager.markFailed(bridgeTurnId, lastError);
            await this.deps.sessionStore.updateSessionStatus(
              message.sessionKey,
              BridgeSessionStatus.Active,
              lastError
            );
            throw error;
          }

          const recoverableStatus = this.turnManager.classifyRecoverableError(error);
          if (recoverableStatus) {
            await deliverFinalStatusDraft?.(
              this.turnManager.buildRecoverableStatusText(recoverableStatus, error)
            );
            await this.turnManager.markRecoverable(bridgeTurnId, recoverableStatus, lastError);
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

          await this.turnManager.markFailed(bridgeTurnId, lastError);
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
      if (
        this.turnManager.shouldIgnoreOutputEvent(event)
        || await this.turnManager.shouldIgnoreCodexTurnEvent(
          event.sessionKey,
          event.turnId,
          event.payload.replyToMessageId ?? null
        )
      ) {
        return;
      }

      const state = this.turnManager.getOrCreateOutputState(event);
      if (event.sequence <= state.lastSequence) {
        return;
      }

      const eventReduction = this.turnManager.reduceTurnEvent(event);

      await this.deps.sessionStore.updateLastCodexTurnId(event.sessionKey, event.turnId);
      await this.deps.turnStore?.recordTurnEvent({
        sessionKey: event.sessionKey,
        codexTurnRef: event.turnId,
        qqMessageId: event.payload.replyToMessageId ?? null,
        status: eventReduction.status,
        eventAt: event.createdAt,
        eventType: event.eventType,
        lastToolName: event.payload.toolName ?? null,
        toolStatus: event.payload.toolStatus ?? null,
        summary: event.payload.summary ?? null,
        lastError: eventReduction.lastError
      });

      state.lastSequence = event.sequence;
      state.lastEventAt = event.createdAt;
      if (eventReduction.isTerminal && eventReduction.status !== BridgeTurnStatus.Completed) {
        this.turnManager.markFinalFlushed(state);
        return;
      }

      this.turnManager.applyEventText(event, state);

      if (event.eventType === TurnEventType.Delta) {
        return;
      }

      if (event.eventType !== TurnEventType.Completed) {
        return;
      }

      const draft = this.turnManager.buildFinalDraft(event, state, this.draftFormatter);
      if (!draft) {
        return;
      }

      await this.turnDeliveryCoordinator.deliverCodexTurnEventDraft(event, draft);
      this.turnManager.markFinalDelivered(state, draft);
    });
  }

  private isLikelyDuplicateInbound(message: InboundMessage): boolean {
    if (message.retryOfTurnId) {
      return false;
    }

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
    if (message.retryOfTurnId) {
      return;
    }

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

  private async runWithSessionTurnQueue<T>(
    sessionKey: string,
    onQueued: (() => Promise<void>) | undefined,
    work: () => Promise<T>
  ): Promise<T> {
    return this.turnManager.runWithSessionQueue(sessionKey, onQueued, work);
  }

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

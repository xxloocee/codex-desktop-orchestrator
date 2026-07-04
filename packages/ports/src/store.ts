import type { BridgeSession, BridgeSessionStatus, ConversationProviderKind } from "../../domain/src/session.js";
import type {
  ConversationEntry,
  DeliveryJobRecord,
  DeliveryJobStatus,
  InboundMessage,
  OutboundDraft
} from "../../domain/src/message.js";
import type { BridgeTurnRecord, BridgeTurnStatus, CreateBridgeTurn } from "../../domain/src/turn.js";

export interface SessionStorePort {
  getSession(sessionKey: string): Promise<BridgeSession | null>;
  createSession(session: BridgeSession): Promise<void>;
  updateSessionStatus(
    sessionKey: string,
    status: BridgeSessionStatus,
    lastError?: string | null
  ): Promise<void>;
  updateBinding(sessionKey: string, codexThreadRef: string | null): Promise<void>;
  updateLastCodexTurnId(sessionKey: string, lastCodexTurnId: string | null): Promise<void>;
  updateSkillContextKey(sessionKey: string, skillContextKey: string | null): Promise<void>;
  updateConversationProvider(sessionKey: string, provider: ConversationProviderKind | null): Promise<void>;
  withSessionLock<T>(sessionKey: string, work: () => Promise<T>): Promise<T>;
}

export interface TranscriptStorePort {
  recordInbound(message: InboundMessage): Promise<void>;
  recordOutbound(draft: OutboundDraft): Promise<void>;
  hasInbound(messageId: string): Promise<boolean>;
  listRecentConversation(sessionKey: string, limit: number): Promise<ConversationEntry[]>;
}

export interface TurnStorePort {
  createTurn(turn: CreateBridgeTurn): Promise<void>;
  attachCodexTurn(turnId: string, codexTurnRef: string): Promise<void>;
  updateCodexThreadRef(turnId: string, codexThreadRef: string | null): Promise<void>;
  updateStatus(
    turnId: string,
    status: BridgeTurnStatus,
    lastError?: string | null,
    updatedAt?: string
  ): Promise<void>;
  updateDeadline(turnId: string, deadlineAt: string | null): Promise<void>;
  recordTurnEvent(input: {
    sessionKey: string;
    codexTurnRef: string;
    qqMessageId?: string | null;
    status: BridgeTurnStatus;
    eventAt: string;
    lastToolName?: string | null;
    lastError?: string | null;
  }): Promise<void>;
  addDeliveredText(turnId: string, textLength: number): Promise<void>;
  getCurrentTurn(sessionKey: string): Promise<BridgeTurnRecord | null>;
  getTurn(turnId: string): Promise<BridgeTurnRecord | null>;
  getTurnByCodexTurn(
    sessionKey: string,
    codexTurnRef: string,
    qqMessageId?: string | null
  ): Promise<BridgeTurnRecord | null>;
  listRecentTurns(sessionKey: string, limit: number): Promise<BridgeTurnRecord[]>;
}

export interface ThreadLockStorePort {
  withThreadLock<T>(
    threadRef: string,
    work: () => Promise<T>,
    options?: { onQueued?: () => Promise<void> }
  ): Promise<T>;
}

export interface DeliveryJobStorePort {
  claimDueJobs(input: {
    limit: number;
    now: string;
  }): Promise<DeliveryJobRecord[]>;
  markDelivered(input: {
    jobId: string;
    deliveredAt: string;
    providerMessageId?: string | null;
  }): Promise<void>;
  markAttemptFailed(input: {
    jobId: string;
    failedAt: string;
    error: string;
    maxAttempts: number;
    retryAfterMs: number;
  }): Promise<void>;
  recoverInFlight(now: string): Promise<number>;
  listJobs(input: {
    sessionKey: string;
    statuses?: DeliveryJobStatus[];
    limit: number;
  }): Promise<DeliveryJobRecord[]>;
}

import type { ToolEventStatus, TurnEventType } from "./message.js";

export enum BridgeTurnStatus {
  Queued = "queued",
  Running = "running",
  ToolRunning = "tool-running",
  Streaming = "streaming",
  Completed = "completed",
  Failed = "failed",
  TimedOut = "timed-out",
  Cancelled = "cancelled",
  Orphaned = "orphaned"
}

export const ACTIVE_BRIDGE_TURN_STATUSES = [
  BridgeTurnStatus.Queued,
  BridgeTurnStatus.Running,
  BridgeTurnStatus.ToolRunning,
  BridgeTurnStatus.Streaming
] as const;

export type BridgeTurnRecord = {
  turnId: string;
  sessionKey: string;
  codexThreadRef: string | null;
  codexTurnRef: string | null;
  qqMessageId: string;
  status: BridgeTurnStatus;
  startedAt: string;
  updatedAt: string;
  deadlineAt: string | null;
  lastEventAt: string | null;
  lastToolName: string | null;
  lastError: string | null;
  deliveredTextLength: number;
};

export type CreateBridgeTurn = {
  turnId: string;
  sessionKey: string;
  codexThreadRef: string | null;
  qqMessageId: string;
  status: BridgeTurnStatus;
  startedAt: string;
  deadlineAt?: string | null;
};

export type BridgeTurnEventRecord = {
  eventId: number;
  turnId: string;
  eventType: TurnEventType;
  status: BridgeTurnStatus;
  eventAt: string;
  toolName: string | null;
  toolStatus: ToolEventStatus | null;
  summary: string | null;
  error: string | null;
};

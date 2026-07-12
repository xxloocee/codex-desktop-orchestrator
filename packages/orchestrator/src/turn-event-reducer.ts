import { TurnEventType, type TurnEvent } from "../../domain/src/message.js";
import { BridgeTurnStatus } from "../../domain/src/turn.js";

export function readTurnEventError(event: TurnEvent): string | null {
  const status = event.payload.status?.trim();
  if (!status || event.eventType !== TurnEventType.Completed) {
    return null;
  }

  return status;
}

export function getTurnEventBridgeStatus(event: TurnEvent, lastError: string | null): BridgeTurnStatus {
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

export function isTerminalTurnStatus(status: BridgeTurnStatus): boolean {
  return (
    status === BridgeTurnStatus.Completed
    || status === BridgeTurnStatus.Failed
    || status === BridgeTurnStatus.TimedOut
    || status === BridgeTurnStatus.Cancelled
  );
}

import { BridgeTurnStatus } from "../../domain/src/turn.js";
import type { DesktopDriverPort } from "../../ports/src/conversation.js";
import type { TurnStorePort } from "../../ports/src/store.js";

export type CancelCurrentTurnResult =
  | { status: "tracking-not-configured" }
  | { status: "no-active-turn" }
  | { status: "task-mismatch"; requestedTaskId: string; currentTurnId: string }
  | { status: "interrupt-failed"; turnId: string; error: string }
  | { status: "cancelled"; turnId: string; interrupted: boolean };

export class TurnControl {
  constructor(
    private readonly input: {
      turnStore?: TurnStorePort;
      desktopDriver: Pick<DesktopDriverPort, "interruptActiveTurn">;
    }
  ) {}

  async cancelCurrentTurn(
    sessionKey: string,
    requestedTaskId: string | null = null
  ): Promise<CancelCurrentTurnResult> {
    if (!this.input.turnStore) {
      return { status: "tracking-not-configured" };
    }

    const current = await this.input.turnStore.getCurrentTurn(sessionKey);
    if (!current) {
      return { status: "no-active-turn" };
    }

    if (requestedTaskId && !doesTurnIdMatchRequest(current.turnId, requestedTaskId)) {
      return {
        status: "task-mismatch",
        requestedTaskId,
        currentTurnId: current.turnId
      };
    }

    let interrupted = false;
    if (this.input.desktopDriver.interruptActiveTurn) {
      try {
        interrupted = await this.input.desktopDriver.interruptActiveTurn(sessionKey);
      } catch (error) {
        const interruptError = error instanceof Error ? error.message : String(error);
        return {
          status: "interrupt-failed",
          turnId: current.turnId,
          error: interruptError
        };
      }
    }

    if (this.input.turnStore.markTerminalIfActive) {
      const cancelled = await this.input.turnStore.markTerminalIfActive(
        current.turnId,
        BridgeTurnStatus.Cancelled,
        null
      );
      if (!cancelled) {
        const terminal = await this.input.turnStore.getTurn(current.turnId);
        if (terminal?.status === BridgeTurnStatus.Cancelled) {
          return {
            status: "cancelled",
            turnId: current.turnId,
            interrupted
          };
        }
        return { status: "no-active-turn" };
      }
    } else {
      await this.input.turnStore.updateStatus(current.turnId, BridgeTurnStatus.Cancelled, null);
    }
    return {
      status: "cancelled",
      turnId: current.turnId,
      interrupted
    };
  }
}

export function doesTurnIdMatchRequest(turnId: string, requested: string): boolean {
  if (turnId === requested || turnId.startsWith(requested)) {
    return true;
  }

  const compactMatch = requested.match(/^(.+)\.\.\.(.+)$/);
  return Boolean(
    compactMatch
    && turnId.startsWith(compactMatch[1])
    && turnId.endsWith(compactMatch[2])
  );
}

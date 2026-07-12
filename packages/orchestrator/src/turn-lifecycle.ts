import { DesktopDriverError } from "../../domain/src/driver.js";
import {
  ACTIVE_BRIDGE_TURN_STATUSES,
  BridgeTurnStatus
} from "../../domain/src/turn.js";
import type { TurnStorePort } from "../../ports/src/store.js";

export class TurnLifecycle {
  constructor(
    private readonly input: {
      turnStore?: TurnStorePort;
      turnTimeoutMs?: number;
    }
  ) {}

  async markQueued(turnId: string, options: { preserveDeadline?: boolean } = {}): Promise<void> {
    if (this.input.turnStore?.markQueuedIfActive) {
      const queued = await this.input.turnStore.markQueuedIfActive(
        turnId,
        options.preserveDeadline
      );
      if (!queued) {
        throw new DesktopDriverError(
          "Bridge turn was cancelled before queue update",
          "turn_cancelled"
        );
      }
      return;
    }

    await this.assertCanStart(turnId);
    await this.input.turnStore?.updateStatus(turnId, BridgeTurnStatus.Queued);
    if (!options.preserveDeadline) {
      await this.input.turnStore?.updateDeadline(turnId, null);
    }
  }

  async markRunning(
    turnId: string,
    options: { preserveDeadline?: boolean } = {}
  ): Promise<void> {
    const deadlineAt = options.preserveDeadline ? null : this.buildDeadlineAt();
    if (this.input.turnStore?.markRunningIfActive) {
      const started = await this.input.turnStore.markRunningIfActive(
        turnId,
        deadlineAt,
        options.preserveDeadline
      );
      if (!started) {
        throw new DesktopDriverError(
          "Bridge turn was cancelled before start",
          "turn_cancelled"
        );
      }
      return;
    }

    await this.assertCanStart(turnId);
    await this.input.turnStore?.updateStatus(turnId, BridgeTurnStatus.Running);
    if (!options.preserveDeadline) {
      await this.input.turnStore?.updateDeadline(turnId, deadlineAt);
    }
  }

  async markCompleted(turnId: string, lastError: string | null = null): Promise<void> {
    await this.markTerminal(turnId, BridgeTurnStatus.Completed, lastError);
  }

  async markFailed(turnId: string, lastError: string | null): Promise<void> {
    await this.markTerminal(turnId, BridgeTurnStatus.Failed, lastError);
  }

  async markRecoverable(
    turnId: string,
    status: BridgeTurnStatus,
    lastError: string | null
  ): Promise<void> {
    await this.markTerminal(turnId, status, lastError);
  }

  private async markTerminal(
    turnId: string,
    status: BridgeTurnStatus,
    lastError: string | null
  ): Promise<void> {
    if (this.input.turnStore?.markTerminalIfActive) {
      await this.input.turnStore.markTerminalIfActive(turnId, status, lastError);
      return;
    }
    await this.input.turnStore?.updateStatus(turnId, status, lastError);
  }

  async assertCanStart(turnId: string): Promise<void> {
    if (await this.isTerminal(turnId)) {
      throw new DesktopDriverError(
        "Bridge turn was cancelled before start",
        "turn_cancelled"
      );
    }
  }

  async isCancelled(turnId: string): Promise<boolean> {
    const turn = await this.input.turnStore?.getTurn(turnId);
    return turn?.status === BridgeTurnStatus.Cancelled;
  }

  async isTerminal(turnId: string): Promise<boolean> {
    const turn = await this.input.turnStore?.getTurn(turnId);
    return Boolean(turn && !isActiveBridgeTurnStatus(turn.status));
  }

  async isCodexTurnCancelled(
    sessionKey: string,
    codexTurnRef: string,
    qqMessageId: string | null
  ): Promise<boolean> {
    const turn = await this.input.turnStore?.getTurnByCodexTurn(
      sessionKey,
      codexTurnRef,
      qqMessageId
    );
    return turn?.status === BridgeTurnStatus.Cancelled;
  }

  async shouldIgnoreCodexTurnEvent(
    sessionKey: string,
    codexTurnRef: string,
    qqMessageId: string | null
  ): Promise<boolean> {
    const turn = await this.input.turnStore?.getTurnByCodexTurn(
      sessionKey,
      codexTurnRef,
      qqMessageId
    );
    return Boolean(turn && !isActiveBridgeTurnStatus(turn.status));
  }

  async runWithDeadline<T>(
    turnId: string,
    work: () => Promise<T>,
    onTimeout?: (error: DesktopDriverError) => Promise<boolean>
  ): Promise<T> {
    const timeoutMs = this.input.turnTimeoutMs ?? 0;
    if (timeoutMs <= 0) {
      return work();
    }

    let timeout: NodeJS.Timeout | null = null;
    const workPromise = work();
    workPromise.catch(() => undefined);
    const timeoutError = new DesktopDriverError(
      `Bridge turn exceeded hard timeout after ${timeoutMs}ms`,
      "reply_timeout"
    );
    try {
      return await Promise.race([
        workPromise,
        new Promise<T>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(timeoutError);
          }, timeoutMs);
        })
      ]);
    } catch (error) {
      if (error !== timeoutError) {
        throw error;
      }

      const interrupted = await onTimeout?.(timeoutError) ?? false;
      if (interrupted) {
        await workPromise.catch(() => undefined);
      }
      throw timeoutError;
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  classifyRecoverableError(error: unknown): BridgeTurnStatus | null {
    if (!(error instanceof DesktopDriverError)) {
      return null;
    }

    if (error.reason === "reply_timeout") {
      return BridgeTurnStatus.TimedOut;
    }

    if (error.reason === "turn_cancelled") {
      return BridgeTurnStatus.Cancelled;
    }

    if (error.reason === "context_length_exceeded") {
      return BridgeTurnStatus.Failed;
    }

    return null;
  }

  buildRecoverableStatusText(status: BridgeTurnStatus, error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    if (status === BridgeTurnStatus.Cancelled) {
      return "\u4efb\u52a1\u5df2\u53d6\u6d88\u3002";
    }
    if (status === BridgeTurnStatus.TimedOut) {
      return `\u4efb\u52a1\u5df2\u505c\u6b62\uff1a${message}`;
    }
    return `\u4efb\u52a1\u5df2\u7ed3\u675f\uff1a${message}`;
  }

  private buildDeadlineAt(): string | null {
    const timeoutMs = this.input.turnTimeoutMs ?? 0;
    return timeoutMs > 0 ? new Date(Date.now() + timeoutMs).toISOString() : null;
  }
}

function isActiveBridgeTurnStatus(status: BridgeTurnStatus): boolean {
  return (ACTIVE_BRIDGE_TURN_STATUSES as readonly BridgeTurnStatus[]).includes(status);
}

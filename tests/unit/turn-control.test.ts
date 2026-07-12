import { describe, expect, it, vi } from "vitest";
import { BridgeTurnStatus, type BridgeTurnRecord } from "../../packages/domain/src/turn.js";
import { TurnControl, doesTurnIdMatchRequest } from "../../packages/orchestrator/src/turn-control.js";
import type { TurnStorePort } from "../../packages/ports/src/store.js";

function createTurn(overrides: Partial<BridgeTurnRecord> = {}): BridgeTurnRecord {
  return {
    turnId: "bridge-turn-1234567890abcdef",
    sessionKey: "qqbot:default::qq:c2c:abc-123",
    codexThreadRef: null,
    codexTurnRef: null,
    qqMessageId: "msg-1",
    status: BridgeTurnStatus.Running,
    startedAt: "2026-07-07T10:00:00.000Z",
    updatedAt: "2026-07-07T10:00:01.000Z",
    deadlineAt: null,
    lastEventAt: null,
    lastToolName: null,
    lastError: null,
    deliveredTextLength: 0,
    ...overrides
  };
}

function createTurnStore(current: BridgeTurnRecord | null): TurnStorePort {
  return {
    createTurn: vi.fn(),
    attachCodexTurn: vi.fn(),
    updateCodexThreadRef: vi.fn(),
    updateStatus: vi.fn(),
    markTerminalIfActive: vi.fn().mockResolvedValue(true),
    updateDeadline: vi.fn(),
    recordTurnEvent: vi.fn(),
    addDeliveredText: vi.fn(),
    getCurrentTurn: vi.fn().mockResolvedValue(current),
    getTurn: vi.fn(),
    getTurnByCodexTurn: vi.fn(),
    listRecentTurns: vi.fn()
  };
}

describe("TurnControl", () => {
  it("cancels the current turn and interrupts the active driver turn", async () => {
    const current = createTurn();
    const turnStore = createTurnStore(current);
    const desktopDriver = {
      interruptActiveTurn: vi.fn().mockResolvedValue(true)
    };

    const result = await new TurnControl({
      turnStore,
      desktopDriver
    }).cancelCurrentTurn(current.sessionKey, "bridge-turn");

    expect(result).toEqual({
      status: "cancelled",
      turnId: current.turnId,
      interrupted: true
    });
    expect(desktopDriver.interruptActiveTurn).toHaveBeenCalledWith(current.sessionKey);
    expect(turnStore.markTerminalIfActive).toHaveBeenCalledWith(
      current.turnId,
      BridgeTurnStatus.Cancelled,
      null
    );
  });

  it("preserves compact task id matching", () => {
    expect(doesTurnIdMatchRequest("bridge-turn-1234567890abcdef", "bridge...abcdef")).toBe(true);
    expect(doesTurnIdMatchRequest("bridge-turn-1234567890abcdef", "other...abcdef")).toBe(false);
  });

  it("keeps the turn active when driver interrupt fails", async () => {
    const current = createTurn();
    const turnStore = createTurnStore(current);
    const desktopDriver = {
      interruptActiveTurn: vi.fn().mockRejectedValue(new Error("interrupt failed"))
    };

    const result = await new TurnControl({
      turnStore,
      desktopDriver
    }).cancelCurrentTurn(current.sessionKey);

    expect(result).toEqual({
      status: "interrupt-failed",
      turnId: current.turnId,
      error: "interrupt failed"
    });
    expect(turnStore.updateStatus).not.toHaveBeenCalled();
    expect(turnStore.markTerminalIfActive).not.toHaveBeenCalled();
  });

  it("does not overwrite a turn that completed while cancellation was in flight", async () => {
    const current = createTurn();
    const turnStore = createTurnStore(current);
    vi.mocked(turnStore.markTerminalIfActive!).mockResolvedValue(false);
    vi.mocked(turnStore.getTurn).mockResolvedValue(
      createTurn({ status: BridgeTurnStatus.Completed })
    );
    const desktopDriver = {
      interruptActiveTurn: vi.fn().mockResolvedValue(false)
    };

    const result = await new TurnControl({
      turnStore,
      desktopDriver
    }).cancelCurrentTurn(current.sessionKey);

    expect(result).toEqual({ status: "no-active-turn" });
    expect(turnStore.markTerminalIfActive).toHaveBeenCalledWith(
      current.turnId,
      BridgeTurnStatus.Cancelled,
      null
    );
    expect(turnStore.updateStatus).not.toHaveBeenCalled();
  });

  it("reports cancellation success when the provider recorded Cancelled first", async () => {
    const current = createTurn();
    const turnStore = createTurnStore(current);
    vi.mocked(turnStore.markTerminalIfActive!).mockResolvedValue(false);
    vi.mocked(turnStore.getTurn).mockResolvedValue(
      createTurn({ status: BridgeTurnStatus.Cancelled })
    );
    const desktopDriver = {
      interruptActiveTurn: vi.fn().mockResolvedValue(true)
    };

    const result = await new TurnControl({
      turnStore,
      desktopDriver
    }).cancelCurrentTurn(current.sessionKey);

    expect(result).toEqual({
      status: "cancelled",
      turnId: current.turnId,
      interrupted: true
    });
  });
});

import { describe, expect, it, vi } from "vitest";
import { BridgeTurnStatus, type BridgeTurnRecord } from "../../packages/domain/src/turn.js";
import { TurnQuery, formatRecentTasks } from "../../packages/orchestrator/src/turn-query.js";
import type { TurnStorePort } from "../../packages/ports/src/store.js";

function createTurn(overrides: Partial<BridgeTurnRecord> = {}): BridgeTurnRecord {
  return {
    turnId: "bridge-turn-1234567890abcdef",
    sessionKey: "qqbot:default::qq:c2c:abc-123",
    codexThreadRef: "thread-1",
    codexTurnRef: "codex-turn-1",
    qqMessageId: "msg-1",
    status: BridgeTurnStatus.Running,
    startedAt: "2026-07-07T10:00:00.000Z",
    updatedAt: new Date(Date.now() - 10_000).toISOString(),
    deadlineAt: null,
    lastEventAt: null,
    lastToolName: null,
    lastError: null,
    deliveredTextLength: 0,
    ...overrides
  };
}

function createTurnStore(input: {
  current?: BridgeTurnRecord | null;
  recent?: BridgeTurnRecord[];
} = {}): TurnStorePort {
  return {
    createTurn: vi.fn(),
    attachCodexTurn: vi.fn(),
    updateCodexThreadRef: vi.fn(),
    updateStatus: vi.fn(),
    updateDeadline: vi.fn(),
    recordTurnEvent: vi.fn(),
    addDeliveredText: vi.fn(),
    getCurrentTurn: vi.fn().mockResolvedValue(input.current ?? null),
    getTurn: vi.fn(),
    getTurnByCodexTurn: vi.fn(),
    listRecentTurns: vi.fn().mockResolvedValue(input.recent ?? [])
  };
}

describe("TurnQuery", () => {
  it("builds current task text from the active turn", async () => {
    const turn = createTurn({ lastError: "still running" });
    const turnStore = createTurnStore({ current: turn });

    await expect(
      new TurnQuery({ turnStore }).buildCurrentTaskText(turn.sessionKey)
    ).resolves.toContain("Current task:");
    await expect(
      new TurnQuery({ turnStore }).buildCurrentTaskText(turn.sessionKey)
    ).resolves.toContain("Last error: still running");
    expect(turnStore.getCurrentTurn).toHaveBeenCalledWith(turn.sessionKey);
  });

  it("builds recent task table with compact ids and escaped cells", async () => {
    const turn = createTurn({
      turnId: "bridge-turn-1234567890abcdef",
      status: BridgeTurnStatus.Completed,
      lastError: "a | b"
    });
    const turnStore = createTurnStore({ recent: [turn] });

    const text = await new TurnQuery({ turnStore }).buildRecentTasksText(turn.sessionKey);

    expect(turnStore.listRecentTurns).toHaveBeenCalledWith(turn.sessionKey, 10);
    expect(text).toContain("Recent tasks:");
    expect(text).toContain("| bridge-turn- | completed |");
    expect(text).toContain("a \\| b");
  });

  it("reports missing task history", () => {
    expect(formatRecentTasks([])).toBe("No task history for this conversation yet.");
  });
});

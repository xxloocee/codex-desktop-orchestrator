import { describe, expect, it, vi } from "vitest";
import { TurnRecoveryController } from "../../packages/orchestrator/src/turn-recovery-controller.js";

describe("TurnRecoveryController", () => {
  it("runs runtime recovery and formats the startup log line", () => {
    const report = {
      recoveredAt: "2026-07-07T10:00:00.000Z",
      timedOutTurns: 1,
      orphanedTurns: 2,
      clearedSessionLocks: 3,
      clearedThreadLocks: 4,
      remainingActiveTurns: 5
    };
    const runtimeRecoveryStore = {
      recoverAbandonedState: vi.fn().mockReturnValue(report)
    };

    const result = new TurnRecoveryController({
      runtimeRecoveryStore
    }).recoverAbandonedState("2026-07-07T10:00:00.000Z");

    expect(runtimeRecoveryStore.recoverAbandonedState).toHaveBeenCalledWith(
      "2026-07-07T10:00:00.000Z"
    );
    expect(result).toEqual({
      report,
      logLine: "recovery timedOutTurns=1 orphanedTurns=2 clearedSessionLocks=3 clearedThreadLocks=4 remainingActiveTurns=5"
    });
  });
});

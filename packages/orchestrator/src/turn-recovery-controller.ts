export type RuntimeRecoveryReport = {
  recoveredAt: string;
  timedOutTurns: number;
  orphanedTurns: number;
  clearedSessionLocks: number;
  clearedThreadLocks: number;
  remainingActiveTurns: number;
};

export interface RuntimeRecoveryStorePort {
  recoverAbandonedState(now?: string): RuntimeRecoveryReport;
}

export class TurnRecoveryController {
  constructor(
    private readonly input: {
      runtimeRecoveryStore: RuntimeRecoveryStorePort;
    }
  ) {}

  recoverAbandonedState(now?: string): {
    report: RuntimeRecoveryReport;
    logLine: string;
  } {
    const report = this.input.runtimeRecoveryStore.recoverAbandonedState(now);
    return {
      report,
      logLine: formatRuntimeRecoveryLog(report)
    };
  }
}

export function formatRuntimeRecoveryLog(report: RuntimeRecoveryReport): string {
  return `recovery timedOutTurns=${report.timedOutTurns} orphanedTurns=${report.orphanedTurns} clearedSessionLocks=${report.clearedSessionLocks} clearedThreadLocks=${report.clearedThreadLocks} remainingActiveTurns=${report.remainingActiveTurns}`;
}

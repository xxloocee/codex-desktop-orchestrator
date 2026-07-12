export class SessionTurnScheduler {
  private readonly sessionTurnTails = new Map<string, Promise<void>>();

  async run<T>(
    sessionKey: string,
    onQueued: (() => Promise<void>) | undefined,
    work: () => Promise<T>
  ): Promise<T> {
    const isQueued = this.sessionTurnTails.has(sessionKey);
    const previousTail = this.sessionTurnTails.get(sessionKey) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const currentTail = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const queuedTail = previousTail.then(() => currentTail, () => currentTail);

    this.sessionTurnTails.set(sessionKey, queuedTail);
    if (isQueued) {
      try {
        await onQueued?.();
      } catch (error) {
        console.warn("[codex-desktop-orchestrator] session queue notice failed", {
          sessionKey,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    await previousTail;
    try {
      return await work();
    } finally {
      releaseCurrent();
      if (this.sessionTurnTails.get(sessionKey) === queuedTail) {
        this.sessionTurnTails.delete(sessionKey);
      }
    }
  }
}

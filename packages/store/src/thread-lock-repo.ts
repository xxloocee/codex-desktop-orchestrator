import { randomUUID } from "node:crypto";
import type { ThreadLockStorePort } from "../../ports/src/store.js";
import type { SqliteDatabase } from "./sqlite.js";

export class SqliteThreadLockStore implements ThreadLockStorePort {
  private readonly threadLockTails = new Map<string, Promise<void>>();

  constructor(private readonly db: SqliteDatabase) {}

  async withThreadLock<T>(
    threadRef: string,
    work: () => Promise<T>,
    options?: { onQueued?: () => Promise<void> }
  ): Promise<T> {
    const isQueued = this.threadLockTails.has(threadRef);
    const previousTail = this.threadLockTails.get(threadRef) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const currentTail = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const queuedTail = previousTail.then(() => currentTail);

    this.threadLockTails.set(threadRef, queuedTail);
    if (isQueued) {
      try {
        await options?.onQueued?.();
      } catch (error) {
        console.warn("[codex-desktop-orchestrator] thread queue notice failed", {
          threadRef,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    await previousTail;

    const owner = randomUUID();
    const lockedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();

    this.db.prepare(`DELETE FROM thread_locks WHERE thread_ref = ?`).run(threadRef);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO thread_locks (thread_ref, owner, locked_at, expires_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(threadRef, owner, lockedAt, expiresAt);

    try {
      return await work();
    } finally {
      this.db.prepare(`DELETE FROM thread_locks WHERE thread_ref = ? AND owner = ?`).run(threadRef, owner);
      releaseCurrent();
      if (this.threadLockTails.get(threadRef) === queuedTail) {
        this.threadLockTails.delete(threadRef);
      }
    }
  }
}

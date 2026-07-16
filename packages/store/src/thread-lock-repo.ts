import { randomUUID } from "node:crypto";
import type { ThreadLockStorePort } from "../../ports/src/store.js";
import type { SqliteDatabase } from "./sqlite.js";

export class SqliteThreadLockStore implements ThreadLockStorePort {
  private readonly threadLockTails = new Map<string, Promise<void>>();

  constructor(
    private readonly db: SqliteDatabase,
    private readonly options: {
      leaseTtlMs?: number;
      renewIntervalMs?: number;
      pollIntervalMs?: number;
      now?: () => Date;
      sleep?: (ms: number) => Promise<void>;
    } = {}
  ) {}

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
    let queueNoticeSent = false;
    const notifyQueued = async () => {
      if (queueNoticeSent) {
        return;
      }
      queueNoticeSent = true;
      try {
        await options?.onQueued?.();
      } catch (error) {
        console.warn("[codex-desktop-orchestrator] thread queue notice failed", {
          threadRef,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    };
    if (isQueued) {
      await notifyQueued();
    }
    await previousTail;

    const owner = randomUUID();
    let acquired = false;
    let renewalTimer: NodeJS.Timeout | null = null;

    try {
      while (!acquired) {
        const now = this.now();
        this.db
          .prepare(`DELETE FROM thread_locks WHERE thread_ref = ? AND expires_at <= ?`)
          .run(threadRef, now.toISOString());
        const inserted = this.db
          .prepare(
            `INSERT OR IGNORE INTO thread_locks (thread_ref, owner, locked_at, expires_at)
             VALUES (?, ?, ?, ?)`
          )
          .run(
            threadRef,
            owner,
            now.toISOString(),
            new Date(now.getTime() + this.leaseTtlMs()).toISOString()
          );
        acquired = inserted.changes > 0;
        if (!acquired) {
          await notifyQueued();
          await this.sleep(this.options.pollIntervalMs ?? 100);
        }
      }

      renewalTimer = setInterval(() => {
        try {
          const now = this.now();
          const renewed = this.db
            .prepare(
              `UPDATE thread_locks
               SET expires_at = ?
               WHERE thread_ref = ? AND owner = ?`
            )
            .run(
              new Date(now.getTime() + this.leaseTtlMs()).toISOString(),
              threadRef,
              owner
            );
          if (renewed.changes === 0) {
            console.warn("[codex-desktop-orchestrator] thread lock lease was lost", {
              threadRef,
              owner
            });
          }
        } catch (error) {
          console.warn("[codex-desktop-orchestrator] thread lock lease renewal failed", {
            threadRef,
            owner,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }, this.options.renewIntervalMs ?? 20_000);
      renewalTimer.unref?.();
      return await work();
    } finally {
      if (renewalTimer) {
        clearInterval(renewalTimer);
      }
      if (acquired) {
        this.db.prepare(`DELETE FROM thread_locks WHERE thread_ref = ? AND owner = ?`).run(threadRef, owner);
      }
      releaseCurrent();
      if (this.threadLockTails.get(threadRef) === queuedTail) {
        this.threadLockTails.delete(threadRef);
      }
    }
  }

  private leaseTtlMs(): number {
    return this.options.leaseTtlMs ?? 60_000;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private sleep(ms: number): Promise<void> {
    return this.options.sleep?.(ms)
      ?? new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
}

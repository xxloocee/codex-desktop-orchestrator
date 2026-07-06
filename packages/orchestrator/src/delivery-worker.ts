import { DeliveryJobStatus, type DeliveryRecord, type OutboundDraft } from "../../domain/src/message.js";
import type { ChatEgressPort } from "../../ports/src/chat.js";
import type { DeliveryJobStorePort } from "../../ports/src/store.js";

type DeliveryWorkerOptions = {
  store: DeliveryJobStorePort;
  resolveEgress: (draft: OutboundDraft) => ChatEgressPort | null;
  maxAttempts?: number;
  retryBackoffMs?: number;
  deliveryTimeoutMs?: number;
  batchSize?: number;
  intervalMs?: number;
};

export class DeliveryWorker {
  private readonly maxAttempts: number;
  private readonly retryBackoffMs: number;
  private readonly deliveryTimeoutMs: number;
  private readonly batchSize: number;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private readonly activeRuns = new Set<Promise<void>>();
  private running = false;

  constructor(private readonly options: DeliveryWorkerOptions) {
    this.maxAttempts = options.maxAttempts ?? 3;
    this.retryBackoffMs = options.retryBackoffMs ?? 30_000;
    this.deliveryTimeoutMs = options.deliveryTimeoutMs ?? 30_000;
    this.batchSize = options.batchSize ?? 10;
    this.intervalMs = options.intervalMs ?? 5_000;
  }

  async recover(): Promise<number> {
    return this.options.store.recoverInFlight(new Date().toISOString());
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.runTracked("startup", async () => {
      await this.recover();
      await this.processDueJobs();
    });
    this.timer = setInterval(() => {
      this.runTracked("tick", () => this.processDueJobs());
    }, this.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    while (this.activeRuns.size > 0) {
      await Promise.allSettled([...this.activeRuns]);
    }
  }

  async processDueJobs(): Promise<number> {
    if (this.running) {
      return 0;
    }
    this.running = true;
    try {
      const jobs = await this.options.store.claimDueJobs({
        limit: this.batchSize,
        now: new Date().toISOString()
      });
      for (const job of jobs) {
        const egress = this.options.resolveEgress(job.payload);
        if (!egress) {
          await this.options.store.markAttemptFailed({
            jobId: job.jobId,
            failedAt: new Date().toISOString(),
            error: `No egress configured for session: ${job.sessionKey}`,
            maxAttempts: this.maxAttempts,
            retryAfterMs: this.retryBackoffMs
          });
          continue;
        }

        try {
          const delivery = await this.deliverWithTimeout(egress, job.payload);
          await this.options.store.markDelivered({
            jobId: job.jobId,
            deliveredAt: delivery.deliveredAt,
            providerMessageId: delivery.providerMessageId
          });
        } catch (error) {
          const maxAttempts = isRetryableDeliveryError(error)
            ? this.maxAttempts
            : job.attemptCount;
          await this.options.store.markAttemptFailed({
            jobId: job.jobId,
            failedAt: new Date().toISOString(),
            error: error instanceof Error ? error.message : String(error),
            maxAttempts,
            retryAfterMs: this.retryBackoffMs
          });
        }
      }
      return jobs.length;
    } finally {
      this.running = false;
    }
  }

  private logError(message: string, error: unknown): void {
    console.warn(`[codex-desktop-orchestrator] ${message}`, {
      error: error instanceof Error ? error.message : String(error)
    });
  }

  private runTracked(label: "startup" | "tick", work: () => Promise<unknown>): void {
    const run: Promise<void> = work()
      .then(() => undefined)
      .catch((error) => {
        this.logError(`delivery worker ${label} failed`, error);
      })
      .finally(() => {
        this.activeRuns.delete(run);
      });
    this.activeRuns.add(run);
  }

  private async deliverWithTimeout(
    egress: ChatEgressPort,
    draft: OutboundDraft
  ): Promise<DeliveryRecord> {
    let timeout: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        egress.deliver(draft),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            reject(new DeliveryTimeoutError(this.deliveryTimeoutMs));
          }, this.deliveryTimeoutMs);
        })
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }
}

class DeliveryTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Delivery timed out after ${timeoutMs}ms`);
    this.name = "DeliveryTimeoutError";
  }
}

export class RetryableDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableDeliveryError";
  }
}

function isRetryableDeliveryError(error: unknown): boolean {
  if (error instanceof RetryableDeliveryError || error instanceof DeliveryTimeoutError) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  const statusMatch = message.match(/\b(?:408|425|429|5\d\d)\b/);
  if (statusMatch) {
    return true;
  }

  return /\b(?:fetch failed|network|timeout|timed out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up)\b/i.test(message);
}

export async function markSynchronousDeliveryResult(
  store: DeliveryJobStorePort | null | undefined,
  draft: OutboundDraft,
  result: DeliveryRecord
): Promise<void> {
  await store?.markDelivered({
    jobId: draft.draftId,
    deliveredAt: result.deliveredAt,
    providerMessageId: result.providerMessageId
  });
}

export async function markSynchronousDeliveryFailure(
  store: DeliveryJobStorePort | null | undefined,
  draft: OutboundDraft,
  error: unknown,
  options: { maxAttempts?: number; retryBackoffMs?: number } = {}
): Promise<void> {
  const maxAttempts = isRetryableDeliveryError(error) ? options.maxAttempts ?? 3 : 1;
  await store?.markAttemptFailed({
    jobId: draft.draftId,
    failedAt: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
    maxAttempts,
    retryAfterMs: options.retryBackoffMs ?? 30_000
  });
}

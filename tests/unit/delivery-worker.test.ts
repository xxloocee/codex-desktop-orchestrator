import { describe, expect, it, vi } from "vitest";
import {
  DeliveryJobStatus,
  type DeliveryJobRecord,
  type OutboundDraft
} from "../../packages/domain/src/message.js";
import {
  DeliveryWorker,
  RetryableDeliveryError,
  markSynchronousDeliveryFailure
} from "../../packages/orchestrator/src/delivery-worker.js";
import type { DeliveryJobStorePort } from "../../packages/ports/src/store.js";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

async function waitForCondition(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not met");
}

function createJob(overrides: Partial<DeliveryJobRecord> = {}): DeliveryJobRecord {
  const payload: OutboundDraft = {
    draftId: "draft-1",
    sessionKey: "qqbot:default::qq:c2c:abc-123",
    text: "reply",
    createdAt: "2026-07-01T10:00:00.000Z"
  };
  return {
    jobId: payload.draftId,
    sessionKey: payload.sessionKey,
    status: DeliveryJobStatus.InFlight,
    attemptCount: 1,
    payload,
    lastError: null,
    createdAt: payload.createdAt,
    updatedAt: payload.createdAt,
    nextAttemptAt: null,
    deliveredAt: null,
    providerMessageId: null,
    ...overrides
  };
}

describe("delivery worker", () => {
  it("delivers claimed jobs and marks them delivered", async () => {
    const job = createJob();
    const store: DeliveryJobStorePort = {
      claimDueJobs: vi.fn().mockResolvedValue([job]),
      markDelivered: vi.fn().mockResolvedValue(undefined),
      markAttemptFailed: vi.fn().mockResolvedValue(undefined),
      recoverInFlight: vi.fn().mockResolvedValue(0),
      listJobs: vi.fn().mockResolvedValue([])
    };
    const egress = {
      deliver: vi.fn().mockResolvedValue({
        jobId: job.jobId,
        sessionKey: job.sessionKey,
        providerMessageId: "provider-1",
        deliveredAt: "2026-07-01T10:00:03.000Z"
      })
    };
    const worker = new DeliveryWorker({
      store,
      resolveEgress: () => egress
    });

    await expect(worker.processDueJobs()).resolves.toBe(1);
    expect(egress.deliver).toHaveBeenCalledWith(job.payload);
    expect(store.markDelivered).toHaveBeenCalledWith({
      jobId: job.jobId,
      deliveredAt: "2026-07-01T10:00:03.000Z",
      providerMessageId: "provider-1"
    });
  });

  it("marks explicitly retryable jobs for retry when delivery fails", async () => {
    const job = createJob();
    const deliver = vi.fn().mockRejectedValue(new RetryableDeliveryError("network down"));
    const store: DeliveryJobStorePort = {
      claimDueJobs: vi.fn().mockResolvedValue([job]),
      markDelivered: vi.fn().mockResolvedValue(undefined),
      markAttemptFailed: vi.fn().mockResolvedValue(undefined),
      recoverInFlight: vi.fn().mockResolvedValue(0),
      listJobs: vi.fn().mockResolvedValue([])
    };
    const worker = new DeliveryWorker({
      store,
      retryBackoffMs: 10_000,
      maxAttempts: 3,
      resolveEgress: () => ({
        deliver
      })
    });

    await expect(worker.processDueJobs()).resolves.toBe(1);
    expect(store.markAttemptFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: job.jobId,
        error: "network down",
        maxAttempts: 3,
        retryAfterMs: 10_000
      })
    );
  });

  it("marks unknown delivery errors as terminal failures", async () => {
    const job = createJob();
    const deliver = vi.fn().mockRejectedValue(new Error("socket closed"));
    const store: DeliveryJobStorePort = {
      claimDueJobs: vi.fn().mockResolvedValue([job]),
      markDelivered: vi.fn().mockResolvedValue(undefined),
      markAttemptFailed: vi.fn().mockResolvedValue(undefined),
      recoverInFlight: vi.fn().mockResolvedValue(0),
      listJobs: vi.fn().mockResolvedValue([])
    };
    const worker = new DeliveryWorker({
      store,
      maxAttempts: 3,
      resolveEgress: () => ({ deliver })
    });

    await expect(worker.processDueJobs()).resolves.toBe(1);
    expect(store.markAttemptFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: job.jobId,
        error: "socket closed",
        maxAttempts: job.attemptCount
      })
    );
  });

  it("times out a stuck delivery and continues later ticks", async () => {
    const stuckJob = createJob({ jobId: "draft-stuck" });
    const laterJob = createJob({
      jobId: "draft-later",
      payload: {
        draftId: "draft-later",
        sessionKey: "qqbot:default::qq:c2c:abc-123",
        text: "later reply",
        createdAt: "2026-07-01T10:00:01.000Z"
      }
    });
    const store: DeliveryJobStorePort = {
      claimDueJobs: vi.fn()
        .mockResolvedValueOnce([stuckJob])
        .mockResolvedValueOnce([laterJob]),
      markDelivered: vi.fn().mockResolvedValue(undefined),
      markAttemptFailed: vi.fn().mockResolvedValue(undefined),
      recoverInFlight: vi.fn().mockResolvedValue(0),
      listJobs: vi.fn().mockResolvedValue([])
    };
    const deliver = vi.fn()
      .mockReturnValueOnce(new Promise(() => {}))
      .mockResolvedValueOnce({
        jobId: laterJob.jobId,
        sessionKey: laterJob.sessionKey,
        providerMessageId: "provider-later",
        deliveredAt: "2026-07-01T10:00:03.000Z"
      });
    const worker = new DeliveryWorker({
      store,
      deliveryTimeoutMs: 5,
      resolveEgress: () => ({ deliver })
    });

    await expect(worker.processDueJobs()).resolves.toBe(1);
    expect(store.markAttemptFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: stuckJob.jobId,
        error: "Delivery timed out after 5ms",
        maxAttempts: stuckJob.attemptCount
      })
    );

    await expect(worker.processDueJobs()).resolves.toBe(1);
    expect(store.markDelivered).toHaveBeenCalledWith({
      jobId: laterJob.jobId,
      deliveredAt: "2026-07-01T10:00:03.000Z",
      providerMessageId: "provider-later"
    });
  });

  it("waits for an active delivery before stopping", async () => {
    const job = createJob();
    const delivery = createDeferred<{
      jobId: string;
      sessionKey: string;
      providerMessageId: string;
      deliveredAt: string;
    }>();
    const store: DeliveryJobStorePort = {
      claimDueJobs: vi.fn().mockResolvedValueOnce([job]).mockResolvedValue([]),
      markDelivered: vi.fn().mockResolvedValue(undefined),
      markAttemptFailed: vi.fn().mockResolvedValue(undefined),
      recoverInFlight: vi.fn().mockResolvedValue(0),
      listJobs: vi.fn().mockResolvedValue([])
    };
    const egress = {
      deliver: vi.fn().mockReturnValue(delivery.promise)
    };
    const worker = new DeliveryWorker({
      store,
      intervalMs: 10_000,
      resolveEgress: () => egress
    });

    worker.start();
    await waitForCondition(() => egress.deliver.mock.calls.length === 1);

    let stopped = false;
    const stopPromise = worker.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(stopped).toBe(false);

    delivery.resolve({
      jobId: job.jobId,
      sessionKey: job.sessionKey,
      providerMessageId: "provider-1",
      deliveredAt: "2026-07-01T10:00:03.000Z"
    });
    await stopPromise;

    expect(stopped).toBe(true);
    expect(store.markDelivered).toHaveBeenCalledWith({
      jobId: job.jobId,
      deliveredAt: "2026-07-01T10:00:03.000Z",
      providerMessageId: "provider-1"
    });
  });

  it("marks synchronous unknown delivery failures as terminal", async () => {
    const draft: OutboundDraft = {
      draftId: "draft-sync",
      sessionKey: "qqbot:default::qq:c2c:abc-123",
      text: "reply",
      createdAt: "2026-07-01T10:00:00.000Z"
    };
    const store: DeliveryJobStorePort = {
      claimDueJobs: vi.fn().mockResolvedValue([]),
      markDelivered: vi.fn().mockResolvedValue(undefined),
      markAttemptFailed: vi.fn().mockResolvedValue(undefined),
      recoverInFlight: vi.fn().mockResolvedValue(0),
      listJobs: vi.fn().mockResolvedValue([])
    };

    await markSynchronousDeliveryFailure(store, draft, new Error("socket closed"));

    expect(store.markAttemptFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: draft.draftId,
        error: "socket closed",
        maxAttempts: 1
      })
    );
  });

  it("keeps synchronous retry for explicitly retryable delivery failures", async () => {
    const draft: OutboundDraft = {
      draftId: "draft-sync-retry",
      sessionKey: "qqbot:default::qq:c2c:abc-123",
      text: "reply",
      createdAt: "2026-07-01T10:00:00.000Z"
    };
    const store: DeliveryJobStorePort = {
      claimDueJobs: vi.fn().mockResolvedValue([]),
      markDelivered: vi.fn().mockResolvedValue(undefined),
      markAttemptFailed: vi.fn().mockResolvedValue(undefined),
      recoverInFlight: vi.fn().mockResolvedValue(0),
      listJobs: vi.fn().mockResolvedValue([])
    };

    await markSynchronousDeliveryFailure(
      store,
      draft,
      new RetryableDeliveryError("auth unavailable"),
      { maxAttempts: 4, retryBackoffMs: 10_000 }
    );

    expect(store.markAttemptFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: draft.draftId,
        error: "auth unavailable",
        maxAttempts: 4,
        retryAfterMs: 10_000
      })
    );
  });
});

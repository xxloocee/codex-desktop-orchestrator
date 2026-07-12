import { describe, expect, it, vi } from "vitest";
import { DeliveryJobStatus, type DeliveryJobRecord } from "../../packages/domain/src/message.js";
import { DeliveryQuery, formatDeliveryJobs } from "../../packages/orchestrator/src/delivery-query.js";
import type { DeliveryJobStorePort } from "../../packages/ports/src/store.js";

function createJob(overrides: Partial<DeliveryJobRecord> = {}): DeliveryJobRecord {
  return {
    jobId: "draft-pending-1",
    sessionKey: "qqbot:default::qq:c2c:OPENID123",
    status: DeliveryJobStatus.Pending,
    attemptCount: 1,
    payload: {
      draftId: "draft-pending-1",
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      text: "queued reply",
      createdAt: "2026-07-01T10:00:00.000Z"
    },
    lastError: "network down",
    createdAt: "2026-07-01T10:00:00.000Z",
    updatedAt: new Date(Date.now() - 10_000).toISOString(),
    nextAttemptAt: null,
    deliveredAt: null,
    providerMessageId: null,
    ...overrides
  };
}

function createDeliveryJobStore(jobs: DeliveryJobRecord[]): DeliveryJobStorePort {
  return {
    claimDueJobs: vi.fn().mockResolvedValue([]),
    markDelivered: vi.fn(),
    markAttemptFailed: vi.fn(),
    recoverInFlight: vi.fn(),
    listJobs: vi.fn().mockResolvedValue(jobs)
  };
}

describe("DeliveryQuery", () => {
  it("queries pending, in-flight, and failed delivery jobs", async () => {
    const job = createJob();
    const deliveryJobStore = createDeliveryJobStore([job]);

    const text = await new DeliveryQuery({
      deliveryJobStore
    }).buildDeliveryJobsText(job.sessionKey);

    expect(deliveryJobStore.listJobs).toHaveBeenCalledWith({
      sessionKey: job.sessionKey,
      statuses: [
        DeliveryJobStatus.Pending,
        DeliveryJobStatus.InFlight,
        DeliveryJobStatus.Failed
      ],
      limit: 10
    });
    expect(text).toContain("Delivery jobs:");
    expect(text).toContain("network down");
    expect(text).toContain("queued reply");
  });

  it("reports missing delivery queue configuration", async () => {
    await expect(
      new DeliveryQuery({}).buildDeliveryJobsText("session-1")
    ).resolves.toBe("Delivery queue is not configured.");
  });

  it("formats empty and blank-text jobs", () => {
    expect(formatDeliveryJobs([])).toBe("No pending or failed delivery jobs for this conversation.");
    expect(formatDeliveryJobs([createJob({ payload: { ...createJob().payload, text: "  " } })]))
      .toContain("text: -");
  });
});

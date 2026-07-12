import { DeliveryJobStatus, type DeliveryJobRecord } from "../../domain/src/message.js";
import type { DeliveryJobStorePort } from "../../ports/src/store.js";

export class DeliveryQuery {
  constructor(private readonly input: { deliveryJobStore?: DeliveryJobStorePort }) {}

  async buildDeliveryJobsText(sessionKey: string, limit = 10): Promise<string> {
    if (!this.input.deliveryJobStore) {
      return "Delivery queue is not configured.";
    }

    const jobs = await this.input.deliveryJobStore.listJobs({
      sessionKey,
      statuses: [
        DeliveryJobStatus.Pending,
        DeliveryJobStatus.InFlight,
        DeliveryJobStatus.Failed
      ],
      limit
    });
    return formatDeliveryJobs(jobs);
  }
}

export function formatDeliveryJobs(jobs: DeliveryJobRecord[]): string {
  if (jobs.length === 0) {
    return "No pending or failed delivery jobs for this conversation.";
  }

  return [
    "Delivery jobs:",
    ...jobs.map((job) => [
      `- ${job.jobId}`,
      `  status: ${job.status}`,
      `  attempts: ${job.attemptCount}`,
      `  updated: ${formatRelativeTimestamp(job.updatedAt)}`,
      job.nextAttemptAt ? `  next retry: ${formatRelativeTimestamp(job.nextAttemptAt)}` : null,
      job.lastError ? `  error: ${job.lastError}` : null,
      `  text: ${previewText(job.payload.text)}`
    ].filter(Boolean).join("\n"))
  ].join("\n");
}

function previewText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "-";
  }

  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

function formatRelativeTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return value;
  }

  const deltaMs = Date.now() - timestamp;
  if (deltaMs < 0) {
    return value;
  }

  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) {
    return `${seconds}s ago`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

import type { BridgeTurnRecord } from "../../domain/src/turn.js";
import type { TurnStorePort } from "../../ports/src/store.js";

export class TurnQuery {
  constructor(private readonly input: { turnStore?: TurnStorePort }) {}

  async buildCurrentTaskText(sessionKey: string): Promise<string> {
    if (!this.input.turnStore) {
      return "Task tracking is not configured.";
    }

    const turn = await this.input.turnStore.getCurrentTurn(sessionKey);
    if (!turn) {
      return "No active task for this conversation.";
    }

    return formatCurrentTask(turn);
  }

  async buildRecentTasksText(sessionKey: string, limit = 10): Promise<string> {
    if (!this.input.turnStore) {
      return "Task tracking is not configured.";
    }

    const turns = await this.input.turnStore.listRecentTurns(sessionKey, limit);
    return formatRecentTasks(turns);
  }
}

export function formatCurrentTask(turn: BridgeTurnRecord): string {
  return [
    "Current task:",
    formatTurnSummary(turn),
    ...(turn.lastError ? [`Last error: ${turn.lastError}`] : []),
    "",
    "Use /tasks to see recent task history."
  ].join("\n");
}

export function formatRecentTasks(turns: BridgeTurnRecord[]): string {
  if (turns.length === 0) {
    return "No task history for this conversation yet.";
  }

  return [
    "Recent tasks:",
    "",
    "| Task | Status | Updated | Error |",
    "| --- | --- | --- | --- |",
    ...turns.map((turn) =>
      `| ${escapeMarkdownCell(shortTurnId(turn.turnId))} | ${escapeMarkdownCell(turn.status)} | ${escapeMarkdownCell(formatRelativeTimestamp(turn.updatedAt))} | ${escapeMarkdownCell(turn.lastError ?? "-")} |`
    )
  ].join("\n");
}

export function formatTurnSummary(turn: BridgeTurnRecord): string {
  return [
    `Task ID: ${turn.turnId}`,
    `Status: ${turn.status}`,
    `Message: ${turn.qqMessageId}`,
    ...(turn.codexTurnRef ? [`Codex turn: ${turn.codexTurnRef}`] : []),
    ...(turn.codexThreadRef ? [`Thread: ${turn.codexThreadRef}`] : []),
    `Started: ${formatRelativeTimestamp(turn.startedAt)}`,
    `Updated: ${formatRelativeTimestamp(turn.updatedAt)}`
  ].join("\n");
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
}

function shortTurnId(turnId: string): string {
  return turnId.length > 18 ? turnId.slice(0, 12) : turnId;
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

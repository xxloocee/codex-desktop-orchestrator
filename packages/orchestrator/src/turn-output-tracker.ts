import type { MediaArtifact, OutboundDraft, TurnEvent } from "../../domain/src/message.js";

export type TurnState = {
  lastSequence: number;
  assembledText: string;
  sentText: string;
  sentArtifactKeys: Set<string>;
  lastEventAt: string | null;
  eventObserved: boolean;
  completed: boolean;
  finalFlushed: boolean;
};

type ActiveOutputTurn = {
  messageId: string;
  turnId: string | null;
  retiredTurnIds: Set<string>;
};

export class TurnOutputTracker {
  private readonly turnStates = new Map<string, TurnState>();
  private readonly activeTurnsBySession = new Map<string, ActiveOutputTurn>();

  beginTurn(sessionKey: string, messageId: string): void {
    this.activeTurnsBySession.set(sessionKey, {
      messageId,
      turnId: null,
      retiredTurnIds: new Set<string>()
    });
  }

  shouldIgnoreEvent(event: TurnEvent): boolean {
    const activeTurn = this.activeTurnsBySession.get(event.sessionKey);
    if (!activeTurn) {
      return false;
    }

    if (activeTurn.retiredTurnIds.has(event.turnId)) {
      return true;
    }

    if (!activeTurn.turnId || activeTurn.turnId === event.turnId) {
      return false;
    }

    if (event.payload.replyToMessageId !== activeTurn.messageId) {
      return false;
    }

    return !this.isTurnFinalFlushed(event.sessionKey, activeTurn.turnId);
  }

  getOrCreate(event: TurnEvent): TurnState {
    const activeTurn = this.activeTurnsBySession.get(event.sessionKey);
    if (activeTurn && !activeTurn.retiredTurnIds.has(event.turnId)) {
      if (!activeTurn.turnId && event.payload.replyToMessageId === activeTurn.messageId) {
        activeTurn.turnId = event.turnId;
      } else if (
        activeTurn.turnId
        && activeTurn.turnId !== event.turnId
        && event.payload.replyToMessageId === activeTurn.messageId
        && this.isTurnFinalFlushed(event.sessionKey, activeTurn.turnId)
      ) {
        activeTurn.retiredTurnIds.add(activeTurn.turnId);
        activeTurn.turnId = event.turnId;
      }
    }
    const key = buildTurnStateKey(event.sessionKey, event.turnId);
    const existing = this.turnStates.get(key);
    if (existing) {
      existing.eventObserved = true;
      return existing;
    }

    const created = createTurnState(true);
    this.turnStates.set(key, created);
    return created;
  }

  hasObservedTurnEvent(sessionKey: string, turnId: string): boolean {
    return this.turnStates.get(buildTurnStateKey(sessionKey, turnId))?.eventObserved ?? false;
  }

  isLatestFinalFlushed(sessionKey: string): boolean {
    const turnId = this.activeTurnsBySession.get(sessionKey)?.turnId;
    return turnId ? this.isTurnFinalFlushed(sessionKey, turnId) : false;
  }

  recordDeliveredDraft(draft: OutboundDraft): void {
    if (!draft.turnId) {
      return;
    }

    const key = buildTurnStateKey(draft.sessionKey, draft.turnId);
    const state = this.turnStates.get(key) ?? createTurnState();
    state.sentText += draft.text;
    for (const artifact of draft.mediaArtifacts ?? []) {
      state.sentArtifactKeys.add(buildArtifactKey(artifact));
    }
    this.turnStates.set(key, state);
  }

  private isTurnFinalFlushed(sessionKey: string, turnId: string): boolean {
    return this.turnStates.get(buildTurnStateKey(sessionKey, turnId))?.finalFlushed ?? false;
  }

  filterAlreadyDeliveredDraft(draft: OutboundDraft): OutboundDraft {
    if (!draft.turnId) {
      return draft;
    }

    const state = this.turnStates.get(buildTurnStateKey(draft.sessionKey, draft.turnId));
    if (!state?.finalFlushed) {
      return draft;
    }

    const pendingText = computePendingTurnText(state.sentText, draft.text);
    const pendingArtifacts = filterPendingArtifacts(draft.mediaArtifacts ?? [], state.sentArtifactKeys);
    if (
      pendingText === draft.text
      && pendingArtifacts.length === (draft.mediaArtifacts?.length ?? 0)
    ) {
      return draft;
    }

    return {
      ...draft,
      text: pendingText,
      mediaArtifacts: pendingArtifacts
    };
  }
}

export function computePendingTurnText(sentText: string, fullText: string): string {
  if (!fullText) {
    return "";
  }

  if (!sentText) {
    return fullText;
  }

  if (fullText.startsWith(sentText)) {
    return fullText.slice(sentText.length);
  }

  if (stripWhitespace(fullText) === stripWhitespace(sentText)) {
    return "";
  }

  const overlap = findSuffixPrefixOverlap(sentText, fullText);
  if (overlap > 0) {
    return fullText.slice(overlap);
  }

  return fullText;
}

export function filterPendingArtifacts(
  artifacts: MediaArtifact[],
  sentArtifactKeys: Set<string>
): MediaArtifact[] {
  return artifacts.filter((artifact) => !sentArtifactKeys.has(buildArtifactKey(artifact)));
}

export function isEmptyDraft(draft: OutboundDraft): boolean {
  return !draft.text.trim() && !(draft.mediaArtifacts?.length);
}

function createTurnState(eventObserved = false): TurnState {
  return {
    lastSequence: 0,
    assembledText: "",
    sentText: "",
    sentArtifactKeys: new Set<string>(),
    lastEventAt: null,
    eventObserved,
    completed: false,
    finalFlushed: false
  };
}

function buildTurnStateKey(sessionKey: string, turnId: string): string {
  return `${sessionKey}::${turnId}`;
}

function findSuffixPrefixOverlap(previous: string, next: string): number {
  const maxLength = Math.min(previous.length, next.length);
  for (let length = maxLength; length > 0; length -= 1) {
    if (previous.slice(-length) === next.slice(0, length)) {
      return length;
    }
  }

  return 0;
}

function stripWhitespace(value: string): string {
  return value.replace(/\s+/g, "");
}

function buildArtifactKey(artifact: MediaArtifact): string {
  return [
    artifact.kind,
    artifact.localPath || "",
    artifact.sourceUrl || "",
    artifact.originalName || ""
  ].join("::");
}

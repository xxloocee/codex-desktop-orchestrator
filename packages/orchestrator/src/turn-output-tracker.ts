import type { MediaArtifact, OutboundDraft, TurnEvent } from "../../domain/src/message.js";

export type TurnState = {
  lastSequence: number;
  assembledText: string;
  sentText: string;
  sentArtifactKeys: Set<string>;
  lastEventAt: string | null;
  lastPartialFlushAtMs: number | null;
  completed: boolean;
  finalFlushed: boolean;
};

export class TurnOutputTracker {
  private readonly turnStates = new Map<string, TurnState>();

  getOrCreate(event: TurnEvent): TurnState {
    const key = buildTurnStateKey(event.sessionKey, event.turnId);
    const existing = this.turnStates.get(key);
    if (existing) {
      return existing;
    }

    const created = createTurnState();
    this.turnStates.set(key, created);
    return created;
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

function createTurnState(): TurnState {
  return {
    lastSequence: 0,
    assembledText: "",
    sentText: "",
    sentArtifactKeys: new Set<string>(),
    lastEventAt: null,
    lastPartialFlushAtMs: null,
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

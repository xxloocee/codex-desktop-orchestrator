import type { MediaArtifact, OutboundDraft } from "../../domain/src/message.js";
import {
  buildMediaArtifactFromReference,
  parseQqMediaSegments
} from "../../adapters/qq/src/qq-media-parser.js";

export function enrichQqOutboundDraft(draft: OutboundDraft): OutboundDraft {
  const segments = parseQqMediaSegments(draft.text);
  const parsedArtifacts = segments
    .filter((segment) => segment.type === "media")
    .map((segment) => buildMediaArtifactFromReference(segment.reference));
  const mergedArtifacts = dedupeArtifacts([
    ...(draft.mediaArtifacts ?? []),
    ...parsedArtifacts
  ]);
  const textWithoutMediaTags = segments
    .filter((segment) => segment.type === "text")
    .map((segment) => segment.text)
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (mergedArtifacts.length === 0) {
    return draft;
  }

  return {
    ...draft,
    text: textWithoutMediaTags,
    mediaArtifacts: mergedArtifacts
  };
}

function dedupeArtifacts(artifacts: MediaArtifact[]): MediaArtifact[] {
  const seen = new Set<string>();
  const deduped: MediaArtifact[] = [];

  for (const artifact of artifacts) {
    const key = buildArtifactKey(artifact);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(artifact);
  }

  return deduped;
}

function buildArtifactKey(artifact: MediaArtifact): string {
  return [
    artifact.kind,
    artifact.localPath || "",
    artifact.sourceUrl || "",
    artifact.originalName || ""
  ].join("::");
}

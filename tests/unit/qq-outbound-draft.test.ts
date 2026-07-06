import { describe, expect, it } from "vitest";
import { MediaArtifactKind } from "../../packages/domain/src/message.js";
import { enrichQqOutboundDraft } from "../../packages/orchestrator/src/qq-outbound-draft.js";

describe("qq outbound draft", () => {
  it("adds media artifacts parsed from qqmedia declarations into the outbound draft", () => {
    const draft = enrichQqOutboundDraft({
      draftId: "draft-qq-outbound",
      sessionKey: "qqbot:default::qq:c2c:abc",
      text: "图片如下：\n<qqmedia>/tmp/cat.png</qqmedia>",
      createdAt: "2026-04-09T18:10:00.000Z"
    });

    expect(draft.mediaArtifacts).toEqual([
      expect.objectContaining({
        kind: MediaArtifactKind.Image,
        localPath: "/tmp/cat.png",
        sourceUrl: "/tmp/cat.png"
      })
    ]);
    expect(draft.text).toBe("图片如下：");
  });

  it("strips media-only qqmedia declarations from the visible text", () => {
    const draft = enrichQqOutboundDraft({
      draftId: "draft-qq-outbound-media-only",
      sessionKey: "qqbot:default::qq:c2c:abc",
      text: "<qqmedia>/tmp/cat.png</qqmedia>",
      createdAt: "2026-04-09T18:10:00.000Z"
    });

    expect(draft.text).toBe("");
    expect(draft.mediaArtifacts).toEqual([
      expect.objectContaining({
        kind: MediaArtifactKind.Image,
        localPath: "/tmp/cat.png"
      })
    ]);
  });

  it("preserves unsupported qqmedia declarations as visible text", () => {
    const draft = enrichQqOutboundDraft({
      draftId: "draft-qq-outbound-invalid",
      sessionKey: "qqbot:default::qq:c2c:abc",
      text: "说明：\n<qqmedia>not-a-media-reference</qqmedia>",
      createdAt: "2026-04-09T18:10:00.000Z"
    });

    expect(draft.text).toContain("<qqmedia>not-a-media-reference</qqmedia>");
    expect(draft.mediaArtifacts).toBeUndefined();
  });
});

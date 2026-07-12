import { describe, expect, it, vi } from "vitest";
import { CodeReviewCommandActions } from "../../apps/bridge-daemon/src/code-review-command-actions.js";
import type { InboundMessage, OutboundDraft } from "../../packages/domain/src/message.js";
import { BridgeSessionStatus, type BridgeSession } from "../../packages/domain/src/session.js";
import type { DesktopDriverPort } from "../../packages/ports/src/conversation.js";
import type { SessionStorePort } from "../../packages/ports/src/store.js";

function createMessage(): InboundMessage {
  return {
    messageId: "msg-1",
    accountKey: "qqbot:default",
    sessionKey: "qqbot:default::qq:c2c:OPENID123",
    peerKey: "qq:c2c:OPENID123",
    chatType: "c2c",
    senderId: "OPENID123",
    text: "/代码审查",
    receivedAt: "2026-04-09T16:00:00.000Z"
  };
}

function createSession(overrides: Partial<BridgeSession> = {}): BridgeSession {
  return {
    sessionKey: "qqbot:default::qq:c2c:OPENID123",
    accountKey: "qqbot:default",
    peerKey: "qq:c2c:OPENID123",
    chatType: "c2c",
    peerId: "OPENID123",
    codexThreadRef: "codex-thread:current",
    lastCodexTurnId: null,
    skillContextKey: null,
    conversationProvider: "codex-desktop",
    status: BridgeSessionStatus.Active,
    lastInboundAt: null,
    lastOutboundAt: null,
    lastError: null,
    ...overrides
  };
}

function createSessionStore(
  session: BridgeSession | null = createSession()
): Pick<SessionStorePort, "getSession" | "updateBinding" | "updateSessionStatus"> {
  return {
    getSession: vi.fn().mockResolvedValue(session),
    updateBinding: vi.fn().mockResolvedValue(undefined),
    updateSessionStatus: vi.fn().mockResolvedValue(undefined)
  };
}

function createDesktopDriver(
  drafts: OutboundDraft[] = []
): Pick<DesktopDriverPort, "openOrBindSession" | "sendUserMessage" | "collectAssistantReply"> {
  return {
    openOrBindSession: vi.fn().mockResolvedValue({
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      codexThreadRef: "codex-thread:current"
    }),
    sendUserMessage: vi.fn().mockResolvedValue(undefined),
    collectAssistantReply: vi.fn().mockResolvedValue(drafts)
  };
}

describe("CodeReviewCommandActions", () => {
  it("returns a control reply when Codex has no draft", async () => {
    const sessionStore = createSessionStore();
    const desktopDriver = createDesktopDriver();
    const actions = new CodeReviewCommandActions({ sessionStore, desktopDriver });
    const message = createMessage();

    const result = await actions.run(message);

    expect(result).toEqual({
      type: "control-reply",
      text: "已触发 Codex 代码审查。"
    });
    expect(desktopDriver.openOrBindSession).toHaveBeenCalledWith(
      message.sessionKey,
      {
        sessionKey: message.sessionKey,
        codexThreadRef: "codex-thread:current"
      }
    );
    expect(desktopDriver.sendUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({ codexThreadRef: "codex-thread:current" }),
      expect.objectContaining({ text: "/审查" })
    );
    expect(sessionStore.updateSessionStatus).toHaveBeenCalledWith(
      message.sessionKey,
      BridgeSessionStatus.Active,
      null
    );
  });

  it("returns drafts and defaults replyToMessageId to the inbound message id", async () => {
    const drafts: OutboundDraft[] = [
      {
        draftId: "review-draft-1",
        sessionKey: "qqbot:default::qq:c2c:OPENID123",
        text: "审查结果",
        createdAt: "2026-04-09T16:00:01.000Z"
      },
      {
        draftId: "review-draft-2",
        sessionKey: "qqbot:default::qq:c2c:OPENID123",
        text: "已有引用",
        createdAt: "2026-04-09T16:00:02.000Z",
        replyToMessageId: "existing-reply"
      }
    ];
    const actions = new CodeReviewCommandActions({
      sessionStore: createSessionStore(),
      desktopDriver: createDesktopDriver(drafts)
    });

    await expect(actions.run(createMessage())).resolves.toEqual({
      type: "drafts",
      drafts: [
        {
          ...drafts[0],
          replyToMessageId: "msg-1"
        },
        drafts[1]
      ]
    });
  });

  it("updates the stored binding when Codex binds a different thread", async () => {
    const sessionStore = createSessionStore();
    const desktopDriver = createDesktopDriver();
    vi.mocked(desktopDriver.openOrBindSession).mockResolvedValue({
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      codexThreadRef: "codex-thread:fresh"
    });
    const actions = new CodeReviewCommandActions({ sessionStore, desktopDriver });
    const message = createMessage();

    await actions.run(message);

    expect(sessionStore.updateBinding).toHaveBeenCalledWith(
      message.sessionKey,
      "codex-thread:fresh"
    );
  });

  it("does not update the stored binding when the thread is unchanged", async () => {
    const sessionStore = createSessionStore();
    const actions = new CodeReviewCommandActions({
      sessionStore,
      desktopDriver: createDesktopDriver()
    });

    await actions.run(createMessage());

    expect(sessionStore.updateBinding).not.toHaveBeenCalled();
  });

  it("does not pass a stale binding when the session is inactive", async () => {
    const sessionStore = createSessionStore(createSession({
      codexThreadRef: "codex-thread:stale",
      status: BridgeSessionStatus.NeedsRebind,
      lastError: "stale binding"
    }));
    const desktopDriver = createDesktopDriver();
    const actions = new CodeReviewCommandActions({ sessionStore, desktopDriver });
    const message = createMessage();

    await actions.run(message);

    expect(desktopDriver.openOrBindSession).toHaveBeenCalledWith(message.sessionKey, null);
  });
});

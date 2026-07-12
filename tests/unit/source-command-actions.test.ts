import { describe, expect, it, vi } from "vitest";
import { BridgeSessionStatus } from "../../packages/domain/src/session.js";
import type { SessionStorePort } from "../../packages/ports/src/store.js";
import { SourceCommandActions } from "../../apps/bridge-daemon/src/source-command-actions.js";

function createSessionStore(): Pick<SessionStorePort, "getSession" | "updateConversationProvider"> {
  return {
    getSession: vi.fn().mockResolvedValue(null),
    updateConversationProvider: vi.fn().mockResolvedValue(undefined)
  };
}

describe("SourceCommandActions", () => {
  it("switches to ChatGPT Desktop and requests a thread-list refresh", async () => {
    const sessionStore = createSessionStore();
    const actions = new SourceCommandActions({ sessionStore });

    const result = await actions.switchSource("session-1", "chatgpt");

    expect(sessionStore.updateConversationProvider).toHaveBeenCalledWith(
      "session-1",
      "chatgpt-desktop"
    );
    expect(result).toEqual({
      provider: "chatgpt-desktop",
      refreshChatgptThreads: true,
      text: "已切换对话源：ChatGPT Desktop\n后续消息将通过 ChatGPT Desktop 回复。"
    });
  });

  it("switches to Codex Desktop without refreshing ChatGPT threads", async () => {
    const sessionStore = createSessionStore();
    const actions = new SourceCommandActions({ sessionStore });

    const result = await actions.switchSource("session-1", "codex");

    expect(sessionStore.updateConversationProvider).toHaveBeenCalledWith(
      "session-1",
      "codex-desktop"
    );
    expect(result).toEqual({
      provider: "codex-desktop",
      refreshChatgptThreads: false,
      text: "已切换对话源：Codex Desktop\n后续消息将通过 Codex Desktop 回复。"
    });
  });

  it("builds current source text from the session provider", async () => {
    const sessionStore = createSessionStore();
    vi.mocked(sessionStore.getSession).mockResolvedValue({
      sessionKey: "session-1",
      accountKey: "qqbot:default",
      peerKey: "qq:c2c:OPENID123",
      chatType: "c2c",
      peerId: "OPENID123",
      codexThreadRef: null,
      lastCodexTurnId: null,
      skillContextKey: null,
      conversationProvider: "chatgpt-desktop",
      status: BridgeSessionStatus.Active,
      lastInboundAt: null,
      lastOutboundAt: null,
      lastError: null
    });
    const actions = new SourceCommandActions({ sessionStore });

    await expect(actions.buildCurrentSourceText("session-1")).resolves.toBe(
      "当前对话源：chatgpt-desktop\n切换：/source codex 或 /source chatgpt"
    );
  });

  it("shows the global default when the session has no source override", async () => {
    const sessionStore = createSessionStore();
    const actions = new SourceCommandActions({ sessionStore });

    await expect(actions.buildCurrentSourceText("session-1")).resolves.toBe(
      "当前对话源：codex-desktop（全局默认）\n切换：/source codex 或 /source chatgpt"
    );
  });
});

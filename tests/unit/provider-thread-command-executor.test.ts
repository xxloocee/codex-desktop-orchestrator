import { describe, expect, it, vi } from "vitest";
import { BridgeSessionStatus, type BridgeSession } from "../../packages/domain/src/session.js";
import { ProviderThreadCommandExecutor } from "../../apps/bridge-daemon/src/provider-thread-command-executor.js";

function createSession(provider: BridgeSession["conversationProvider"]): BridgeSession {
  return {
    sessionKey: "session-1",
    accountKey: "qqbot:default",
    peerKey: "qq:c2c:OPENID123",
    chatType: "c2c",
    peerId: "OPENID123",
    codexThreadRef: null,
    lastCodexTurnId: null,
    skillContextKey: null,
    conversationProvider: provider,
    status: BridgeSessionStatus.Active,
    lastInboundAt: null,
    lastOutboundAt: null,
    lastError: null
  };
}

function createExecutor() {
  const chatgptCommandActions = {
    buildThreadsText: vi.fn().mockResolvedValue("chatgpt threads"),
    buildCurrentThreadText: vi.fn().mockReturnValue("chatgpt current"),
    useThread: vi.fn().mockResolvedValue("chatgpt use"),
    createThread: vi.fn().mockResolvedValue("chatgpt new")
  };
  const codexThreadCommandActions = {
    buildThreadsText: vi.fn().mockResolvedValue("codex threads"),
    buildCurrentThreadText: vi.fn().mockResolvedValue("codex current"),
    useThread: vi.fn().mockResolvedValue("codex use"),
    createThread: vi.fn().mockResolvedValue("codex new"),
    forkThread: vi.fn().mockResolvedValue("codex fork")
  };

  return {
    executor: new ProviderThreadCommandExecutor({
      chatgptCommandActions,
      codexThreadCommandActions
    }),
    chatgptCommandActions,
    codexThreadCommandActions
  };
}

describe("ProviderThreadCommandExecutor", () => {
  it("routes thread lists to Codex by default", async () => {
    const { executor, codexThreadCommandActions, chatgptCommandActions } = createExecutor();

    await expect(executor.buildThreadsText(createSession(null))).resolves.toBe("codex threads");

    expect(codexThreadCommandActions.buildThreadsText).toHaveBeenCalledWith(createSession(null));
    expect(chatgptCommandActions.buildThreadsText).not.toHaveBeenCalled();
  });

  it("routes thread lists to ChatGPT and consumes the refresh marker once", async () => {
    const { executor, chatgptCommandActions } = createExecutor();
    const session = createSession("chatgpt-desktop");

    executor.setChatgptThreadListRefresh("session-1", true);

    await expect(executor.buildThreadsText(session)).resolves.toBe("chatgpt threads");
    await expect(executor.buildThreadsText(session)).resolves.toBe("chatgpt threads");

    expect(chatgptCommandActions.buildThreadsText).toHaveBeenNthCalledWith(1, session, true);
    expect(chatgptCommandActions.buildThreadsText).toHaveBeenNthCalledWith(2, session, false);
  });

  it("routes use/new/fork thread commands by provider", async () => {
    const { executor, chatgptCommandActions, codexThreadCommandActions } = createExecutor();
    const chatgptSession = createSession("chatgpt-desktop");
    const codexSession = createSession("codex-desktop");

    await expect(executor.useThread("session-1", chatgptSession, 2)).resolves.toBe("chatgpt use");
    await expect(executor.createThread("session-1", chatgptSession, "New")).resolves.toBe("chatgpt new");
    await expect(executor.forkThread("session-1", chatgptSession, "Fork")).resolves.toBe("chatgpt new");
    await expect(executor.useThread("session-1", codexSession, 2)).resolves.toBe("codex use");
    await expect(executor.createThread("session-1", codexSession, "New")).resolves.toBe("codex new");
    await expect(executor.forkThread("session-1", codexSession, "Fork")).resolves.toBe("codex fork");

    expect(chatgptCommandActions.useThread).toHaveBeenCalledWith("session-1", 2, "thread-command");
    expect(chatgptCommandActions.createThread).toHaveBeenCalledTimes(2);
    expect(codexThreadCommandActions.useThread).toHaveBeenCalledWith("session-1", 2);
    expect(codexThreadCommandActions.createThread).toHaveBeenCalledWith("session-1", "New");
    expect(codexThreadCommandActions.forkThread).toHaveBeenCalledWith("session-1", "Fork");
  });

  it("uses the explicit ChatGPT command mode for /cgpt use", async () => {
    const { executor, chatgptCommandActions } = createExecutor();

    await expect(executor.useChatgptThread("session-1", 3)).resolves.toBe("chatgpt use");

    expect(chatgptCommandActions.useThread).toHaveBeenCalledWith("session-1", 3, "cgpt-command");
  });
});

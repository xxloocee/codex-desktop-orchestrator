import { describe, expect, it, vi } from "vitest";
import { BridgeSessionStatus, type BridgeSession } from "../../packages/domain/src/session.js";
import type { SessionStorePort } from "../../packages/ports/src/store.js";
import { ChatgptCommandActions } from "../../apps/bridge-daemon/src/chatgpt-command-actions.js";

vi.mock("../../packages/adapters/chatgpt-desktop/src/ax-client.js", () => ({
  ensureAppVisible: vi.fn()
}));

function createSession(): BridgeSession {
  return {
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
  };
}

function createSessionStore(): Pick<SessionStorePort, "updateConversationProvider" | "updateSessionStatus"> {
  return {
    updateConversationProvider: vi.fn().mockResolvedValue(undefined),
    updateSessionStatus: vi.fn().mockResolvedValue(undefined)
  };
}

function createChatgptDriver() {
  return {
    getSessionThreadRef: vi.fn().mockReturnValue("家庭照片"),
    getCurrentThreadTitle: vi.fn().mockReturnValue(null),
    listChats: vi.fn().mockReturnValue([
      { index: 1, title: "家庭照片", windowTitle: null },
      { index: 2, title: "产品海报", windowTitle: null }
    ]),
    switchToChat: vi.fn().mockReturnValue(true),
    markSwitched: vi.fn(),
    newChat: vi.fn()
  };
}

describe("ChatgptCommandActions", () => {
  it("builds the ChatGPT thread list and marks the current session thread", async () => {
    const actions = new ChatgptCommandActions({
      chatgptDriver: createChatgptDriver() as never,
      sessionStore: createSessionStore()
    });

    await expect(actions.buildThreadsText(createSession(), false)).resolves.toContain(
      "| 👉🏻 1 | 家庭照片 |"
    );
  });

  it("refreshes the ChatGPT thread list when requested", async () => {
    const driver = createChatgptDriver();
    const actions = new ChatgptCommandActions({
      chatgptDriver: driver as never,
      sessionStore: createSessionStore()
    });

    await actions.buildThreadsText(createSession(), true);

    expect(driver.listChats).toHaveBeenCalledTimes(2);
    expect(driver.listChats).toHaveBeenNthCalledWith(1, 20);
    expect(driver.listChats).toHaveBeenNthCalledWith(2, 20);
  });

  it("switches ChatGPT thread and persists the ChatGPT source", async () => {
    const driver = createChatgptDriver();
    const sessionStore = createSessionStore();
    const actions = new ChatgptCommandActions({
      chatgptDriver: driver as never,
      sessionStore
    });

    await expect(actions.useThread("session-1", 2, "thread-command")).resolves.toBe(
      "已切换到 ChatGPT 对话：产品海报\n下次消息将继续该对话。"
    );
    expect(driver.switchToChat).toHaveBeenCalledWith("产品海报");
    expect(driver.markSwitched).toHaveBeenCalledWith("session-1", "产品海报");
    expect(sessionStore.updateConversationProvider).toHaveBeenCalledWith(
      "session-1",
      "chatgpt-desktop"
    );
    expect(sessionStore.updateSessionStatus).toHaveBeenCalledWith(
      "session-1",
      BridgeSessionStatus.Active,
      null
    );
  });

  it("keeps command-specific missing-index text", async () => {
    const driver = createChatgptDriver();
    const actions = new ChatgptCommandActions({
      chatgptDriver: driver as never,
      sessionStore: createSessionStore()
    });

    await expect(actions.useThread("session-1", 3, "cgpt-command")).resolves.toBe(
      "没有第 3 条对话，请先发 /cgpt 查看列表。"
    );
    await expect(actions.useThread("session-1", 3, "thread-command")).resolves.toBe(
      "没有第 3 条 ChatGPT 对话，请先发 /threads 查看列表。"
    );
  });

  it("creates a new ChatGPT thread and persists the ChatGPT source", async () => {
    const driver = createChatgptDriver();
    const sessionStore = createSessionStore();
    const actions = new ChatgptCommandActions({
      chatgptDriver: driver as never,
      sessionStore
    });

    await expect(actions.createThread("session-1", createSession())).resolves.toBe(
      "已为本会话新建 ChatGPT 对话，下条消息将从新对话开始。"
    );
    expect(driver.newChat).toHaveBeenCalledWith("session-1");
    expect(sessionStore.updateConversationProvider).toHaveBeenCalledWith(
      "session-1",
      "chatgpt-desktop"
    );
  });
});

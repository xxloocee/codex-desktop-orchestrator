import { describe, expect, it, vi } from "vitest";
import { DesktopDriverError } from "../../packages/domain/src/driver.js";
import { BridgeSessionStatus, type BridgeSession } from "../../packages/domain/src/session.js";
import type { ConversationEntry } from "../../packages/domain/src/message.js";
import type { DesktopDriverPort } from "../../packages/ports/src/conversation.js";
import type { SessionStorePort, TranscriptStorePort } from "../../packages/ports/src/store.js";
import { CodexThreadCommandActions } from "../../apps/bridge-daemon/src/codex-thread-command-actions.js";

const sessionKey = "qqbot:default::qq:c2c:OPENID123";

function createSession(overrides: Partial<BridgeSession> = {}): BridgeSession {
  return {
    sessionKey,
    accountKey: "qqbot:default",
    peerKey: "qq:c2c:OPENID123",
    chatType: "c2c",
    peerId: "OPENID123",
    codexThreadRef: null,
    lastCodexTurnId: null,
    skillContextKey: null,
    conversationProvider: null,
    status: BridgeSessionStatus.Active,
    lastInboundAt: null,
    lastOutboundAt: null,
    lastError: null,
    ...overrides
  };
}

function createDriver(
  overrides: Partial<Pick<DesktopDriverPort, "listRecentThreads" | "switchToThread" | "createThread">> = {}
) {
  return {
    listRecentThreads: vi.fn().mockResolvedValue([
      {
        index: 1,
        title: "线程 A",
        projectName: "bridge",
        relativeTime: "2 小时",
        isCurrent: true,
        threadRef: "codex-thread:page-1:aaa"
      },
      {
        index: 2,
        title: "线程 B",
        projectName: "Desktop",
        relativeTime: "1 天",
        isCurrent: false,
        threadRef: "codex-thread:page-1:bbb"
      }
    ]),
    switchToThread: vi.fn().mockResolvedValue({
      sessionKey,
      codexThreadRef: "codex-thread:page-1:bbb"
    }),
    createThread: vi.fn().mockResolvedValue({
      sessionKey,
      codexThreadRef: "codex-thread:page-1:new"
    }),
    ...overrides
  };
}

function createSessionStore() {
  return {
    updateBinding: vi.fn().mockResolvedValue(undefined),
    updateSessionStatus: vi.fn().mockResolvedValue(undefined),
    updateSkillContextKey: vi.fn().mockResolvedValue(undefined),
    updateConversationProvider: vi.fn().mockResolvedValue(undefined)
  };
}

function createTranscriptStore(entries: ConversationEntry[] = []) {
  return {
    listRecentConversation: vi.fn().mockResolvedValue(entries)
  };
}

function createActions(input: {
  driver?: ReturnType<typeof createDriver>;
  sessionStore?: ReturnType<typeof createSessionStore>;
  transcriptStore?: ReturnType<typeof createTranscriptStore>;
  projectAliases?: ConstructorParameters<typeof CodexThreadCommandActions>[0]["projectAliases"];
} = {}) {
  const driver = input.driver ?? createDriver();
  const sessionStore = input.sessionStore ?? createSessionStore();
  const transcriptStore = input.transcriptStore ?? createTranscriptStore([
    {
      direction: "inbound",
      text: "用户问题 1",
      createdAt: "2026-04-09T15:58:00.000Z"
    },
    {
      direction: "outbound",
      text: "助手回答 1",
      createdAt: "2026-04-09T15:58:10.000Z"
    }
  ]);
  const actions = new CodexThreadCommandActions({
    desktopDriver: driver,
    sessionStore,
    transcriptStore,
    projectAliases: input.projectAliases
  });

  return { actions, driver, sessionStore, transcriptStore };
}

describe("codex thread command actions", () => {
  it("lists recent Codex threads", async () => {
    const { actions, driver } = createActions();

    const text = await actions.buildThreadsText(createSession());

    expect(driver.listRecentThreads).toHaveBeenCalledWith(20);
    expect(text).toContain("| 序号 | 项目 | 线程标题 | 最近活动 |");
    expect(text).toContain("| 👉🏻 1 | bridge | 线程 A | 2 小时 |");
  });

  it("shows the current bound thread", async () => {
    const { actions } = createActions();

    const text = await actions.buildCurrentThreadText(createSession({
      codexThreadRef: "codex-thread:page-1:bbb"
    }));

    expect(text).toBe("当前绑定线程：线程 B\n项目：Desktop\n最近活动：1 天");
  });

  it("switches to a listed thread", async () => {
    const { actions, driver, sessionStore } = createActions();

    const text = await actions.useThread(sessionKey, 2);

    expect(driver.switchToThread).toHaveBeenCalledWith(sessionKey, "codex-thread:page-1:bbb");
    expect(sessionStore.updateBinding).toHaveBeenCalledWith(sessionKey, "codex-thread:page-1:bbb");
    expect(sessionStore.updateSessionStatus).toHaveBeenCalledWith(
      sessionKey,
      BridgeSessionStatus.Active,
      null
    );
    expect(sessionStore.updateSkillContextKey).toHaveBeenCalledWith(sessionKey, null);
    expect(text).toContain("已切换到线程：线程 B");
    expect(text).toContain("绑定标识：codex-thread:page-1:bbb");
  });

  it("does not switch when the requested index is missing", async () => {
    const { actions, driver, sessionStore } = createActions();

    const text = await actions.useThread(sessionKey, 3);

    expect(driver.switchToThread).not.toHaveBeenCalled();
    expect(sessionStore.updateBinding).not.toHaveBeenCalled();
    expect(text).toBe("没有第 3 个线程。请先发送 /threads 查看列表。");
  });

  it("returns the sidebar refresh guidance when switch fails with session_not_found", async () => {
    const driver = createDriver({
      switchToThread: vi.fn().mockRejectedValue(
        new DesktopDriverError("Codex desktop thread switch failed: thread_not_found", "session_not_found")
      )
    });
    const { actions, sessionStore } = createActions({ driver });

    const text = await actions.useThread(sessionKey, 2);

    expect(sessionStore.updateBinding).not.toHaveBeenCalled();
    expect(text).toBe("切换失败：没有在当前 Codex 侧边栏里找到这个线程。\n请先发送 /t 刷新列表后重试。");
  });

  it("creates a new Codex thread", async () => {
    const { actions, driver, sessionStore } = createActions();

    const text = await actions.createThread(sessionKey, "新线程");

    expect(driver.createThread).toHaveBeenCalledWith(
      sessionKey,
      expect.stringContaining("线程标题：新线程")
    );
    expect(sessionStore.updateBinding).toHaveBeenCalledWith(sessionKey, "codex-thread:page-1:new");
    expect(sessionStore.updateSessionStatus).toHaveBeenCalledWith(
      sessionKey,
      BridgeSessionStatus.Active,
      null
    );
    expect(text).toBe("已创建并切换到新线程：新线程");
  });

  it("creates a Codex thread in a configured project cwd", async () => {
    const { actions, driver, sessionStore } = createActions({
      projectAliases: {
        Bridge: {
          cwd: "D:/Project/github/qq-codex-bridge",
          label: "QQ Codex Bridge"
        }
      }
    });

    const text = await actions.createProjectThread(sessionKey, "bridge", "fix startup");

    expect(driver.createThread).toHaveBeenCalledWith(
      sessionKey,
      expect.stringContaining("Task:\nfix startup"),
      {
        cwd: "D:/Project/github/qq-codex-bridge"
      }
    );
    expect(sessionStore.updateConversationProvider).toHaveBeenCalledWith(sessionKey, "codex-desktop");
    expect(sessionStore.updateBinding).toHaveBeenCalledWith(sessionKey, "codex-thread:page-1:new");
    expect(sessionStore.updateSessionStatus).toHaveBeenCalledWith(
      sessionKey,
      BridgeSessionStatus.Active,
      null
    );
    expect(sessionStore.updateSkillContextKey).toHaveBeenCalledWith(sessionKey, null);
    expect(text).toContain("Created Codex thread for project: QQ Codex Bridge");
    expect(text).toContain("Alias: bridge");
  });

  it("returns unknown project text when alias is not configured", async () => {
    const { actions, driver } = createActions({
      projectAliases: {
        bridge: {
          cwd: "D:/Project/github/qq-codex-bridge"
        }
      }
    });

    const text = await actions.createProjectThread(sessionKey, "missing", "fix startup");

    expect(driver.createThread).not.toHaveBeenCalled();
    expect(text).toContain("Unknown project alias: missing");
    expect(text).toContain("Use /aliases");
  });

  it("forks a thread with recent QQ conversation context", async () => {
    const { actions, driver, sessionStore, transcriptStore } = createActions();

    const text = await actions.forkThread(sessionKey, "新专题");

    expect(transcriptStore.listRecentConversation).toHaveBeenCalledWith(sessionKey, 8);
    expect(driver.createThread).toHaveBeenCalledWith(
      sessionKey,
      expect.stringContaining("线程标题：新专题")
    );
    expect(driver.createThread).toHaveBeenCalledWith(
      sessionKey,
      expect.stringContaining("- 用户：用户问题 1")
    );
    expect(driver.createThread).toHaveBeenCalledWith(
      sessionKey,
      expect.stringContaining("- 助手：助手回答 1")
    );
    expect(sessionStore.updateBinding).toHaveBeenCalledWith(sessionKey, "codex-thread:page-1:new");
    expect(sessionStore.updateSessionStatus).toHaveBeenCalledWith(
      sessionKey,
      BridgeSessionStatus.Active,
      null
    );
    expect(text).toBe("已根据最近几轮对话 fork 新线程：新专题");
  });
});

import { describe, expect, it, vi } from "vitest";
import { BridgeSessionStatus } from "../../packages/domain/src/session.js";
import { BridgeTurnStatus } from "../../packages/domain/src/turn.js";
import { DesktopDriverError } from "../../packages/domain/src/driver.js";
import { DeliveryJobStatus, type InboundMessage, type OutboundDraft } from "../../packages/domain/src/message.js";
import type { DesktopDriverPort } from "../../packages/ports/src/conversation.js";
import type { QqEgressPort } from "../../packages/ports/src/qq.js";
import type {
  DeliveryJobStorePort,
  SessionStorePort,
  TranscriptStorePort,
  TurnStorePort
} from "../../packages/ports/src/store.js";
import { ThreadCommandHandler } from "../../apps/bridge-daemon/src/thread-command-handler.js";

vi.mock("../../packages/adapters/chatgpt-desktop/src/ax-client.js", () => ({
  ensureAppVisible: vi.fn()
}));

function createPrivateMessage(text: string): InboundMessage {
  return {
    messageId: "msg-1",
    accountKey: "qqbot:default",
    sessionKey: "qqbot:default::qq:c2c:OPENID123",
    peerKey: "qq:c2c:OPENID123",
    chatType: "c2c",
    senderId: "OPENID123",
    text,
    receivedAt: "2026-04-09T16:00:00.000Z"
  };
}

function createSessionStore(): SessionStorePort {
  return {
    getSession: vi.fn().mockResolvedValue({
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
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
      lastError: null
    }),
    createSession: vi.fn().mockResolvedValue(undefined),
    updateSessionStatus: vi.fn().mockResolvedValue(undefined),
    updateBinding: vi.fn().mockResolvedValue(undefined),
    updateLastCodexTurnId: vi.fn().mockResolvedValue(undefined),
    updateSkillContextKey: vi.fn().mockResolvedValue(undefined),
    updateConversationProvider: vi.fn().mockResolvedValue(undefined),
    withSessionLock: vi.fn(async (_sessionKey, work) => work())
  };
}

function createTranscriptStore(): TranscriptStorePort {
  return {
    recordInbound: vi.fn().mockResolvedValue(undefined),
    recordOutbound: vi.fn().mockResolvedValue(undefined),
    hasInbound: vi.fn().mockResolvedValue(false),
    listRecentConversation: vi.fn().mockResolvedValue([
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
    ])
  };
}

function createTurnStore(): TurnStorePort {
  return {
    createTurn: vi.fn().mockResolvedValue(undefined),
    attachCodexTurn: vi.fn().mockResolvedValue(undefined),
    updateCodexThreadRef: vi.fn().mockResolvedValue(undefined),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    updateDeadline: vi.fn().mockResolvedValue(undefined),
    recordTurnEvent: vi.fn().mockResolvedValue(undefined),
    addDeliveredText: vi.fn().mockResolvedValue(undefined),
    getTurn: vi.fn().mockResolvedValue(null),
    getTurnByCodexTurn: vi.fn().mockResolvedValue(null),
    getCurrentTurn: vi.fn().mockResolvedValue({
      turnId: "bridge-turn-1",
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      codexThreadRef: "codex-app-thread:thread-1",
      codexTurnRef: "codex-turn-1",
      qqMessageId: "msg-1",
      status: BridgeTurnStatus.Running,
      startedAt: "2026-07-01T10:00:00.000Z",
      updatedAt: new Date().toISOString(),
      deadlineAt: null,
      lastEventAt: null,
      lastToolName: null,
      lastError: null,
      deliveredTextLength: 0
    }),
    listRecentTurns: vi.fn().mockResolvedValue([
      {
        turnId: "bridge-turn-1",
        sessionKey: "qqbot:default::qq:c2c:OPENID123",
        codexThreadRef: "codex-app-thread:thread-1",
        codexTurnRef: "codex-turn-1",
        qqMessageId: "msg-1",
        status: BridgeTurnStatus.Completed,
        startedAt: "2026-07-01T10:00:00.000Z",
        updatedAt: new Date().toISOString(),
        deadlineAt: null,
        lastEventAt: "2026-07-01T10:00:10.000Z",
        lastToolName: null,
        lastError: null,
        deliveredTextLength: 42
      }
    ])
  };
}

function createDeliveryJobStore(): DeliveryJobStorePort {
  return {
    claimDueJobs: vi.fn().mockResolvedValue([]),
    markDelivered: vi.fn().mockResolvedValue(undefined),
    markAttemptFailed: vi.fn().mockResolvedValue(undefined),
    recoverInFlight: vi.fn().mockResolvedValue(0),
    listJobs: vi.fn().mockResolvedValue([
      {
        jobId: "draft-pending-1",
        sessionKey: "qqbot:default::qq:c2c:OPENID123",
        status: DeliveryJobStatus.Pending,
        attemptCount: 1,
        payload: {
          draftId: "draft-pending-1",
          sessionKey: "qqbot:default::qq:c2c:OPENID123",
          text: "queued reply",
          createdAt: "2026-07-01T10:00:00.000Z"
        },
        lastError: "network down",
        createdAt: "2026-07-01T10:00:00.000Z",
        updatedAt: "2026-07-01T10:00:05.000Z",
        nextAttemptAt: "2026-07-01T10:01:05.000Z",
        deliveredAt: null,
        providerMessageId: null
      }
    ])
  };
}

function createDriver(
  overrides: Partial<
    DesktopDriverPort & {
      getQuotaSummary: () => Promise<string | null>;
    }
  > = {}
): DesktopDriverPort & {
  getQuotaSummary: () => Promise<string | null>;
} {
  return {
    ensureAppReady: vi.fn().mockResolvedValue(undefined),
    getControlState: vi.fn().mockResolvedValue({
      model: "GPT-5.4",
      reasoningEffort: "高",
      workspace: "本地",
      branch: "codex/codex-desktop-orchestrator",
      permissionMode: "完全访问权限",
      quotaSummary: null
    }),
    switchModel: vi.fn().mockResolvedValue({
      model: "GPT-5.4",
      reasoningEffort: "高",
      workspace: "本地",
      branch: "codex/codex-desktop-orchestrator",
      permissionMode: "完全访问权限",
      quotaSummary: null
    }),
    getQuotaSummary: vi
      .fn()
      .mockResolvedValue("5 小时 22%（01:56 重置）\n1 周 25%（4月17日 重置）"),
    openOrBindSession: vi.fn(),
    sendUserMessage: vi.fn(),
    collectAssistantReply: vi.fn(),
    markSessionBroken: vi.fn(),
    listRecentThreads: vi.fn().mockResolvedValue([
      {
        index: 1,
        title: "线程 A",
        projectName: "skills",
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
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      codexThreadRef: "codex-thread:page-1:bbb"
    }),
    createThread: vi.fn().mockResolvedValue({
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      codexThreadRef: "codex-thread:page-1:new"
    }),
    ...overrides
  } as unknown as DesktopDriverPort;
}

function createEgress(): QqEgressPort {
  return {
    deliver: vi.fn().mockResolvedValue({
      jobId: "job-1",
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      providerMessageId: null,
      deliveredAt: "2026-04-09T16:00:00.000Z"
    })
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

describe("thread command handler", () => {
  it("lists recent threads for /threads in private chat", async () => {
    const sessionStore = createSessionStore();
    const transcriptStore = createTranscriptStore();
    const desktopDriver = createDriver();
    const qqEgress = createEgress();
    const handler = new ThreadCommandHandler({
      sessionStore,
      transcriptStore,
      desktopDriver,
      qqEgress
    });

    await expect(handler.handleIfCommand(createPrivateMessage("/threads"))).resolves.toBe(true);
    expect(desktopDriver.listRecentThreads).toHaveBeenCalledWith(20);
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "qqbot:default::qq:c2c:OPENID123",
        replyToMessageId: "msg-1",
        text: expect.stringContaining("| 序号 | 项目 | 线程标题 | 最近活动 |")
      })
    );
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("| 👉🏻 1 | skills | 线程 A | 2 小时 |")
      })
    );
  });

  it("marks the bound app-server thread in /threads even when it is not the desktop current thread", async () => {
    const sessionStore = createSessionStore();
    vi.mocked(sessionStore.getSession).mockResolvedValue({
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      accountKey: "qqbot:default",
      peerKey: "qq:c2c:OPENID123",
      chatType: "c2c",
      peerId: "OPENID123",
      codexThreadRef: "codex-app-thread:thread-b:old-title",
      lastCodexTurnId: null,
      skillContextKey: null,
      conversationProvider: null,
      status: BridgeSessionStatus.Active,
      lastInboundAt: null,
      lastOutboundAt: null,
      lastError: null
    });
    const transcriptStore = createTranscriptStore();
    const desktopDriver = createDriver({
      listRecentThreads: vi.fn().mockResolvedValue([
        {
          index: 1,
          title: "线程 A",
          projectName: "skills",
          relativeTime: "2 小时",
          isCurrent: false,
          threadRef: "codex-app-thread:thread-a:new-title"
        },
        {
          index: 2,
          title: "线程 B",
          projectName: "Desktop",
          relativeTime: "1 天",
          isCurrent: false,
          threadRef: "codex-app-thread:thread-b:new-title"
        }
      ])
    });
    const qqEgress = createEgress();
    const handler = new ThreadCommandHandler({
      sessionStore,
      transcriptStore,
      desktopDriver,
      qqEgress
    });

    await expect(handler.handleIfCommand(createPrivateMessage("/t"))).resolves.toBe(true);

    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("| 👉🏻 2 | Desktop | 线程 B | 1 天 |")
      })
    );
  });

  it("switches binding for /thread use <index>", async () => {
    const sessionStore = createSessionStore();
    const transcriptStore = createTranscriptStore();
    const desktopDriver = createDriver();
    const qqEgress = createEgress();
    const handler = new ThreadCommandHandler({
      sessionStore,
      transcriptStore,
      desktopDriver,
      qqEgress
    });

    await expect(handler.handleIfCommand(createPrivateMessage("/thread use 2"))).resolves.toBe(true);
    expect(desktopDriver.switchToThread).toHaveBeenCalledWith(
      "qqbot:default::qq:c2c:OPENID123",
      "codex-thread:page-1:bbb"
    );
    expect(sessionStore.updateBinding).toHaveBeenCalledWith(
      "qqbot:default::qq:c2c:OPENID123",
      "codex-thread:page-1:bbb"
    );
    expect(sessionStore.updateSessionStatus).toHaveBeenCalledWith(
      "qqbot:default::qq:c2c:OPENID123",
      BridgeSessionStatus.Active,
      null
    );
    expect(sessionStore.updateSkillContextKey).toHaveBeenCalledWith(
      "qqbot:default::qq:c2c:OPENID123",
      null
    );
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("绑定标识：codex-thread:page-1:bbb")
      })
    );
  });

  it("returns a friendly reply when switching to a sidebar thread fails", async () => {
    const sessionStore = createSessionStore();
    const transcriptStore = createTranscriptStore();
    const desktopDriver = createDriver({
      switchToThread: vi.fn().mockRejectedValue(
        new DesktopDriverError("Codex desktop thread switch failed: thread_not_found", "session_not_found")
      )
    });
    const qqEgress = createEgress();
    const handler = new ThreadCommandHandler({
      sessionStore,
      transcriptStore,
      desktopDriver,
      qqEgress
    });

    await expect(handler.handleIfCommand(createPrivateMessage("/thread use 2"))).resolves.toBe(true);
    expect(sessionStore.updateBinding).not.toHaveBeenCalled();
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("切换失败：没有在当前 Codex 侧边栏里找到这个线程。")
      })
    );
  });

  it("supports shorthand thread commands", async () => {
    const sessionStore = createSessionStore();
    const transcriptStore = createTranscriptStore();
    const desktopDriver = createDriver();
    const qqEgress = createEgress();
    const handler = new ThreadCommandHandler({
      sessionStore,
      transcriptStore,
      desktopDriver,
      qqEgress
    });

    await expect(handler.handleIfCommand(createPrivateMessage("/t"))).resolves.toBe(true);
    await expect(handler.handleIfCommand(createPrivateMessage("/tc"))).resolves.toBe(true);
    await expect(handler.handleIfCommand(createPrivateMessage("/tu 2"))).resolves.toBe(true);
    await expect(handler.handleIfCommand(createPrivateMessage("/tn 快捷新线程"))).resolves.toBe(true);
    await expect(handler.handleIfCommand(createPrivateMessage("/tf 快捷分叉"))).resolves.toBe(true);

    expect(desktopDriver.listRecentThreads).toHaveBeenCalledWith(20);
    expect(desktopDriver.switchToThread).toHaveBeenCalledWith(
      "qqbot:default::qq:c2c:OPENID123",
      "codex-thread:page-1:bbb"
    );
    expect(desktopDriver.createThread).toHaveBeenCalledWith(
      "qqbot:default::qq:c2c:OPENID123",
      expect.stringContaining("线程标题：快捷新线程")
    );
    expect(desktopDriver.createThread).toHaveBeenCalledWith(
      "qqbot:default::qq:c2c:OPENID123",
      expect.stringContaining("线程标题：快捷分叉")
    );
  });

  it("creates a Codex thread and restores active status for /thread new", async () => {
    const sessionStore = createSessionStore();
    vi.mocked(sessionStore.getSession).mockResolvedValue({
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      accountKey: "qqbot:default",
      peerKey: "qq:c2c:OPENID123",
      chatType: "c2c",
      peerId: "OPENID123",
      codexThreadRef: null,
      lastCodexTurnId: null,
      skillContextKey: null,
      conversationProvider: "codex-desktop",
      status: BridgeSessionStatus.NeedsRebind,
      lastInboundAt: null,
      lastOutboundAt: null,
      lastError: "stale binding"
    });
    const transcriptStore = createTranscriptStore();
    const desktopDriver = createDriver();
    const qqEgress = createEgress();
    const handler = new ThreadCommandHandler({
      sessionStore,
      transcriptStore,
      desktopDriver,
      qqEgress
    });

    await expect(handler.handleIfCommand(createPrivateMessage("/thread new 新线程"))).resolves.toBe(true);

    expect(sessionStore.updateBinding).toHaveBeenCalledWith(
      "qqbot:default::qq:c2c:OPENID123",
      "codex-thread:page-1:new"
    );
    expect(sessionStore.updateSessionStatus).toHaveBeenCalledWith(
      "qqbot:default::qq:c2c:OPENID123",
      BridgeSessionStatus.Active,
      null
    );
  });

  it("shows help for /help", async () => {
    const sessionStore = createSessionStore();
    const transcriptStore = createTranscriptStore();
    const desktopDriver = createDriver();
    const qqEgress = createEgress();
    const handler = new ThreadCommandHandler({
      sessionStore,
      transcriptStore,
      desktopDriver,
      qqEgress
    });

    await expect(handler.handleIfCommand(createPrivateMessage("/help"))).resolves.toBe(true);

    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("| 查看 Codex 最近线程 | `/threads` | `/t` |")
      })
    );
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("| 查看项目/别名 | `/projects`、`/aliases` | - |")
      })
    );
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("| 查看/切换 ChatGPT 对话 | `/cgpt`、`/cgpt use <序号>` | - |")
      })
    );
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("建议先用 `/source` 确认当前对话源")
      })
    );
  });

  it("shows ChatGPT-focused help when the current source is chatgpt", async () => {
    const sessionStore = createSessionStore();
    vi.mocked(sessionStore.getSession).mockResolvedValue({
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
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
    const transcriptStore = createTranscriptStore();
    const desktopDriver = createDriver();
    const qqEgress = createEgress();
    const handler = new ThreadCommandHandler({
      sessionStore,
      transcriptStore,
      desktopDriver,
      qqEgress
    });

    await expect(handler.handleIfCommand(createPrivateMessage("/help"))).resolves.toBe(true);

    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("快捷命令（当前源：ChatGPT Desktop）")
      })
    );
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("| 查看 ChatGPT 最近对话 | `/threads` | `/t` |")
      })
    );
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("| 新建 ChatGPT 对话 | `/cgpt new` | - |")
      })
    );
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.not.stringContaining("| 查看当前模型 | `/model` | `/m` |")
      })
    );
  });

  it("shows current account and source status for /accounts", async () => {
    const sessionStore = createSessionStore();
    vi.mocked(sessionStore.getSession).mockResolvedValue({
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
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
    const transcriptStore = createTranscriptStore();
    const desktopDriver = createDriver();
    const qqEgress = createEgress();
    const handler = new ThreadCommandHandler({
      sessionStore,
      transcriptStore,
      desktopDriver,
      qqEgress,
      accountKeys: ["qqbot:default", "qqbot:shop", "weixin:main"]
    });

    await expect(handler.handleIfCommand(createPrivateMessage("/accounts"))).resolves.toBe(true);

    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("| 当前账号 | qqbot:default |")
      })
    );
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("| 当前对话源 | chatgpt-desktop |")
      })
    );
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("qqbot:shop")
      })
    );
  });

  it("shows the current tracked task for /task current", async () => {
    const sessionStore = createSessionStore();
    const transcriptStore = createTranscriptStore();
    const desktopDriver = createDriver();
    const qqEgress = createEgress();
    const turnStore = createTurnStore();
    const handler = new ThreadCommandHandler({
      sessionStore,
      transcriptStore,
      turnStore,
      desktopDriver,
      qqEgress
    });

    await expect(handler.handleIfCommand(createPrivateMessage("/task current"))).resolves.toBe(true);

    expect(turnStore.getCurrentTurn).toHaveBeenCalledWith("qqbot:default::qq:c2c:OPENID123");
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Current task:")
      })
    );
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Status: running")
      })
    );
  });

  it("triggers Codex built-in review for /代码审查", async () => {
    const sessionStore = createSessionStore();
    const transcriptStore = createTranscriptStore();
    const reviewDraft: OutboundDraft = {
      draftId: "review-draft-1",
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      text: "审查结果",
      createdAt: "2026-04-09T16:00:01.000Z"
    };
    const desktopDriver = createDriver({
      openOrBindSession: vi.fn().mockResolvedValue({
        sessionKey: "qqbot:default::qq:c2c:OPENID123",
        codexThreadRef: "codex-thread:page-1:aaa"
      }),
      collectAssistantReply: vi.fn().mockResolvedValue([reviewDraft])
    });
    const qqEgress = createEgress();
    const handler = new ThreadCommandHandler({
      sessionStore,
      transcriptStore,
      desktopDriver,
      qqEgress
    });

    await expect(handler.handleIfCommand(createPrivateMessage("/代码审查"))).resolves.toBe(true);

    expect(desktopDriver.sendUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({ codexThreadRef: "codex-thread:page-1:aaa" }),
      expect.objectContaining({ text: "/审查" })
    );
    expect(sessionStore.updateSessionStatus).toHaveBeenCalledWith(
      "qqbot:default::qq:c2c:OPENID123",
      BridgeSessionStatus.Active,
      null
    );
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "审查结果",
        replyToMessageId: "msg-1"
      })
    );
  });

  it("does not reuse a stale binding for /代码审查 when the session needs rebind", async () => {
    const sessionStore = createSessionStore();
    vi.mocked(sessionStore.getSession).mockResolvedValue({
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      accountKey: "qqbot:default",
      peerKey: "qq:c2c:OPENID123",
      chatType: "c2c",
      peerId: "OPENID123",
      codexThreadRef: "codex-thread:stale",
      lastCodexTurnId: null,
      skillContextKey: null,
      conversationProvider: "codex-desktop",
      status: BridgeSessionStatus.NeedsRebind,
      lastInboundAt: null,
      lastOutboundAt: null,
      lastError: "stale binding"
    });
    const transcriptStore = createTranscriptStore();
    const desktopDriver = createDriver({
      openOrBindSession: vi.fn().mockResolvedValue({
        sessionKey: "qqbot:default::qq:c2c:OPENID123",
        codexThreadRef: "codex-thread:fresh"
      }),
      collectAssistantReply: vi.fn().mockResolvedValue([])
    });
    const qqEgress = createEgress();
    const handler = new ThreadCommandHandler({
      sessionStore,
      transcriptStore,
      desktopDriver,
      qqEgress
    });

    await expect(handler.handleIfCommand(createPrivateMessage("/代码审查"))).resolves.toBe(true);

    expect(desktopDriver.openOrBindSession).toHaveBeenCalledWith(
      "qqbot:default::qq:c2c:OPENID123",
      null
    );
    expect(sessionStore.updateBinding).toHaveBeenCalledWith(
      "qqbot:default::qq:c2c:OPENID123",
      "codex-thread:fresh"
    );
    expect(sessionStore.updateSessionStatus).toHaveBeenCalledWith(
      "qqbot:default::qq:c2c:OPENID123",
      BridgeSessionStatus.Active,
      null
    );
  });

  it("shows the current tracked task without waiting for the session lock", async () => {
    const sessionStore = createSessionStore();
    vi.mocked(sessionStore.withSessionLock).mockImplementation(async () => {
      throw new Error("task query should bypass the session lock");
    });
    const transcriptStore = createTranscriptStore();
    const desktopDriver = createDriver();
    const qqEgress = createEgress();
    const turnStore = createTurnStore();
    const handler = new ThreadCommandHandler({
      sessionStore,
      transcriptStore,
      turnStore,
      desktopDriver,
      qqEgress
    });

    await expect(handler.handleIfCommand(createPrivateMessage("/task current"))).resolves.toBe(true);

    expect(sessionStore.withSessionLock).not.toHaveBeenCalled();
    expect(turnStore.getCurrentTurn).toHaveBeenCalledWith("qqbot:default::qq:c2c:OPENID123");
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Current task:")
      })
    );
  });

  it("shows recent tracked tasks for /tasks", async () => {
    const sessionStore = createSessionStore();
    const transcriptStore = createTranscriptStore();
    const desktopDriver = createDriver();
    const qqEgress = createEgress();
    const turnStore = createTurnStore();
    const handler = new ThreadCommandHandler({
      sessionStore,
      transcriptStore,
      turnStore,
      desktopDriver,
      qqEgress
    });

    await expect(handler.handleIfCommand(createPrivateMessage("/tasks"))).resolves.toBe(true);

    expect(turnStore.listRecentTurns).toHaveBeenCalledWith("qqbot:default::qq:c2c:OPENID123", 10);
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Recent tasks:")
      })
    );
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("| bridge-turn-1 | completed |")
      })
    );
  });

  it("shows pending and failed delivery jobs for /deliveries", async () => {
    const deliveryJobStore = createDeliveryJobStore();
    const transcriptStore = createTranscriptStore();
    const qqEgress = createEgress();
    const handler = new ThreadCommandHandler({
      sessionStore: createSessionStore(),
      transcriptStore,
      turnStore: createTurnStore(),
      deliveryJobStore,
      desktopDriver: createDriver(),
      qqEgress
    });

    await expect(handler.handleIfCommand(createPrivateMessage("/deliveries"))).resolves.toBe(true);

    expect(deliveryJobStore.listJobs).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "qqbot:default::qq:c2c:OPENID123",
        statuses: [
          DeliveryJobStatus.Pending,
          DeliveryJobStatus.InFlight,
          DeliveryJobStatus.Failed
        ]
      })
    );
    expect(transcriptStore.recordInbound).toHaveBeenCalledWith(
      expect.objectContaining({ text: "/deliveries" })
    );
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Delivery jobs:")
      })
    );
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("network down")
      })
    );
  });

  it("queues a fresh inbound turn for /retry on a failed task", async () => {
    const sessionStore = createSessionStore();
    const transcriptStore = createTranscriptStore();
    transcriptStore.getInbound = vi.fn().mockResolvedValue(
      createPrivateMessage("修复失败任务")
    );
    const turnStore = createTurnStore();
    vi.mocked(turnStore.listRecentTurns).mockResolvedValue([
      {
        turnId: "bridge-turn-failed-1",
        sessionKey: "qqbot:default::qq:c2c:OPENID123",
        codexThreadRef: "codex-app-thread:thread-1",
        codexTurnRef: "codex-turn-1",
        qqMessageId: "msg-1",
        status: BridgeTurnStatus.Failed,
        startedAt: "2026-07-01T10:00:00.000Z",
        updatedAt: "2026-07-01T10:00:10.000Z",
        deadlineAt: null,
        lastEventAt: "2026-07-01T10:00:10.000Z",
        lastToolName: "pnpm test",
        lastError: "test failed",
        deliveredTextLength: 0
      }
    ]);
    const retryInbound = vi.fn();
    const qqEgress = createEgress();
    const handler = new ThreadCommandHandler({
      sessionStore,
      transcriptStore,
      turnStore,
      desktopDriver: createDriver(),
      qqEgress,
      retryInbound
    });

    await expect(
      handler.handleIfCommand(createPrivateMessage("/retry bridge-turn-failed"))
    ).resolves.toBe(true);

    expect(sessionStore.withSessionLock).not.toHaveBeenCalled();
    expect(transcriptStore.getInbound).toHaveBeenCalledWith("msg-1");
    expect(retryInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: expect.stringMatching(/^retry:/),
        replyToMessageId: "msg-1",
        retryOfTurnId: "bridge-turn-failed-1",
        text: "修复失败任务",
        sessionKey: "qqbot:default::qq:c2c:OPENID123"
      })
    );
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Retry queued from task")
      })
    );
  });

  it("still queues /retry when the acknowledgement cannot be delivered", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const transcriptStore = createTranscriptStore();
    transcriptStore.getInbound = vi.fn().mockResolvedValue(
      createPrivateMessage("retry this task")
    );
    const turnStore = createTurnStore();
    vi.mocked(turnStore.listRecentTurns).mockResolvedValue([
      {
        turnId: "bridge-turn-failed-2",
        sessionKey: "qqbot:default::qq:c2c:OPENID123",
        codexThreadRef: "codex-app-thread:thread-1",
        codexTurnRef: "codex-turn-2",
        qqMessageId: "msg-1",
        status: BridgeTurnStatus.Failed,
        startedAt: "2026-07-01T10:00:00.000Z",
        updatedAt: "2026-07-01T10:00:10.000Z",
        deadlineAt: null,
        lastEventAt: null,
        lastToolName: null,
        lastError: "failed",
        deliveredTextLength: 0
      }
    ]);
    const retryInbound = vi.fn();
    const handler = new ThreadCommandHandler({
      sessionStore: createSessionStore(),
      transcriptStore,
      turnStore,
      desktopDriver: createDriver(),
      qqEgress: {
        deliver: vi.fn().mockRejectedValue(new Error("qq unavailable"))
      },
      retryInbound
    });

    await expect(
      handler.handleIfCommand(createPrivateMessage("/retry bridge-turn-failed-2"))
    ).resolves.toBe(true);

    expect(retryInbound).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith(
      "[codex-desktop-orchestrator] retry acknowledgement delivery failed",
      expect.objectContaining({
        sourceTurnId: "bridge-turn-failed-2",
        error: "qq unavailable"
      })
    );
  });

  it.each(["/cancel", "停止任务", "取消任务", "停止当前任务", "取消当前任务"])(
    "cancels the active task without waiting for the session lock: %s",
    async (command) => {
      const sessionStore = createSessionStore();
      vi.mocked(sessionStore.withSessionLock).mockImplementation(async () => {
        throw new Error("cancel should bypass the session lock");
      });
      const transcriptStore = createTranscriptStore();
      const desktopDriver = createDriver({
        interruptActiveTurn: vi.fn().mockResolvedValue(true)
      });
      const qqEgress = createEgress();
      const turnStore = createTurnStore();
      const handler = new ThreadCommandHandler({
        sessionStore,
        transcriptStore,
        turnStore,
        desktopDriver,
        qqEgress
      });

      await expect(handler.handleIfCommand(createPrivateMessage(command))).resolves.toBe(true);

      expect(sessionStore.withSessionLock).not.toHaveBeenCalled();
      expect(transcriptStore.recordInbound).toHaveBeenCalledWith(
        expect.objectContaining({ text: command })
      );
      expect(desktopDriver.interruptActiveTurn).toHaveBeenCalledWith(
        "qqbot:default::qq:c2c:OPENID123"
      );
      expect(turnStore.updateStatus).toHaveBeenCalledWith(
        "bridge-turn-1",
        BridgeTurnStatus.Cancelled,
        null
      );
      expect(qqEgress.deliver).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("Codex turn interrupt sent.")
        })
      );
    }
  );

  it("keeps the task active when the driver interrupt fails", async () => {
    const sessionStore = createSessionStore();
    const transcriptStore = createTranscriptStore();
    const desktopDriver = createDriver({
      interruptActiveTurn: vi.fn().mockRejectedValue(new Error("interrupt failed"))
    });
    const qqEgress = createEgress();
    const turnStore = createTurnStore();
    const handler = new ThreadCommandHandler({
      sessionStore,
      transcriptStore,
      turnStore,
      desktopDriver,
      qqEgress
    });

    await expect(handler.handleIfCommand(createPrivateMessage("/cancel"))).resolves.toBe(true);

    expect(turnStore.updateStatus).not.toHaveBeenCalled();
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Cancel failed for task")
      })
    );
  });

  it("shows model status for /model and /m", async () => {
    const sessionStore = createSessionStore();
    const transcriptStore = createTranscriptStore();
    const desktopDriver = createDriver({
      getControlState: vi.fn().mockResolvedValue({
        model: "GPT-5.4",
        reasoningEffort: "高",
        workspace: "本地",
        branch: "codex/codex-desktop-orchestrator",
        permissionMode: "完全访问权限",
        quotaSummary: null
      })
    });
    const qqEgress = createEgress();
    const handler = new ThreadCommandHandler({
      sessionStore,
      transcriptStore,
      desktopDriver,
      qqEgress
    });

    await expect(handler.handleIfCommand(createPrivateMessage("/model"))).resolves.toBe(true);
    await expect(handler.handleIfCommand(createPrivateMessage("/m"))).resolves.toBe(true);

    expect(desktopDriver.getControlState).toHaveBeenCalledTimes(2);
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("当前模型：GPT-5.4")
      })
    );
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("推理强度：高")
      })
    );
  });

  it("switches model for /model use and /mu", async () => {
    const sessionStore = createSessionStore();
    const transcriptStore = createTranscriptStore();
    const desktopDriver = createDriver({
      switchModel: vi.fn().mockResolvedValue({
        model: "GPT-5.4-Mini",
        reasoningEffort: "高",
        workspace: "本地",
        branch: "codex/codex-desktop-orchestrator",
        permissionMode: "完全访问权限",
        quotaSummary: null
      })
    });
    const qqEgress = createEgress();
    const handler = new ThreadCommandHandler({
      sessionStore,
      transcriptStore,
      desktopDriver,
      qqEgress
    });

    await expect(handler.handleIfCommand(createPrivateMessage("/model use GPT-5.4-Mini"))).resolves.toBe(true);
    await expect(handler.handleIfCommand(createPrivateMessage("/mu GPT-5.4-Mini"))).resolves.toBe(true);

    expect(desktopDriver.switchModel).toHaveBeenNthCalledWith(1, "GPT-5.4-Mini");
    expect(desktopDriver.switchModel).toHaveBeenNthCalledWith(2, "GPT-5.4-Mini");
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("已切换模型：GPT-5.4-Mini")
      })
    );
  });

  it("shows quota summary for /quota and /q", async () => {
    const sessionStore = createSessionStore();
    const transcriptStore = createTranscriptStore();
    const desktopDriver = createDriver({
      getControlState: vi.fn().mockResolvedValue({
        model: "GPT-5.4",
        reasoningEffort: "高",
        workspace: "本地",
        branch: "codex/codex-desktop-orchestrator",
        permissionMode: "完全访问权限",
        quotaSummary: null
      }),
      getQuotaSummary: vi.fn().mockResolvedValue("5 小时 22%（01:56 重置）\n1 周 25%（4月17日 重置）")
    });
    const qqEgress = createEgress();
    const handler = new ThreadCommandHandler({
      sessionStore,
      transcriptStore,
      desktopDriver,
      qqEgress
    });

    await expect(handler.handleIfCommand(createPrivateMessage("/quota"))).resolves.toBe(true);
    await expect(handler.handleIfCommand(createPrivateMessage("/q"))).resolves.toBe(true);

    expect(desktopDriver.getQuotaSummary).toHaveBeenCalledTimes(2);
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("额度信息：5 小时 22%（01:56 重置）")
      })
    );
  });

  it("shows control status for /status and /st", async () => {
    const sessionStore = createSessionStore();
    vi.mocked(sessionStore.getSession).mockResolvedValue({
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      accountKey: "qqbot:default",
      peerKey: "qq:c2c:OPENID123",
      chatType: "c2c",
      peerId: "OPENID123",
      codexThreadRef: "codex-app-thread:thread-b:stale-title",
      lastCodexTurnId: null,
      skillContextKey: null,
      conversationProvider: null,
      status: BridgeSessionStatus.Active,
      lastInboundAt: null,
      lastOutboundAt: null,
      lastError: null
    });
    const transcriptStore = createTranscriptStore();
    const getControlState = vi.fn().mockResolvedValue({
      threadRef: "codex-app-thread:thread-b:fresh-title",
      threadTitle: "线程 B",
      threadProjectName: "codex-desktop-orchestrator",
      threadRelativeTime: "刚刚",
      model: "GPT-5.4",
      reasoningEffort: "高",
      workspace: "codex-desktop-orchestrator",
      branch: "codex/weixin-multi-channel",
      permissionMode: "完全访问权限",
      quotaSummary: null
    });
    const desktopDriver = createDriver({
      getControlState,
      getQuotaSummary: vi.fn().mockResolvedValue("5 小时 22%（01:56 重置）\n1 周 25%（4月17日 重置）")
    });
    const qqEgress = createEgress();
    const handler = new ThreadCommandHandler({
      sessionStore,
      transcriptStore,
      desktopDriver,
      qqEgress
    });

    await expect(handler.handleIfCommand(createPrivateMessage("/status"))).resolves.toBe(true);
    await expect(handler.handleIfCommand(createPrivateMessage("/st"))).resolves.toBe(true);

    expect(getControlState).toHaveBeenCalledWith({
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      codexThreadRef: "codex-app-thread:thread-b:stale-title"
    });
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("线程绑定：codex-app-thread:thread-b:fresh-title")
      })
    );
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("线程标题：线程 B")
      })
    );
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("工作区：codex-desktop-orchestrator")
      })
    );
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("分支：codex/weixin-multi-channel")
      })
    );
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("额度：5 小时 22%（01:56 重置）")
      })
    );
  });

  it("shows help for /h", async () => {
    const sessionStore = createSessionStore();
    const transcriptStore = createTranscriptStore();
    const desktopDriver = createDriver();
    const qqEgress = createEgress();
    const handler = new ThreadCommandHandler({
      sessionStore,
      transcriptStore,
      desktopDriver,
      qqEgress
    });

    await expect(handler.handleIfCommand(createPrivateMessage("/h"))).resolves.toBe(true);

    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("| 查看当前模型 | `/model` | `/m` |")
      })
    );
  });

  it("refreshes ChatGPT chat list on the first /threads after switching source", async () => {
    const sessionStore = createSessionStore();
    const transcriptStore = createTranscriptStore();
    const desktopDriver = createDriver();
    const chatgptDriver = createChatgptDriver();
    const qqEgress = createEgress();
    const handler = new ThreadCommandHandler({
      sessionStore,
      transcriptStore,
      desktopDriver,
      qqEgress,
      chatgptDriver: chatgptDriver as never
    });

    await expect(handler.handleIfCommand(createPrivateMessage("/source chatgpt"))).resolves.toBe(true);
    vi.mocked(sessionStore.getSession).mockResolvedValue({
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
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

    await expect(handler.handleIfCommand(createPrivateMessage("/t"))).resolves.toBe(true);

    expect(chatgptDriver.listChats).toHaveBeenCalledTimes(2);
    expect(chatgptDriver.listChats).toHaveBeenNthCalledWith(1, 20);
    expect(chatgptDriver.listChats).toHaveBeenNthCalledWith(2, 20);
  });

  it("routes /threads to ChatGPT chats when the current source is chatgpt", async () => {
    const sessionStore = createSessionStore();
    vi.mocked(sessionStore.getSession).mockResolvedValue({
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
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
    const transcriptStore = createTranscriptStore();
    const desktopDriver = createDriver();
    const chatgptDriver = createChatgptDriver();
    const qqEgress = createEgress();
    const handler = new ThreadCommandHandler({
      sessionStore,
      transcriptStore,
      desktopDriver,
      qqEgress,
      chatgptDriver: chatgptDriver as never
    });

    await expect(handler.handleIfCommand(createPrivateMessage("/threads"))).resolves.toBe(true);

    expect(desktopDriver.listRecentThreads).not.toHaveBeenCalled();
    expect(chatgptDriver.listChats).toHaveBeenCalledWith(20);
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("最近 20 条 ChatGPT 对话")
      })
    );
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("| 👉🏻 1 | 家庭照片 |")
      })
    );
  });

  it("routes /thread use to ChatGPT chats when the current source is chatgpt", async () => {
    const sessionStore = createSessionStore();
    vi.mocked(sessionStore.getSession).mockResolvedValue({
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
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
    const transcriptStore = createTranscriptStore();
    const desktopDriver = createDriver();
    const chatgptDriver = createChatgptDriver();
    const qqEgress = createEgress();
    const handler = new ThreadCommandHandler({
      sessionStore,
      transcriptStore,
      desktopDriver,
      qqEgress,
      chatgptDriver: chatgptDriver as never
    });

    await expect(handler.handleIfCommand(createPrivateMessage("/thread use 2"))).resolves.toBe(true);

    expect(desktopDriver.switchToThread).not.toHaveBeenCalled();
    expect(chatgptDriver.switchToChat).toHaveBeenCalledWith("产品海报");
    expect(chatgptDriver.markSwitched).toHaveBeenCalledWith("qqbot:default::qq:c2c:OPENID123", "产品海报");
    expect(sessionStore.updateConversationProvider).toHaveBeenCalledWith(
      "qqbot:default::qq:c2c:OPENID123",
      "chatgpt-desktop"
    );
    expect(sessionStore.updateSessionStatus).toHaveBeenCalledWith(
      "qqbot:default::qq:c2c:OPENID123",
      BridgeSessionStatus.Active,
      null
    );
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("已切换到 ChatGPT 对话：产品海报")
      })
    );
  });

  it("switches /cgpt use to the ChatGPT source for following messages", async () => {
    const sessionStore = createSessionStore();
    const transcriptStore = createTranscriptStore();
    const desktopDriver = createDriver();
    const chatgptDriver = createChatgptDriver();
    const qqEgress = createEgress();
    const handler = new ThreadCommandHandler({
      sessionStore,
      transcriptStore,
      desktopDriver,
      qqEgress,
      chatgptDriver: chatgptDriver as never
    });

    await expect(handler.handleIfCommand(createPrivateMessage("/cgpt use 2"))).resolves.toBe(true);

    expect(chatgptDriver.switchToChat).toHaveBeenCalledWith("产品海报");
    expect(chatgptDriver.markSwitched).toHaveBeenCalledWith("qqbot:default::qq:c2c:OPENID123", "产品海报");
    expect(sessionStore.updateConversationProvider).toHaveBeenCalledWith(
      "qqbot:default::qq:c2c:OPENID123",
      "chatgpt-desktop"
    );
    expect(sessionStore.updateSessionStatus).toHaveBeenCalledWith(
      "qqbot:default::qq:c2c:OPENID123",
      BridgeSessionStatus.Active,
      null
    );
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("下次消息将继续该对话")
      })
    );
  });

  it("marks the current ChatGPT chat from the active window title when no registry ref is available", async () => {
    const sessionStore = createSessionStore();
    vi.mocked(sessionStore.getSession).mockResolvedValue({
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
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
    const transcriptStore = createTranscriptStore();
    const desktopDriver = createDriver();
    const chatgptDriver = createChatgptDriver();
    chatgptDriver.getSessionThreadRef.mockReturnValue(null);
    chatgptDriver.getCurrentThreadTitle.mockReturnValue("产品海报 - ChatGPT");
    const qqEgress = createEgress();
    const handler = new ThreadCommandHandler({
      sessionStore,
      transcriptStore,
      desktopDriver,
      qqEgress,
      chatgptDriver: chatgptDriver as never
    });

    await expect(handler.handleIfCommand(createPrivateMessage("/t"))).resolves.toBe(true);

    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("| 👉🏻 2 | 产品海报 |")
      })
    );
  });

  it("routes /thread new to ChatGPT new chat when the current source is chatgpt", async () => {
    const sessionStore = createSessionStore();
    vi.mocked(sessionStore.getSession).mockResolvedValue({
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
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
    const transcriptStore = createTranscriptStore();
    const desktopDriver = createDriver();
    const chatgptDriver = createChatgptDriver();
    const qqEgress = createEgress();
    const handler = new ThreadCommandHandler({
      sessionStore,
      transcriptStore,
      desktopDriver,
      qqEgress,
      chatgptDriver: chatgptDriver as never
    });

    await expect(handler.handleIfCommand(createPrivateMessage("/thread new 新图会话"))).resolves.toBe(true);

    expect(desktopDriver.createThread).not.toHaveBeenCalled();
    expect(chatgptDriver.newChat).toHaveBeenCalledWith("qqbot:default::qq:c2c:OPENID123");
    expect(sessionStore.updateConversationProvider).toHaveBeenCalledWith(
      "qqbot:default::qq:c2c:OPENID123",
      "chatgpt-desktop"
    );
    expect(sessionStore.updateSessionStatus).toHaveBeenCalledWith(
      "qqbot:default::qq:c2c:OPENID123",
      BridgeSessionStatus.Active,
      null
    );
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("已为本会话新建 ChatGPT 对话")
      })
    );
  });

  it("switches /cgpt new to the ChatGPT source for following messages", async () => {
    const sessionStore = createSessionStore();
    const transcriptStore = createTranscriptStore();
    const desktopDriver = createDriver();
    const chatgptDriver = createChatgptDriver();
    const qqEgress = createEgress();
    const handler = new ThreadCommandHandler({
      sessionStore,
      transcriptStore,
      desktopDriver,
      qqEgress,
      chatgptDriver: chatgptDriver as never
    });

    await expect(handler.handleIfCommand(createPrivateMessage("/cgpt new"))).resolves.toBe(true);

    expect(chatgptDriver.newChat).toHaveBeenCalledWith("qqbot:default::qq:c2c:OPENID123");
    expect(sessionStore.updateConversationProvider).toHaveBeenCalledWith(
      "qqbot:default::qq:c2c:OPENID123",
      "chatgpt-desktop"
    );
    expect(sessionStore.updateSessionStatus).toHaveBeenCalledWith(
      "qqbot:default::qq:c2c:OPENID123",
      BridgeSessionStatus.Active,
      null
    );
  });

  it("intercepts unknown slash commands and returns bridge guidance", async () => {
    const sessionStore = createSessionStore();
    const transcriptStore = createTranscriptStore();
    const desktopDriver = createDriver();
    const qqEgress = createEgress();
    const handler = new ThreadCommandHandler({
      sessionStore,
      transcriptStore,
      desktopDriver,
      qqEgress
    });

    await expect(handler.handleIfCommand(createPrivateMessage("/quotaa"))).resolves.toBe(true);

    expect(desktopDriver.getControlState).not.toHaveBeenCalled();
    expect(desktopDriver.listRecentThreads).not.toHaveBeenCalled();
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("未识别的桥接快捷指令：`/quotaa`")
      })
    );
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("这条 `/` 指令不会转发给当前对话源。")
      })
    );
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("| 查看额度信息 | `/quota` | `/q` |")
      })
    );
  });

  it("lists Codex Desktop projects from recent threads for /projects", async () => {
    const sessionStore = createSessionStore();
    const transcriptStore = createTranscriptStore();
    const desktopDriver = createDriver();
    const qqEgress = createEgress();
    const handler = new ThreadCommandHandler({
      sessionStore,
      transcriptStore,
      desktopDriver,
      qqEgress
    });

    await expect(handler.handleIfCommand(createPrivateMessage("/projects"))).resolves.toBe(true);

    expect(desktopDriver.listRecentThreads).toHaveBeenCalledWith(200);
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Codex Desktop projects from recent threads:")
      })
    );
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("| skills | 1 |")
      })
    );
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("| Desktop | 1 |")
      })
    );
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("uses /aliases")
      })
    );
  });

  it("lists configured cwd aliases for /aliases", async () => {
    const sessionStore = createSessionStore();
    const transcriptStore = createTranscriptStore();
    const desktopDriver = createDriver();
    const qqEgress = createEgress();
    const handler = new ThreadCommandHandler({
      sessionStore,
      transcriptStore,
      desktopDriver,
      qqEgress,
      projectAliases: {
        bridge: {
          cwd: "D:/Project/github/codex-desktop-orchestrator",
          label: "Bridge"
        }
      }
    });

    await expect(handler.handleIfCommand(createPrivateMessage("/aliases"))).resolves.toBe(true);

    expect(desktopDriver.listRecentThreads).not.toHaveBeenCalled();
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Configured project aliases:")
      })
    );
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("| bridge | Bridge | D:/Project/github/codex-desktop-orchestrator |")
      })
    );
  });

  it("creates a codex thread in a configured project cwd for /new", async () => {
    const sessionStore = createSessionStore();
    const transcriptStore = createTranscriptStore();
    const desktopDriver = createDriver();
    const qqEgress = createEgress();
    const handler = new ThreadCommandHandler({
      sessionStore,
      transcriptStore,
      desktopDriver,
      qqEgress,
      projectAliases: {
        "codex-desktop-orchestrator": {
          cwd: "D:/Project/github/codex-desktop-orchestrator",
          label: "Codex Desktop Orchestrator"
        }
      }
    });

    await expect(handler.handleIfCommand(createPrivateMessage("/new codex-desktop-orchestrator fix startup"))).resolves.toBe(true);

    expect(desktopDriver.createThread).toHaveBeenCalledWith(
      "qqbot:default::qq:c2c:OPENID123",
      expect.stringContaining("fix startup"),
      {
        cwd: "D:/Project/github/codex-desktop-orchestrator"
      }
    );
    expect(sessionStore.updateConversationProvider).toHaveBeenCalledWith(
      "qqbot:default::qq:c2c:OPENID123",
      "codex-desktop"
    );
    expect(sessionStore.updateBinding).toHaveBeenCalledWith(
      "qqbot:default::qq:c2c:OPENID123",
      "codex-thread:page-1:new"
    );
    expect(sessionStore.updateSessionStatus).toHaveBeenCalledWith(
      "qqbot:default::qq:c2c:OPENID123",
      BridgeSessionStatus.Active,
      null
    );
    expect(sessionStore.updateSkillContextKey).toHaveBeenCalledWith(
      "qqbot:default::qq:c2c:OPENID123",
      null
    );
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Created Codex thread for project: Codex Desktop Orchestrator")
      })
    );
  });

  it("rejects /new when the project alias is unknown", async () => {
    const sessionStore = createSessionStore();
    const transcriptStore = createTranscriptStore();
    const desktopDriver = createDriver();
    const qqEgress = createEgress();
    const handler = new ThreadCommandHandler({
      sessionStore,
      transcriptStore,
      desktopDriver,
      qqEgress,
      projectAliases: {
        bridge: {
          cwd: "D:/Project/github/codex-desktop-orchestrator"
        }
      }
    });

    await expect(handler.handleIfCommand(createPrivateMessage("/new missing fix startup"))).resolves.toBe(true);

    expect(desktopDriver.createThread).not.toHaveBeenCalled();
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Unknown project alias: missing")
      })
    );
    expect(qqEgress.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Use /aliases")
      })
    );
  });

  it("creates a forked thread with recent qq conversation summary", async () => {
    const sessionStore = createSessionStore();
    const transcriptStore = createTranscriptStore();
    const desktopDriver = createDriver();
    const qqEgress = createEgress();
    const handler = new ThreadCommandHandler({
      sessionStore,
      transcriptStore,
      desktopDriver,
      qqEgress
    });

    await expect(handler.handleIfCommand(createPrivateMessage("/thread fork 新专题"))).resolves.toBe(true);
    expect(transcriptStore.listRecentConversation).toHaveBeenCalledWith(
      "qqbot:default::qq:c2c:OPENID123",
      8
    );
    expect(desktopDriver.createThread).toHaveBeenCalledWith(
      "qqbot:default::qq:c2c:OPENID123",
      expect.stringContaining("新专题")
    );
    expect(desktopDriver.createThread).toHaveBeenCalledWith(
      "qqbot:default::qq:c2c:OPENID123",
      expect.stringContaining("用户：用户问题 1")
    );
    expect(sessionStore.updateSessionStatus).toHaveBeenCalledWith(
      "qqbot:default::qq:c2c:OPENID123",
      BridgeSessionStatus.Active,
      null
    );
  });
});

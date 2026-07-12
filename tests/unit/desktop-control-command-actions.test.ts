import { describe, expect, it, vi } from "vitest";
import type { CodexControlState } from "../../packages/domain/src/driver.js";
import { BridgeSessionStatus, type BridgeSession } from "../../packages/domain/src/session.js";
import type { DesktopDriverPort } from "../../packages/ports/src/conversation.js";
import type { SessionStorePort } from "../../packages/ports/src/store.js";
import { DesktopControlCommandActions } from "../../apps/bridge-daemon/src/desktop-control-command-actions.js";

type DesktopControlDriver = Pick<
  DesktopDriverPort,
  "getControlState" | "getQuotaSummary" | "switchModel"
>;

function createControlState(overrides: Partial<CodexControlState> = {}): CodexControlState {
  return {
    threadRef: null,
    threadTitle: null,
    threadProjectName: null,
    threadRelativeTime: null,
    model: "GPT-5.4",
    reasoningEffort: "高",
    workspace: "codex-desktop-orchestrator",
    branch: "codex/weixin-multi-channel",
    permissionMode: "完全访问权限",
    quotaSummary: null,
    ...overrides
  };
}

function createSession(overrides: Partial<BridgeSession> = {}): BridgeSession {
  return {
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
    lastError: null,
    ...overrides
  };
}

function createDesktopDriver(overrides: Partial<DesktopControlDriver> = {}): DesktopControlDriver {
  return {
    getControlState: vi.fn().mockResolvedValue(createControlState()),
    getQuotaSummary: vi.fn().mockResolvedValue(null),
    switchModel: vi.fn().mockResolvedValue(createControlState()),
    ...overrides
  };
}

function createSessionStore(
  session: BridgeSession | null = null
): Pick<SessionStorePort, "getSession"> {
  return {
    getSession: vi.fn().mockResolvedValue(session)
  };
}

describe("DesktopControlCommandActions", () => {
  it("builds model text from the current control state", async () => {
    const actions = new DesktopControlCommandActions({
      desktopDriver: createDesktopDriver(),
      sessionStore: createSessionStore()
    });

    await expect(actions.buildModelText()).resolves.toBe(
      [
        "当前模型：GPT-5.4",
        "推理强度：高",
        "工作区：codex-desktop-orchestrator",
        "分支：codex/weixin-multi-channel"
      ].join("\n")
    );
  });

  it("switches model and formats the successful state", async () => {
    const desktopDriver = createDesktopDriver({
      switchModel: vi.fn().mockResolvedValue(
        createControlState({
          model: "GPT-5.4-Mini",
          workspace: "本地"
        })
      )
    });
    const actions = new DesktopControlCommandActions({
      desktopDriver,
      sessionStore: createSessionStore()
    });

    await expect(actions.switchModel("GPT-5.4-Mini")).resolves.toBe(
      [
        "已切换模型：GPT-5.4-Mini",
        "推理强度：高",
        "工作区：本地"
      ].join("\n")
    );
    expect(desktopDriver.switchModel).toHaveBeenCalledWith("GPT-5.4-Mini");
  });

  it("keeps the Chinese failure text when model switching fails", async () => {
    const actions = new DesktopControlCommandActions({
      desktopDriver: createDesktopDriver({
        switchModel: vi.fn().mockRejectedValue(new Error("model not found"))
      }),
      sessionStore: createSessionStore()
    });

    await expect(actions.switchModel("bad-model")).resolves.toBe(
      "切换模型失败：model not found\n请检查模型名称是否正确，或当前 Codex Desktop 界面是否可操作。"
    );
  });

  it("builds quota text with and without a recognized quota summary", async () => {
    const withQuota = new DesktopControlCommandActions({
      desktopDriver: createDesktopDriver({
        getQuotaSummary: vi.fn().mockResolvedValue("5 小时 22%（01:56 重置）")
      }),
      sessionStore: createSessionStore()
    });
    const withoutQuota = new DesktopControlCommandActions({
      desktopDriver: createDesktopDriver({
        getQuotaSummary: vi.fn().mockResolvedValue(null)
      }),
      sessionStore: createSessionStore()
    });

    await expect(withQuota.buildQuotaText()).resolves.toBe("额度信息：5 小时 22%（01:56 重置）");
    await expect(withoutQuota.buildQuotaText()).resolves.toBe(
      "额度信息：当前界面未显示明确额度，暂未识别到剩余配额。"
    );
  });

  it("builds status text for a bound session", async () => {
    const session = createSession();
    const desktopDriver = createDesktopDriver({
      getControlState: vi.fn().mockResolvedValue(
        createControlState({
          threadRef: "codex-app-thread:thread-b:fresh-title",
          threadTitle: "线程 B",
          threadProjectName: "codex-desktop-orchestrator",
          threadRelativeTime: "刚刚"
        })
      ),
      getQuotaSummary: vi.fn().mockResolvedValue("5 小时 22%（01:56 重置）")
    });
    const actions = new DesktopControlCommandActions({
      desktopDriver,
      sessionStore: createSessionStore(session)
    });

    await expect(actions.buildStatusText(session.sessionKey)).resolves.toBe(
      [
        "当前运行状态：",
        "线程绑定：codex-app-thread:thread-b:fresh-title",
        "线程标题：线程 B",
        "线程项目：codex-desktop-orchestrator",
        "线程最近活动：刚刚",
        "模型：GPT-5.4",
        "推理强度：高",
        "工作区：codex-desktop-orchestrator",
        "分支：codex/weixin-multi-channel",
        "权限：完全访问权限",
        "额度：5 小时 22%（01:56 重置）"
      ].join("\n")
    );
    expect(desktopDriver.getControlState).toHaveBeenCalledWith({
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      codexThreadRef: "codex-app-thread:thread-b:stale-title"
    });
  });

  it("builds status text without a persisted session", async () => {
    const desktopDriver = createDesktopDriver({
      getControlState: vi.fn().mockResolvedValue(createControlState({ model: null })),
      getQuotaSummary: vi.fn().mockResolvedValue(null)
    });
    const actions = new DesktopControlCommandActions({
      desktopDriver,
      sessionStore: createSessionStore(null)
    });

    const text = await actions.buildStatusText("missing-session");

    expect(text).toContain("线程绑定：未绑定");
    expect(text).toContain("模型：未识别");
    expect(text).toContain("额度：当前界面未显示明确额度，暂未识别到剩余配额。");
    expect(desktopDriver.getControlState).toHaveBeenCalledWith(null);
  });
});

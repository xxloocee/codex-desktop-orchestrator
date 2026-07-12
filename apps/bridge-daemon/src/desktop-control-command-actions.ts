import type { CodexControlState, DriverBinding } from "../../../packages/domain/src/driver.js";
import type { BridgeSession } from "../../../packages/domain/src/session.js";
import type { DesktopDriverPort } from "../../../packages/ports/src/conversation.js";
import type { SessionStorePort } from "../../../packages/ports/src/store.js";

type DesktopControlCommandActionsDeps = {
  desktopDriver: Pick<DesktopDriverPort, "getControlState" | "getQuotaSummary" | "switchModel">;
  sessionStore: Pick<SessionStorePort, "getSession">;
};

export class DesktopControlCommandActions {
  constructor(private readonly deps: DesktopControlCommandActionsDeps) {}

  async buildModelText(): Promise<string> {
    const state = await this.deps.desktopDriver.getControlState();
    return formatModelReply(state);
  }

  async switchModel(targetModel: string): Promise<string> {
    try {
      const state = await this.deps.desktopDriver.switchModel(targetModel);
      return formatModelSwitchReply(targetModel, state);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return `切换模型失败：${reason}\n请检查模型名称是否正确，或当前 Codex Desktop 界面是否可操作。`;
    }
  }

  async buildQuotaText(): Promise<string> {
    const quotaSummary = await this.deps.desktopDriver.getQuotaSummary();
    return formatQuotaReply(quotaSummary);
  }

  async buildStatusText(sessionKey: string): Promise<string> {
    const session = await this.deps.sessionStore.getSession(sessionKey);
    const state = await this.deps.desktopDriver.getControlState(
      session ? toDriverBinding(session) : null
    );
    const quotaSummary = await this.deps.desktopDriver.getQuotaSummary();
    return formatStatusReply(session, state, quotaSummary);
  }
}

function toDriverBinding(session: BridgeSession): DriverBinding {
  return {
    sessionKey: session.sessionKey,
    codexThreadRef: session.codexThreadRef
  };
}

function formatModelReply(state: CodexControlState): string {
  return [
    `当前模型：${state.model ?? "未识别"}`,
    `推理强度：${state.reasoningEffort ?? "未识别"}`,
    `工作区：${state.workspace ?? "未识别"}`,
    `分支：${state.branch ?? "未识别"}`
  ].join("\n");
}

function formatModelSwitchReply(targetModel: string, state: CodexControlState): string {
  return [
    `已切换模型：${state.model ?? targetModel}`,
    `推理强度：${state.reasoningEffort ?? "未识别"}`,
    `工作区：${state.workspace ?? "未识别"}`
  ].join("\n");
}

function formatQuotaReply(quotaSummary: string | null): string {
  return `额度信息：${quotaSummary ?? "当前界面未显示明确额度，暂未识别到剩余配额。"}`;
}

function formatStatusReply(
  session: BridgeSession | null,
  state: CodexControlState,
  quotaSummary: string | null
): string {
  const boundThreadRef = state.threadRef ?? session?.codexThreadRef ?? null;
  return [
    "当前运行状态：",
    `线程绑定：${boundThreadRef ?? "未绑定"}`,
    ...(state.threadTitle ? [`线程标题：${state.threadTitle}`] : []),
    ...(state.threadProjectName ? [`线程项目：${state.threadProjectName}`] : []),
    ...(state.threadRelativeTime ? [`线程最近活动：${state.threadRelativeTime}`] : []),
    `模型：${state.model ?? "未识别"}`,
    `推理强度：${state.reasoningEffort ?? "未识别"}`,
    `工作区：${state.workspace ?? "未识别"}`,
    `分支：${state.branch ?? "未识别"}`,
    `权限：${state.permissionMode ?? "未识别"}`,
    `额度：${quotaSummary ?? "当前界面未显示明确额度，暂未识别到剩余配额。"}`
  ].join("\n");
}

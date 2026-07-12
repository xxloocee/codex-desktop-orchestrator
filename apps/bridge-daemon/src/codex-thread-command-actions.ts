import { DesktopDriverError } from "../../../packages/domain/src/driver.js";
import { BridgeSessionStatus, type BridgeSession } from "../../../packages/domain/src/session.js";
import type { ConversationEntry } from "../../../packages/domain/src/message.js";
import type { DesktopDriverPort } from "../../../packages/ports/src/conversation.js";
import type { SessionStorePort, TranscriptStorePort } from "../../../packages/ports/src/store.js";
import {
  areThreadRefsEquivalent,
  buildProjectsText,
  buildUnknownProjectText,
  formatThreads
} from "./command-presenter.js";
import type { AppConfig } from "./config.js";

type CodexThreadCommandActionsDeps = {
  desktopDriver: Pick<DesktopDriverPort, "listRecentThreads" | "switchToThread" | "createThread">;
  sessionStore: Pick<
    SessionStorePort,
    "updateBinding" | "updateSessionStatus" | "updateSkillContextKey" | "updateConversationProvider"
  >;
  transcriptStore: Pick<TranscriptStorePort, "listRecentConversation">;
  projectAliases?: AppConfig["projectAliases"];
};

type ProjectAlias = {
  cwd: string;
  label?: string;
};

export class CodexThreadCommandActions {
  constructor(private readonly deps: CodexThreadCommandActionsDeps) {}

  async buildThreadsText(session: BridgeSession | null): Promise<string> {
    const threads = await this.deps.desktopDriver.listRecentThreads(20);
    return formatThreads(threads, session?.codexThreadRef ?? null);
  }

  async buildCurrentThreadText(session: BridgeSession | null): Promise<string> {
    const threads = await this.deps.desktopDriver.listRecentThreads(20);
    const current = threads.find(
      (thread) =>
        session?.codexThreadRef
        && areThreadRefsEquivalent(thread.threadRef, session.codexThreadRef)
    )
      ?? threads.find((thread) => thread.isCurrent)
      ?? null;

    return current
      ? `当前绑定线程：${current.title}${current.projectName ? `\n项目：${current.projectName}` : ""}${current.relativeTime ? `\n最近活动：${current.relativeTime}` : ""}`
      : "当前私聊还没有绑定线程。";
  }

  async buildProjectsText(): Promise<string> {
    const threads = await this.deps.desktopDriver.listRecentThreads(200);
    return buildProjectsText(threads);
  }

  async useThread(sessionKey: string, index: number): Promise<string> {
    const threads = await this.deps.desktopDriver.listRecentThreads(20);
    const thread = threads[index - 1];
    if (!thread) {
      return `没有第 ${index} 个线程。请先发送 /threads 查看列表。`;
    }

    let binding;
    try {
      binding = await this.deps.desktopDriver.switchToThread(sessionKey, thread.threadRef);
    } catch (error) {
      if (error instanceof DesktopDriverError && error.reason === "session_not_found") {
        return "切换失败：没有在当前 Codex 侧边栏里找到这个线程。\n请先发送 /t 刷新列表后重试。";
      }
      throw error;
    }

    await this.deps.sessionStore.updateBinding(sessionKey, binding.codexThreadRef);
    await this.deps.sessionStore.updateSessionStatus(sessionKey, BridgeSessionStatus.Active, null);
    await this.deps.sessionStore.updateSkillContextKey(sessionKey, null);

    return [
      `已切换到线程：${thread.title}`,
      ...(thread.projectName ? [`项目：${thread.projectName}`] : []),
      `绑定标识：${binding.codexThreadRef ?? "未绑定"}`
    ].join("\n");
  }

  async createThread(sessionKey: string, title: string): Promise<string> {
    const binding = await this.deps.desktopDriver.createThread(
      sessionKey,
      this.buildNewThreadSeedPrompt(title)
    );
    await this.deps.sessionStore.updateBinding(sessionKey, binding.codexThreadRef);
    await this.deps.sessionStore.updateSessionStatus(sessionKey, BridgeSessionStatus.Active, null);

    return `已创建并切换到新线程：${title}`;
  }

  async createProjectThread(sessionKey: string, alias: string, task: string): Promise<string> {
    const project = this.resolveProjectAlias(alias);
    if (!project) {
      return buildUnknownProjectText(alias, this.deps.projectAliases);
    }

    const binding = await this.deps.desktopDriver.createThread(
      sessionKey,
      this.buildProjectThreadSeedPrompt(alias, project, task),
      {
        cwd: project.cwd
      }
    );
    await this.deps.sessionStore.updateConversationProvider(sessionKey, "codex-desktop");
    await this.deps.sessionStore.updateBinding(sessionKey, binding.codexThreadRef);
    await this.deps.sessionStore.updateSessionStatus(sessionKey, BridgeSessionStatus.Active, null);
    await this.deps.sessionStore.updateSkillContextKey(sessionKey, null);

    return [
      `Created Codex thread for project: ${project.label ?? alias}`,
      `Alias: ${alias}`,
      `cwd: ${project.cwd}`,
      `Binding: ${binding.codexThreadRef ?? "unbound"}`
    ].join("\n");
  }

  async forkThread(sessionKey: string, title: string): Promise<string> {
    const recentConversation = await this.deps.transcriptStore.listRecentConversation(
      sessionKey,
      8
    );
    const binding = await this.deps.desktopDriver.createThread(
      sessionKey,
      this.buildForkThreadSeedPrompt(title, recentConversation)
    );
    await this.deps.sessionStore.updateBinding(sessionKey, binding.codexThreadRef);
    await this.deps.sessionStore.updateSessionStatus(sessionKey, BridgeSessionStatus.Active, null);

    return `已根据最近几轮对话 fork 新线程：${title}`;
  }

  buildNewThreadSeedPrompt(title: string): string {
    return [
      `线程标题：${title}`,
      "",
      "这是一个刚创建的新线程。",
      "请把上面的标题视为本线程主题。",
      "现在无需展开分析，只需理解上下文并等待我的下一条消息。"
    ].join("\n");
  }

  buildProjectThreadSeedPrompt(alias: string, project: ProjectAlias, task: string): string {
    return [
      `Project alias: ${alias}`,
      `Project label: ${project.label ?? alias}`,
      `Working directory: ${project.cwd}`,
      "",
      "Task:",
      task,
      "",
      "Please treat the working directory above as the target project for this thread."
    ].join("\n");
  }

  resolveProjectAlias(alias: string): ProjectAlias | null {
    const aliases = this.deps.projectAliases ?? {};
    const exact = aliases[alias];
    if (exact) {
      return exact;
    }

    const normalized = alias.toLowerCase();
    const matched = Object.entries(aliases).find(([name]) => name.toLowerCase() === normalized);
    return matched?.[1] ?? null;
  }

  buildForkThreadSeedPrompt(title: string, entries: ConversationEntry[]): string {
    const summaryLines = entries.map((entry) => {
      const speaker = entry.direction === "inbound" ? "用户" : "助手";
      return `- ${speaker}：${entry.text}`;
    });

    return [
      `线程标题：${title}`,
      "",
      "这是从另一个 QQ 私聊会话中 fork 出来的新线程。",
      "以下是最近几轮 QQ 对话摘要，请把它们作为本线程的起始上下文：",
      ...(summaryLines.length > 0 ? summaryLines : ["- 暂无可用对话摘要"]),
      "",
      "请理解上下文，等待我的下一条消息。"
    ].join("\n");
  }
}

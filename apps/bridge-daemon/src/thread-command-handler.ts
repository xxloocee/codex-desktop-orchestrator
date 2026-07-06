import { randomUUID } from "node:crypto";
import { BridgeSessionStatus, type BridgeSession, type ConversationProviderKind } from "../../../packages/domain/src/session.js";
import { BridgeTurnStatus, type BridgeTurnRecord } from "../../../packages/domain/src/turn.js";
import type { ChatgptDesktopDriver } from "../../../packages/adapters/chatgpt-desktop/src/driver.js";
import { ensureAppVisible } from "../../../packages/adapters/chatgpt-desktop/src/ax-client.js";
import { DesktopDriverError, type CodexControlState } from "../../../packages/domain/src/driver.js";
import {
  DeliveryJobStatus,
  type ConversationEntry,
  type DeliveryJobRecord,
  type InboundMessage,
  type OutboundDraft
} from "../../../packages/domain/src/message.js";
import type { DesktopDriverPort } from "../../../packages/ports/src/conversation.js";
import type { QqEgressPort } from "../../../packages/ports/src/qq.js";
import type {
  DeliveryJobStorePort,
  SessionStorePort,
  TranscriptStorePort,
  TurnStorePort
} from "../../../packages/ports/src/store.js";
import {
  markSynchronousDeliveryFailure,
  markSynchronousDeliveryResult
} from "../../../packages/orchestrator/src/delivery-worker.js";
import type { AppConfig } from "./config.js";

type ThreadCommandHandlerDeps = {
  sessionStore: SessionStorePort;
  transcriptStore: TranscriptStorePort;
  turnStore?: TurnStorePort;
  deliveryJobStore?: DeliveryJobStorePort;
  desktopDriver: DesktopDriverPort;
  qqEgress: QqEgressPort;
  chatgptDesktopAvailable?: boolean;
  chatgptDriver?: ChatgptDesktopDriver;
  accountKeys?: string[];
  projectAliases?: AppConfig["projectAliases"];
};

export class ThreadCommandHandler {
  private readonly chatgptThreadListRefreshSessionKeys = new Set<string>();

  constructor(private readonly deps: ThreadCommandHandlerDeps) {}

  async handleIfCommand(message: InboundMessage): Promise<boolean> {
    if (message.chatType !== "c2c") {
      return false;
    }

    const text = message.text.trim();
    if (this.isCancelCommand(text)) {
      const alreadySeen = await this.deps.transcriptStore.hasInbound(message.messageId);
      if (alreadySeen) {
        return true;
      }

      await this.deps.transcriptStore.recordInbound(message);
      await this.handleCancelCommand(message, text);
      return true;
    }

    if (!text.startsWith("/")) {
      return false;
    }
    const supportedCommand = this.isSupportedCommand(text);

    if (this.isTaskQueryCommand(text)) {
      const alreadySeen = await this.deps.transcriptStore.hasInbound(message.messageId);
      if (alreadySeen) {
        return true;
      }

      await this.deps.transcriptStore.recordInbound(message);
      await this.handleTaskQueryCommand(message, text);
      return true;
    }

    if (this.isDeliveryQueryCommand(text)) {
      const alreadySeen = await this.deps.transcriptStore.hasInbound(message.messageId);
      if (alreadySeen) {
        return true;
      }

      await this.deps.transcriptStore.recordInbound(message);
      await this.handleDeliveryQueryCommand(message);
      return true;
    }

    const alreadySeen = await this.deps.transcriptStore.hasInbound(message.messageId);
    if (alreadySeen) {
      return true;
    }

    await this.deps.sessionStore.withSessionLock(message.sessionKey, async () => {
      const seenInsideLock = await this.deps.transcriptStore.hasInbound(message.messageId);
      if (seenInsideLock) {
        return;
      }

      await this.ensureSessionExists(message);
      await this.deps.transcriptStore.recordInbound(message);

      if (!supportedCommand) {
        const session = await this.deps.sessionStore.getSession(message.sessionKey);
        await this.deliverControlReply(
          message,
          this.buildUnknownCommandText(text, this.currentProvider(session))
        );
        return;
      }

      if (text === "/threads" || text === "/t") {
        const session = await this.deps.sessionStore.getSession(message.sessionKey);
        if (this.currentProvider(session) === "chatgpt-desktop") {
          await this.deliverChatgptThreads(message, session);
          return;
        }
        const threads = await this.deps.desktopDriver.listRecentThreads(20);
        await this.deliverControlReply(
          message,
          this.formatThreads(threads, session?.codexThreadRef ?? null)
        );
        return;
      }

      if (text === "/thread current" || text === "/tc") {
        const session = await this.deps.sessionStore.getSession(message.sessionKey);
        if (this.currentProvider(session) === "chatgpt-desktop") {
          await this.deliverChatgptCurrentThread(message, session);
          return;
        }
        const threads = await this.deps.desktopDriver.listRecentThreads(20);
        const current = threads.find(
          (thread) =>
            session?.codexThreadRef
            && areThreadRefsEquivalent(thread.threadRef, session.codexThreadRef)
        )
          ?? threads.find((thread) => thread.isCurrent)
          ?? null;
        const reply = current
          ? `当前绑定线程：${current.title}${current.projectName ? `\n项目：${current.projectName}` : ""}${current.relativeTime ? `\n最近活动：${current.relativeTime}` : ""}`
          : "当前私聊还没有绑定线程。";
        await this.deliverControlReply(message, reply);
        return;
      }

      const sourceMatch = text.match(/^\/source\s+(codex|chatgpt)$/);
      if (sourceMatch) {
        const target = sourceMatch[1] === "chatgpt" ? "chatgpt-desktop" : "codex-desktop";
        await this.deps.sessionStore.updateConversationProvider(message.sessionKey, target);
        if (target === "chatgpt-desktop") {
          this.chatgptThreadListRefreshSessionKeys.add(message.sessionKey);
        } else {
          this.chatgptThreadListRefreshSessionKeys.delete(message.sessionKey);
        }
        const label = target === "chatgpt-desktop" ? "ChatGPT Desktop" : "Codex Desktop";
        await this.deliverControlReply(message, `已切换对话源：${label}\n后续消息将通过 ${label} 回复。`);
        return;
      }

      if (text === "/source") {
        const session = await this.deps.sessionStore.getSession(message.sessionKey);
        const current = session?.conversationProvider ?? "codex-desktop（全局默认）";
        await this.deliverControlReply(message, `当前对话源：${current}\n切换：/source codex 或 /source chatgpt`);
        return;
      }

      if (text === "/accounts") {
        const session = await this.deps.sessionStore.getSession(message.sessionKey);
        await this.deliverControlReply(message, this.buildAccountsText(message, session));
        return;
      }

      if (text === "/projects") {
        await this.deliverControlReply(message, await this.buildProjectsText());
        return;
      }

      if (text === "/aliases") {
        await this.deliverControlReply(message, this.buildProjectAliasesText());
        return;
      }

      if (text === "/cgpt" || text === "/cgpt threads") {
        const session = await this.deps.sessionStore.getSession(message.sessionKey);
        await this.deliverChatgptThreads(message, session);
        return;
      }

      const cgptUseMatch = text.match(/^\/cgpt\s+use\s+(\d+)$/);
      if (cgptUseMatch) {
        const cgDriver = this.deps.chatgptDriver;
        if (!cgDriver) {
          await this.deliverControlReply(message, "ChatGPT Desktop 未启用。");
          return;
        }
        const index = Number(cgptUseMatch[1]);
        const chats = cgDriver.listChats(20);
        const target = chats[index - 1];
        if (!target) {
          await this.deliverControlReply(message, `没有第 ${index} 条对话，请先发 /cgpt 查看列表。`);
          return;
        }
        const switched = cgDriver.switchToChat(target.title);
        if (!switched) {
          await this.deliverControlReply(message, `切换失败：在侧边栏未找到「${target.title}」，请重试或刷新列表。`);
          return;
        }
        // 写入当前对话标题，下次 run() 检测到后跳过 clickNewChat
        cgDriver.markSwitched(message.sessionKey, target.title);
        await this.deps.sessionStore.updateConversationProvider(message.sessionKey, "chatgpt-desktop");
        await this.deps.sessionStore.updateSessionStatus(message.sessionKey, BridgeSessionStatus.Active, null);
        await this.deliverControlReply(message, `已切换到 ChatGPT 对话：${target.title}\n下次消息将继续该对话。`);
        return;
      }

      if (text === "/cgpt new") {
        const session = await this.deps.sessionStore.getSession(message.sessionKey);
        await this.createChatgptThread(message, session);
        return;
      }

      if (text === "/help") {
        const session = await this.deps.sessionStore.getSession(message.sessionKey);
        await this.deliverControlReply(message, this.buildHelpText(this.currentProvider(session)));
        return;
      }

      if (text === "/h") {
        const session = await this.deps.sessionStore.getSession(message.sessionKey);
        await this.deliverControlReply(message, this.buildHelpText(this.currentProvider(session)));
        return;
      }

      if (text === "/model" || text === "/m") {
        const state = await this.deps.desktopDriver.getControlState();
        await this.deliverControlReply(message, this.formatModelReply(state));
        return;
      }

      const switchModelMatch = text.match(/^(?:\/model\s+use|\/mu)\s+(.+)$/);
      if (switchModelMatch) {
        const targetModel = switchModelMatch[1].trim();
        try {
          const state = await this.deps.desktopDriver.switchModel(targetModel);
          await this.deliverControlReply(message, this.formatModelSwitchReply(targetModel, state));
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          await this.deliverControlReply(
            message,
            `切换模型失败：${reason}\n请检查模型名称是否正确，或当前 Codex Desktop 界面是否可操作。`
          );
        }
        return;
      }

      if (text === "/quota" || text === "/q") {
        const quotaSummary = await this.deps.desktopDriver.getQuotaSummary();
        await this.deliverControlReply(message, this.formatQuotaReply(quotaSummary));
        return;
      }

      if (text === "/status" || text === "/st") {
        const session = await this.deps.sessionStore.getSession(message.sessionKey);
        const state = await this.deps.desktopDriver.getControlState(
          session
            ? {
                sessionKey: session.sessionKey,
                codexThreadRef: session.codexThreadRef
              }
            : null
        );
        const quotaSummary = await this.deps.desktopDriver.getQuotaSummary();
        await this.deliverControlReply(message, this.formatStatusReply(session, state, quotaSummary));
        return;
      }

      if (text === "/代码审查") {
        await this.handleCodeReviewCommand(message);
        return;
      }

      const useMatch = text.match(/^(?:\/thread\s+use|\/tu)\s+(\d+)$/);
      if (useMatch) {
        const index = Number(useMatch[1]);
        const session = await this.deps.sessionStore.getSession(message.sessionKey);
        if (this.currentProvider(session) === "chatgpt-desktop") {
          await this.useChatgptThread(message, index);
          return;
        }
        const threads = await this.deps.desktopDriver.listRecentThreads(20);
        const thread = threads[index - 1];
        if (!thread) {
          await this.deliverControlReply(message, `没有第 ${index} 个线程。请先发送 /threads 查看列表。`);
          return;
        }

        let binding;
        try {
          binding = await this.deps.desktopDriver.switchToThread(message.sessionKey, thread.threadRef);
        } catch (error) {
          if (error instanceof DesktopDriverError && error.reason === "session_not_found") {
            await this.deliverControlReply(
              message,
              `切换失败：没有在当前 Codex 侧边栏里找到这个线程。\n请先发送 /t 刷新列表后重试。`
            );
            return;
          }
          throw error;
        }
        await this.deps.sessionStore.updateBinding(message.sessionKey, binding.codexThreadRef);
        await this.deps.sessionStore.updateSessionStatus(message.sessionKey, BridgeSessionStatus.Active, null);
        await this.deps.sessionStore.updateSkillContextKey(message.sessionKey, null);
        await this.deliverControlReply(
          message,
          [
            `已切换到线程：${thread.title}`,
            ...(thread.projectName ? [`项目：${thread.projectName}`] : []),
            `绑定标识：${binding.codexThreadRef ?? "未绑定"}`
          ].join("\n")
        );
        return;
      }

      const newMatch = text.match(/^(?:\/thread\s+new|\/tn)\s+(.+)$/);
      if (newMatch) {
        const title = newMatch[1].trim();
        const session = await this.deps.sessionStore.getSession(message.sessionKey);
        if (this.currentProvider(session) === "chatgpt-desktop") {
          await this.createChatgptThread(message, session);
          return;
        }
        const binding = await this.deps.desktopDriver.createThread(
          message.sessionKey,
          this.buildNewThreadSeedPrompt(title)
        );
        await this.deps.sessionStore.updateBinding(message.sessionKey, binding.codexThreadRef);
        await this.deps.sessionStore.updateSessionStatus(message.sessionKey, BridgeSessionStatus.Active, null);
        await this.deliverControlReply(message, `已创建并切换到新线程：${title}`);
        return;
      }

      const projectNewMatch = text.match(/^\/new\s+(\S+)\s+([\s\S]+)$/);
      if (projectNewMatch) {
        const alias = projectNewMatch[1].trim();
        const task = projectNewMatch[2].trim();
        const project = this.resolveProjectAlias(alias);
        if (!project) {
          await this.deliverControlReply(message, this.buildUnknownProjectText(alias));
          return;
        }

        const binding = await this.deps.desktopDriver.createThread(
          message.sessionKey,
          this.buildProjectThreadSeedPrompt(alias, project, task),
          {
            cwd: project.cwd
          }
        );
        await this.deps.sessionStore.updateConversationProvider(message.sessionKey, "codex-desktop");
        await this.deps.sessionStore.updateBinding(message.sessionKey, binding.codexThreadRef);
        await this.deps.sessionStore.updateSessionStatus(message.sessionKey, BridgeSessionStatus.Active, null);
        await this.deps.sessionStore.updateSkillContextKey(message.sessionKey, null);
        await this.deliverControlReply(
          message,
          [
            `Created Codex thread for project: ${project.label ?? alias}`,
            `Alias: ${alias}`,
            `cwd: ${project.cwd}`,
            `Binding: ${binding.codexThreadRef ?? "unbound"}`
          ].join("\n")
        );
        return;
      }

      const forkMatch = text.match(/^(?:\/thread\s+fork|\/tf)\s+(.+)$/);
      if (forkMatch) {
        const title = forkMatch[1].trim();
        const session = await this.deps.sessionStore.getSession(message.sessionKey);
        if (this.currentProvider(session) === "chatgpt-desktop") {
          await this.createChatgptThread(message, session);
          return;
        }
        const recentConversation = await this.deps.transcriptStore.listRecentConversation(
          message.sessionKey,
          8
        );
        const binding = await this.deps.desktopDriver.createThread(
          message.sessionKey,
          this.buildForkThreadSeedPrompt(title, recentConversation)
        );
        await this.deps.sessionStore.updateBinding(message.sessionKey, binding.codexThreadRef);
        await this.deps.sessionStore.updateSessionStatus(message.sessionKey, BridgeSessionStatus.Active, null);
        await this.deliverControlReply(message, `已根据最近几轮对话 fork 新线程：${title}`);
        return;
      }

      await this.deliverControlReply(
        message,
        this.buildHelpText(this.currentProvider(await this.deps.sessionStore.getSession(message.sessionKey)))
      );
    });

    return true;
  }

  private async ensureSessionExists(message: InboundMessage): Promise<void> {
    const existing = await this.deps.sessionStore.getSession(message.sessionKey);
    if (existing) {
      return;
    }

    const created: BridgeSession = {
      sessionKey: message.sessionKey,
      accountKey: message.accountKey,
      peerKey: message.peerKey,
      chatType: message.chatType,
      peerId: message.senderId,
      codexThreadRef: null,
      lastCodexTurnId: null,
      skillContextKey: null,
      conversationProvider: null,
      status: BridgeSessionStatus.Active,
      lastInboundAt: message.receivedAt,
      lastOutboundAt: null,
      lastError: null
    };

    await this.deps.sessionStore.createSession(created);
  }

  private isSupportedCommand(text: string): boolean {
    return (
      text === "/threads" ||
      text === "/t" ||
      text === "/thread current" ||
      text === "/tc" ||
      text === "/help" ||
      text === "/h" ||
      text === "/accounts" ||
      text === "/tasks" ||
      text === "/task current" ||
      this.isCancelCommand(text) ||
      this.isDeliveryQueryCommand(text) ||
      text === "/model" ||
      text === "/m" ||
      text === "/quota" ||
      text === "/q" ||
      text === "/status" ||
      text === "/st" ||
      text === "/代码审查" ||
      /^\/thread\s+use\s+\d+$/.test(text) ||
      /^\/tu\s+\d+$/.test(text) ||
      /^\/model\s+use\s+.+$/.test(text) ||
      /^\/mu\s+.+$/.test(text) ||
      /^\/thread\s+new\s+.+$/.test(text) ||
      /^\/tn\s+.+$/.test(text) ||
      /^\/new\s+\S+\s+[\s\S]+$/.test(text) ||
      /^\/thread\s+fork\s+.+$/.test(text) ||
      /^\/tf\s+.+$/.test(text) ||
      text === "/thread" ||
      text === "/projects" ||
      text === "/aliases" ||
      text === "/cgpt" ||
      text === "/cgpt threads" ||
      text === "/cgpt new" ||
      /^\/cgpt\s+use\s+\d+$/.test(text) ||
      text === "/source" ||
      /^\/source\s+(codex|chatgpt)$/.test(text)
    );
  }

  private isCancelCommand(text: string): boolean {
    return (
      text === "/cancel" ||
      /^\/cancel\s+\S+$/.test(text) ||
      /^(?:停止任务|取消任务|停止当前任务|取消当前任务)(?:\s+\S+)?$/.test(text)
    );
  }

  private getCancelCommandTaskId(text: string): string | null {
    return text.match(/^\/cancel\s+(\S+)$/)?.[1]
      ?? text.match(/^(?:停止任务|取消任务|停止当前任务|取消当前任务)\s+(\S+)$/)?.[1]
      ?? null;
  }

  private isTaskQueryCommand(text: string): boolean {
    return text === "/task current" || text === "/tasks";
  }

  private isDeliveryQueryCommand(text: string): boolean {
    return text === "/deliveries" || text === "/delivery jobs";
  }

  private formatThreads(
    threads: Array<{
      index: number;
      title: string;
      projectName: string | null;
      relativeTime: string | null;
      isCurrent: boolean;
      threadRef?: string;
    }>,
    boundThreadRef: string | null = null
  ): string {
    if (threads.length === 0) {
      return "当前没有可用的 Codex 线程。";
    }

    const escapeCell = (value: string | null) =>
      (value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ").trim();

    return [
      "最近 20 条最近有消息活动的 Codex 线程：",
      "",
      "| 序号 | 项目 | 线程标题 | 最近活动 |",
      "| --- | --- | --- | --- |",
      ...threads.map((thread) => {
        const isBound = Boolean(
          boundThreadRef
          && thread.threadRef
          && areThreadRefsEquivalent(thread.threadRef, boundThreadRef)
        );
        const shouldMark = boundThreadRef ? isBound : thread.isCurrent;
        const index = shouldMark ? `👉🏻 ${thread.index}` : `${thread.index}`;
        const project = escapeCell(thread.projectName) || "-";
        const title = escapeCell(thread.title) || "-";
        const time = escapeCell(thread.relativeTime) || "-";
        return `| ${index} | ${project} | ${title} | ${time} |`;
      })
    ].join("\n");
  }

  private currentProvider(session: BridgeSession | null): ConversationProviderKind {
    return session?.conversationProvider ?? "codex-desktop";
  }

  private async deliverChatgptThreads(
    message: InboundMessage,
    session: BridgeSession | null
  ): Promise<void> {
    const cgDriver = this.deps.chatgptDriver;
    if (!cgDriver) {
      await this.deliverControlReply(message, "ChatGPT Desktop 未启用，请先 /source chatgpt 切换。");
      return;
    }
    const shouldRefresh = this.chatgptThreadListRefreshSessionKeys.delete(message.sessionKey);
    try { ensureAppVisible(); } catch { /* non-fatal */ }
    const currentRef = session ? cgDriver.getSessionThreadRef(session.sessionKey) : null;
    const currentWindowTitle = cgDriver.getCurrentThreadTitle();
    const chats = this.listChatgptChats(cgDriver, shouldRefresh);
    if (chats.length === 0) {
      await this.deliverControlReply(message, "ChatGPT 侧边栏未读取到对话列表。请确保 ChatGPT Desktop 已启动且有历史对话。");
      return;
    }
    const escapeCell = (v: string) => v.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
    const lines = [
      "最近 20 条 ChatGPT 对话：",
      "",
      "| 序号 | 对话标题 |",
      "| --- | --- |",
      ...chats.map((c) => {
        const mark = this.isCurrentChatgptChat(c.title, currentRef, currentWindowTitle) ? "👉🏻 " : "";
        return `| ${mark}${c.index} | ${escapeCell(c.title)} |`;
      })
    ];
    await this.deliverControlReply(message, lines.join("\n"));
  }

  private listChatgptChats(cgDriver: ChatgptDesktopDriver, shouldRefresh: boolean) {
    const chats = cgDriver.listChats(20);
    if (!shouldRefresh && chats.length > 0) {
      return chats;
    }

    const refreshedChats = cgDriver.listChats(20);
    return refreshedChats.length > 0 ? refreshedChats : chats;
  }

  private async deliverChatgptCurrentThread(
    message: InboundMessage,
    session: BridgeSession | null
  ): Promise<void> {
    const cgDriver = this.deps.chatgptDriver;
    if (!cgDriver) {
      await this.deliverControlReply(message, "ChatGPT Desktop 未启用，请先 /source chatgpt 切换。");
      return;
    }
    const currentRef = session ? cgDriver.getSessionThreadRef(session.sessionKey) : null;
    await this.deliverControlReply(
      message,
      currentRef ? `当前绑定 ChatGPT 对话：${currentRef}` : "当前私聊还没有绑定 ChatGPT 对话。"
    );
  }

  private async useChatgptThread(message: InboundMessage, index: number): Promise<void> {
    const cgDriver = this.deps.chatgptDriver;
    if (!cgDriver) {
      await this.deliverControlReply(message, "ChatGPT Desktop 未启用。");
      return;
    }
    const chats = cgDriver.listChats(20);
    const target = chats[index - 1];
    if (!target) {
      await this.deliverControlReply(message, `没有第 ${index} 条 ChatGPT 对话，请先发 /threads 查看列表。`);
      return;
    }
    const switched = cgDriver.switchToChat(target.title);
    if (!switched) {
      await this.deliverControlReply(message, `切换失败：在 ChatGPT 侧边栏未找到「${target.title}」，请重试或刷新列表。`);
      return;
    }
    cgDriver.markSwitched(message.sessionKey, target.title);
    await this.deps.sessionStore.updateConversationProvider(message.sessionKey, "chatgpt-desktop");
    await this.deps.sessionStore.updateSessionStatus(message.sessionKey, BridgeSessionStatus.Active, null);
    await this.deliverControlReply(message, `已切换到 ChatGPT 对话：${target.title}\n下次消息将继续该对话。`);
  }

  private isCurrentChatgptChat(
    title: string,
    currentRef: string | null,
    currentWindowTitle: string | null
  ): boolean {
    const normalizedTitle = normalizeChatgptTitle(title);
    const normalizedRef = currentRef && currentRef !== "__switched__"
      ? normalizeChatgptTitle(currentRef)
      : "";
    if (normalizedRef && normalizedTitle === normalizedRef) {
      return true;
    }

    const normalizedWindowTitle = currentWindowTitle ? normalizeChatgptTitle(currentWindowTitle) : "";
    return Boolean(
      normalizedWindowTitle
      && normalizedTitle
      && (
        normalizedWindowTitle === normalizedTitle
        || normalizedWindowTitle.includes(normalizedTitle)
      )
    );
  }

  private async createChatgptThread(
    message: InboundMessage,
    session: BridgeSession | null
  ): Promise<void> {
    const cgDriver = this.deps.chatgptDriver;
    if (!cgDriver) {
      await this.deliverControlReply(message, "ChatGPT Desktop 未启用。");
      return;
    }
    cgDriver.newChat(session?.sessionKey ?? message.sessionKey);
    await this.deps.sessionStore.updateConversationProvider(message.sessionKey, "chatgpt-desktop");
    await this.deps.sessionStore.updateSessionStatus(message.sessionKey, BridgeSessionStatus.Active, null);
    await this.deliverControlReply(message, "已为本会话新建 ChatGPT 对话，下条消息将从新对话开始。");
  }

  private async deliverControlReply(message: InboundMessage, text: string): Promise<void> {
    const draft: OutboundDraft = {
      draftId: randomUUID(),
      sessionKey: message.sessionKey,
      text,
      createdAt: new Date().toISOString(),
      replyToMessageId: message.messageId
    };

    await this.deliverDraft(draft);
  }

  private async deliverDraft(draft: OutboundDraft): Promise<void> {
    await this.deps.transcriptStore.recordOutbound(draft);
    try {
      const delivery = await this.deps.qqEgress.deliver(draft);
      await markSynchronousDeliveryResult(this.deps.deliveryJobStore, draft, delivery);
    } catch (error) {
      await markSynchronousDeliveryFailure(this.deps.deliveryJobStore, draft, error);
      throw error;
    }
  }

  private async handleCodeReviewCommand(message: InboundMessage): Promise<void> {
    const session = await this.deps.sessionStore.getSession(message.sessionKey);
    const currentBinding = session
      && session.status === BridgeSessionStatus.Active
      ? {
          sessionKey: session.sessionKey,
          codexThreadRef: session.codexThreadRef
        }
      : null;
    const binding = await this.deps.desktopDriver.openOrBindSession(
      message.sessionKey,
      currentBinding
    );

    if (session?.codexThreadRef !== binding.codexThreadRef) {
      await this.deps.sessionStore.updateBinding(message.sessionKey, binding.codexThreadRef);
    }
    await this.deps.sessionStore.updateSessionStatus(message.sessionKey, BridgeSessionStatus.Active, null);

    await this.deps.desktopDriver.sendUserMessage(binding, {
      ...message,
      text: "/审查"
    });

    const drafts = await this.deps.desktopDriver.collectAssistantReply(binding);
    if (drafts.length === 0) {
      await this.deliverControlReply(message, "已触发 Codex 代码审查。");
      return;
    }

    for (const draft of drafts) {
      await this.deliverDraft({
        ...draft,
        replyToMessageId: draft.replyToMessageId ?? message.messageId
      });
    }
  }

  private buildHelpText(provider: ConversationProviderKind = "codex-desktop"): string {
    if (provider === "chatgpt-desktop") {
      return [
        "快捷命令（当前源：ChatGPT Desktop）：",
        "",
        "| 用途 | 完整命令 | 简写 |",
        "| --- | --- | --- |",
        "| 查看 ChatGPT 最近对话 | `/threads` | `/t` |",
        "| 查看当前绑定 ChatGPT 对话 | `/thread current` | `/tc` |",
        "| 切换 ChatGPT 对话 | `/thread use <序号>` | `/tu <序号>` |",
        "| 新建 ChatGPT 对话 | `/thread new <标题>` | `/tn <标题>` |",
        "| 查看当前对话源 | `/source` | - |",
        "| 查看账号状态 | `/accounts` | - |",
        "| 切换到 Codex Desktop | `/source codex` | - |",
        "| 查看任务/投递状态 | `/tasks`、`/deliveries` | - |",
        "| 取消当前任务 | `/cancel` | - |",
        "| 查看/切换 ChatGPT 对话 | `/cgpt`、`/cgpt use <序号>` | - |",
        "| 新建 ChatGPT 对话 | `/cgpt new` | - |",
        "| 查看帮助 | `/help` | `/h` |",
        "",
        "建议先发 `/t` 刷新并查看 ChatGPT 对话列表，再用 `/tu 2` 切换。",
        "模型、额度、状态和真正的 fork 命令目前只适用于 Codex Desktop。"
      ].join("\n");
    }

    return [
      "快捷命令（当前源：Codex Desktop）：",
      "",
      "| 用途 | 完整命令 | 简写 |",
      "| --- | --- | --- |",
      "| 查看 Codex 最近线程 | `/threads` | `/t` |",
      "| 查看当前绑定 Codex 线程 | `/thread current` | `/tc` |",
      "| 切换 Codex 线程 | `/thread use <序号>` | `/tu <序号>` |",
      "| 新建 Codex 线程 | `/thread new <标题>` | `/tn <标题>` |",
      "| 基于最近对话 fork Codex 线程 | `/thread fork <标题>` | `/tf <标题>` |",
      "| 查看当前模型 | `/model` | `/m` |",
      "| 切换模型 | `/model use <名称>` | `/mu <名称>` |",
      "| 查看额度信息 | `/quota` | `/q` |",
      "| 查看当前运行状态 | `/status` | `/st` |",
      "| 调用 Codex 代码审查 | `/代码审查` | - |",
      "| 查看当前对话源 | `/source` | - |",
      "| 查看账号状态 | `/accounts` | - |",
      "| 查看任务/投递状态 | `/tasks`、`/deliveries` | - |",
      "| 取消当前任务 | `/cancel` | - |",
      "| 查看项目/别名 | `/projects`、`/aliases` | - |",
      "| 按项目新建 Codex 线程 | `/new <别名> <任务>` | - |",
      "| 查看/切换 ChatGPT 对话 | `/cgpt`、`/cgpt use <序号>` | - |",
      "| 新建 ChatGPT 对话 | `/cgpt new` | - |",
      "| 查看帮助 | `/help` | `/h` |",
      "| 切换到 ChatGPT Desktop | `/source chatgpt` | - |",
      "| 切换到 Codex Desktop | `/source codex` | - |",
      "",
      "所有 `/` 开头的桥接快捷指令都会先由桥接层处理，不会直接发给 Codex。",
      "建议先用 `/source` 确认当前对话源，再发 `/t` 看列表，用 `/tu 2` 切换。",
      "切到 ChatGPT 后，这套 `/t`、`/tu`、`/tn` 会自动操作 ChatGPT 对话。"
    ].join("\n");
  }

  private buildUnknownCommandText(text: string, provider: ConversationProviderKind): string {
    return [
      `未识别的桥接快捷指令：\`${text}\``,
      "这条 `/` 指令不会转发给当前对话源。",
      "",
      this.buildHelpText(provider)
    ].join("\n");
  }

  private buildAccountsText(message: InboundMessage, session: BridgeSession | null): string {
    const currentProvider = this.currentProvider(session);
    const accountKeys = [...new Set(this.deps.accountKeys ?? [message.accountKey])].sort();
    return [
      "账号状态：",
      "",
      "| 项目 | 值 |",
      "| --- | --- |",
      `| 当前账号 | ${escapeMarkdownCell(message.accountKey)} |`,
      `| 当前来源 | ${message.accountKey.startsWith("weixin:") ? "微信" : "QQ"} |`,
      `| 当前会话 | ${escapeMarkdownCell(message.sessionKey)} |`,
      `| 当前对话源 | ${currentProvider} |`,
      `| 已接入账号 | ${accountKeys.map(escapeMarkdownCell).join(", ")} |`
    ].join("\n");
  }

  private async buildCurrentTaskText(sessionKey: string): Promise<string> {
    if (!this.deps.turnStore) {
      return "Task tracking is not configured.";
    }

    const turn = await this.deps.turnStore.getCurrentTurn(sessionKey);
    if (!turn) {
      return "No active task for this conversation.";
    }

    return [
      "Current task:",
      this.formatTurnSummary(turn),
      ...(turn.lastError ? [`Last error: ${turn.lastError}`] : []),
      "",
      "Use /tasks to see recent task history."
    ].join("\n");
  }

  private async handleTaskQueryCommand(message: InboundMessage, text: string): Promise<void> {
    await this.deliverControlReply(
      message,
      text === "/task current"
        ? await this.buildCurrentTaskText(message.sessionKey)
        : await this.buildTasksText(message.sessionKey)
    );
  }

  private async handleDeliveryQueryCommand(message: InboundMessage): Promise<void> {
    if (!this.deps.deliveryJobStore) {
      await this.deliverControlReply(message, "Delivery queue is not configured.");
      return;
    }

    const jobs = await this.deps.deliveryJobStore.listJobs({
      sessionKey: message.sessionKey,
      statuses: [
        DeliveryJobStatus.Pending,
        DeliveryJobStatus.InFlight,
        DeliveryJobStatus.Failed
      ],
      limit: 10
    });
    await this.deliverControlReply(message, this.formatDeliveryJobs(jobs));
  }

  private async handleCancelCommand(message: InboundMessage, text: string): Promise<void> {
    if (!this.deps.turnStore) {
      await this.deliverControlReply(message, "Task tracking is not configured.");
      return;
    }

    const current = await this.deps.turnStore.getCurrentTurn(message.sessionKey);
    if (!current) {
      await this.deliverControlReply(message, "No active task to cancel for this conversation.");
      return;
    }

    const requestedTaskId = this.getCancelCommandTaskId(text);
    if (requestedTaskId && !doesTurnIdMatchRequest(current.turnId, requestedTaskId)) {
      await this.deliverControlReply(
        message,
        [
          `No active task matches: ${requestedTaskId}`,
          `Current task: ${current.turnId}`,
          "Use /tasks to inspect recent task IDs."
        ].join("\n")
      );
      return;
    }

    let interrupted = false;
    let interruptError: string | null = null;
    if (this.deps.desktopDriver.interruptActiveTurn) {
      try {
        interrupted = await this.deps.desktopDriver.interruptActiveTurn(message.sessionKey);
      } catch (error) {
        interruptError = error instanceof Error ? error.message : String(error);
      }
    }

    if (interruptError) {
      await this.deps.turnStore.updateStatus(current.turnId, current.status, interruptError);
      await this.deliverControlReply(
        message,
        [
          `Cancel failed for task: ${current.turnId}`,
          `Interrupt error: ${interruptError}`
        ].join("\n")
      );
      return;
    }

    await this.deps.turnStore.updateStatus(
      current.turnId,
      BridgeTurnStatus.Cancelled,
      null
    );

    await this.deliverControlReply(
      message,
      [
        `Cancelled task: ${current.turnId}`,
        interrupted
          ? "Codex turn interrupt sent."
          : "No active Codex turn was found in the driver; future output from this task will be suppressed.",
        ...(interruptError ? [`Interrupt error: ${interruptError}`] : [])
      ].join("\n")
    );
  }

  private async buildTasksText(sessionKey: string): Promise<string> {
    if (!this.deps.turnStore) {
      return "Task tracking is not configured.";
    }

    const turns = await this.deps.turnStore.listRecentTurns(sessionKey, 10);
    if (turns.length === 0) {
      return "No task history for this conversation yet.";
    }

    return [
      "Recent tasks:",
      "",
      "| Task | Status | Updated | Error |",
      "| --- | --- | --- | --- |",
      ...turns.map((turn) =>
        `| ${escapeMarkdownCell(shortTurnId(turn.turnId))} | ${escapeMarkdownCell(turn.status)} | ${escapeMarkdownCell(formatRelativeTimestamp(turn.updatedAt))} | ${escapeMarkdownCell(turn.lastError ?? "-")} |`
      )
    ].join("\n");
  }

  private formatTurnSummary(turn: BridgeTurnRecord): string {
    return [
      `Task ID: ${turn.turnId}`,
      `Status: ${turn.status}`,
      `Message: ${turn.qqMessageId}`,
      ...(turn.codexTurnRef ? [`Codex turn: ${turn.codexTurnRef}`] : []),
      ...(turn.codexThreadRef ? [`Thread: ${turn.codexThreadRef}`] : []),
      `Started: ${formatRelativeTimestamp(turn.startedAt)}`,
      `Updated: ${formatRelativeTimestamp(turn.updatedAt)}`
    ].join("\n");
  }

  private formatDeliveryJobs(jobs: DeliveryJobRecord[]): string {
    if (jobs.length === 0) {
      return "No pending or failed delivery jobs for this conversation.";
    }

    return [
      "Delivery jobs:",
      ...jobs.map((job) => [
        `- ${job.jobId}`,
        `  status: ${job.status}`,
        `  attempts: ${job.attemptCount}`,
        `  updated: ${formatRelativeTimestamp(job.updatedAt)}`,
        job.nextAttemptAt ? `  next retry: ${formatRelativeTimestamp(job.nextAttemptAt)}` : null,
        job.lastError ? `  error: ${job.lastError}` : null,
        `  text: ${previewText(job.payload.text)}`
      ].filter(Boolean).join("\n"))
    ].join("\n");
  }

  private async buildProjectsText(): Promise<string> {
    const threads = await this.deps.desktopDriver.listRecentThreads(200);
    const projects = new Map<string, { count: number; latestThread: string; relativeTime: string | null }>();
    for (const thread of threads) {
      const name = thread.projectName?.trim();
      if (!name) {
        continue;
      }
      const existing = projects.get(name);
      if (existing) {
        existing.count += 1;
        continue;
      }
      projects.set(name, {
        count: 1,
        latestThread: thread.title,
        relativeTime: thread.relativeTime
      });
    }

    const entries = [...projects.entries()].sort(([left], [right]) => left.localeCompare(right));
    if (entries.length === 0) {
      return [
        "No Codex Desktop projects found in recent threads.",
        "Use /threads to inspect the current Codex thread list.",
        "Use /aliases to inspect configured cwd aliases for /new <alias> <task>."
      ].join("\n");
    }

    return [
      "Codex Desktop projects from recent threads:",
      "",
      "| Project | Threads | Latest thread | Activity |",
      "| --- | ---: | --- | --- |",
      ...entries.map(([projectName, project]) =>
        `| ${escapeMarkdownCell(projectName)} | ${project.count} | ${escapeMarkdownCell(project.latestThread)} | ${escapeMarkdownCell(project.relativeTime ?? "-")} |`
      ),
      "",
      "Note: /new <alias> <task> uses /aliases, not this recent-project display list."
    ].join("\n");
  }

  private buildProjectAliasesText(): string {
    const entries = Object.entries(this.deps.projectAliases ?? {}).sort(([left], [right]) =>
      left.localeCompare(right)
    );
    if (entries.length === 0) {
      return [
        "No project aliases configured.",
        "Configure projectAliases in runtime config or QQ_CODEX_PROJECT_ALIASES_JSON.",
        "Then use /new <alias> <task> to create a Codex thread in that cwd."
      ].join("\n");
    }

    return [
      "Configured project aliases:",
      "",
      "| Alias | Label | cwd |",
      "| --- | --- | --- |",
      ...entries.map(([alias, project]) =>
        `| ${escapeMarkdownCell(alias)} | ${escapeMarkdownCell(project.label ?? "-")} | ${escapeMarkdownCell(project.cwd)} |`
      ),
      "",
      "Use /new <alias> <task> to create a Codex thread in the alias cwd."
    ].join("\n");
  }

  private buildUnknownProjectText(alias: string): string {
    const names = Object.keys(this.deps.projectAliases ?? {}).sort();
    return [
      `Unknown project alias: ${alias}`,
      names.length > 0 ? `Available aliases: ${names.join(", ")}` : "No project aliases configured.",
      "Use /aliases to inspect configured aliases."
    ].join("\n");
  }

  private formatModelReply(state: CodexControlState): string {
    return [
      `当前模型：${state.model ?? "未识别"}`,
      `推理强度：${state.reasoningEffort ?? "未识别"}`,
      `工作区：${state.workspace ?? "未识别"}`,
      `分支：${state.branch ?? "未识别"}`
    ].join("\n");
  }

  private formatModelSwitchReply(targetModel: string, state: CodexControlState): string {
    return [
      `已切换模型：${state.model ?? targetModel}`,
      `推理强度：${state.reasoningEffort ?? "未识别"}`,
      `工作区：${state.workspace ?? "未识别"}`
    ].join("\n");
  }

  private formatQuotaReply(quotaSummary: string | null): string {
    return `额度信息：${quotaSummary ?? "当前界面未显示明确额度，暂未识别到剩余配额。"}`;
  }

  private formatStatusReply(
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

  private buildNewThreadSeedPrompt(title: string): string {
    return [
      `线程标题：${title}`,
      "",
      "这是一个刚创建的新线程。",
      "请把上面的标题视为本线程主题。",
      "现在无需展开分析，只需理解上下文并等待我的下一条消息。"
    ].join("\n");
  }

  private buildProjectThreadSeedPrompt(
    alias: string,
    project: { cwd: string; label?: string },
    task: string
  ): string {
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

  private resolveProjectAlias(alias: string): { cwd: string; label?: string } | null {
    const aliases = this.deps.projectAliases ?? {};
    const exact = aliases[alias];
    if (exact) {
      return exact;
    }

    const normalized = alias.toLowerCase();
    const matched = Object.entries(aliases).find(([name]) => name.toLowerCase() === normalized);
    return matched?.[1] ?? null;
  }

  private buildForkThreadSeedPrompt(title: string, entries: ConversationEntry[]): string {
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

function areThreadRefsEquivalent(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }

  const leftAppThreadId = extractAppServerThreadId(left);
  const rightAppThreadId = extractAppServerThreadId(right);
  return Boolean(leftAppThreadId && rightAppThreadId && leftAppThreadId === rightAppThreadId);
}

function extractAppServerThreadId(threadRef: string): string | null {
  const prefix = "codex-app-thread:";
  if (!threadRef.startsWith(prefix)) {
    return null;
  }

  const payload = threadRef.slice(prefix.length);
  const separatorIndex = payload.indexOf(":");
  const threadId = separatorIndex >= 0 ? payload.slice(0, separatorIndex) : payload;
  return threadId.trim() ? threadId : null;
}

function normalizeChatgptTitle(value: string): string {
  return value
    .replace(/^chatgpt\s*[-–—:|]?\s*/i, "")
    .replace(/\s*[-–—:|]?\s*chatgpt$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
}

function previewText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "-";
  }

  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

function shortTurnId(turnId: string): string {
  return turnId.length > 18 ? turnId.slice(0, 12) : turnId;
}

function doesTurnIdMatchRequest(turnId: string, requested: string): boolean {
  if (turnId === requested || turnId.startsWith(requested)) {
    return true;
  }

  const compactMatch = requested.match(/^(.+)\.\.\.(.+)$/);
  return Boolean(
    compactMatch
    && turnId.startsWith(compactMatch[1])
    && turnId.endsWith(compactMatch[2])
  );
}

function formatRelativeTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return value;
  }

  const deltaMs = Date.now() - timestamp;
  if (deltaMs < 0) {
    return value;
  }

  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) {
    return `${seconds}s ago`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

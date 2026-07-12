import type { ChatgptDesktopDriver } from "../../../packages/adapters/chatgpt-desktop/src/driver.js";
import { ensureAppVisible } from "../../../packages/adapters/chatgpt-desktop/src/ax-client.js";
import { BridgeSessionStatus, type BridgeSession } from "../../../packages/domain/src/session.js";
import type { SessionStorePort } from "../../../packages/ports/src/store.js";

type ChatgptCommandActionsDeps = {
  chatgptDriver?: ChatgptDesktopDriver;
  sessionStore: Pick<SessionStorePort, "updateConversationProvider" | "updateSessionStatus">;
};

export type UseChatgptThreadMode = "thread-command" | "cgpt-command";

export class ChatgptCommandActions {
  constructor(private readonly deps: ChatgptCommandActionsDeps) {}

  async buildThreadsText(
    session: BridgeSession | null,
    shouldRefresh: boolean
  ): Promise<string> {
    const cgDriver = this.deps.chatgptDriver;
    if (!cgDriver) {
      return "ChatGPT Desktop 未启用，请先 /source chatgpt 切换。";
    }

    try {
      ensureAppVisible();
    } catch {
      // Non-fatal: the accessibility snapshot may still be readable.
    }

    const currentRef = session ? cgDriver.getSessionThreadRef(session.sessionKey) : null;
    const currentWindowTitle = cgDriver.getCurrentThreadTitle();
    const chats = listChatgptChats(cgDriver, shouldRefresh);
    if (chats.length === 0) {
      return "ChatGPT 侧边栏未读取到对话列表。请确保 ChatGPT Desktop 已启动且有历史对话。";
    }

    return [
      "最近 20 条 ChatGPT 对话：",
      "",
      "| 序号 | 对话标题 |",
      "| --- | --- |",
      ...chats.map((chat) => {
        const mark = isCurrentChatgptChat(chat.title, currentRef, currentWindowTitle) ? "👉🏻 " : "";
        return `| ${mark}${chat.index} | ${escapeMarkdownCell(chat.title)} |`;
      })
    ].join("\n");
  }

  buildCurrentThreadText(session: BridgeSession | null): string {
    const cgDriver = this.deps.chatgptDriver;
    if (!cgDriver) {
      return "ChatGPT Desktop 未启用，请先 /source chatgpt 切换。";
    }

    const currentRef = session ? cgDriver.getSessionThreadRef(session.sessionKey) : null;
    return currentRef
      ? `当前绑定 ChatGPT 对话：${currentRef}`
      : "当前私聊还没有绑定 ChatGPT 对话。";
  }

  async useThread(
    sessionKey: string,
    index: number,
    mode: UseChatgptThreadMode
  ): Promise<string> {
    const cgDriver = this.deps.chatgptDriver;
    if (!cgDriver) {
      return "ChatGPT Desktop 未启用。";
    }

    const chats = cgDriver.listChats(20);
    const target = chats[index - 1];
    if (!target) {
      return mode === "cgpt-command"
        ? `没有第 ${index} 条对话，请先发 /cgpt 查看列表。`
        : `没有第 ${index} 条 ChatGPT 对话，请先发 /threads 查看列表。`;
    }

    const switched = cgDriver.switchToChat(target.title);
    if (!switched) {
      return mode === "cgpt-command"
        ? `切换失败：在侧边栏未找到「${target.title}」，请重试或刷新列表。`
        : `切换失败：在 ChatGPT 侧边栏未找到「${target.title}」，请重试或刷新列表。`;
    }

    cgDriver.markSwitched(sessionKey, target.title);
    await this.deps.sessionStore.updateConversationProvider(sessionKey, "chatgpt-desktop");
    await this.deps.sessionStore.updateSessionStatus(sessionKey, BridgeSessionStatus.Active, null);
    return `已切换到 ChatGPT 对话：${target.title}\n下次消息将继续该对话。`;
  }

  async createThread(sessionKey: string, session: BridgeSession | null): Promise<string> {
    const cgDriver = this.deps.chatgptDriver;
    if (!cgDriver) {
      return "ChatGPT Desktop 未启用。";
    }

    cgDriver.newChat(session?.sessionKey ?? sessionKey);
    await this.deps.sessionStore.updateConversationProvider(sessionKey, "chatgpt-desktop");
    await this.deps.sessionStore.updateSessionStatus(sessionKey, BridgeSessionStatus.Active, null);
    return "已为本会话新建 ChatGPT 对话，下条消息将从新对话开始。";
  }
}

function listChatgptChats(cgDriver: ChatgptDesktopDriver, shouldRefresh: boolean) {
  const chats = cgDriver.listChats(20);
  if (!shouldRefresh && chats.length > 0) {
    return chats;
  }

  const refreshedChats = cgDriver.listChats(20);
  return refreshedChats.length > 0 ? refreshedChats : chats;
}

function isCurrentChatgptChat(
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

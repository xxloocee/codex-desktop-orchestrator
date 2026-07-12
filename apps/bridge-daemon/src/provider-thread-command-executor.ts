import type { BridgeSession, ConversationProviderKind } from "../../../packages/domain/src/session.js";
import type { ChatgptCommandActions } from "./chatgpt-command-actions.js";
import type { CodexThreadCommandActions } from "./codex-thread-command-actions.js";

type ProviderThreadCommandExecutorDeps = {
  chatgptCommandActions: Pick<
    ChatgptCommandActions,
    "buildThreadsText" | "buildCurrentThreadText" | "useThread" | "createThread"
  >;
  codexThreadCommandActions: Pick<
    CodexThreadCommandActions,
    "buildThreadsText" | "buildCurrentThreadText" | "useThread" | "createThread" | "forkThread"
  >;
};

export class ProviderThreadCommandExecutor {
  private readonly chatgptThreadListRefreshSessionKeys = new Set<string>();

  constructor(private readonly deps: ProviderThreadCommandExecutorDeps) {}

  setChatgptThreadListRefresh(sessionKey: string, shouldRefresh: boolean): void {
    if (shouldRefresh) {
      this.chatgptThreadListRefreshSessionKeys.add(sessionKey);
      return;
    }

    this.chatgptThreadListRefreshSessionKeys.delete(sessionKey);
  }

  async buildThreadsText(session: BridgeSession | null): Promise<string> {
    if (this.currentProvider(session) === "chatgpt-desktop") {
      return this.buildChatgptThreadsText(session);
    }

    return this.deps.codexThreadCommandActions.buildThreadsText(session);
  }

  async buildCurrentThreadText(session: BridgeSession | null): Promise<string> {
    if (this.currentProvider(session) === "chatgpt-desktop") {
      return this.deps.chatgptCommandActions.buildCurrentThreadText(session);
    }

    return this.deps.codexThreadCommandActions.buildCurrentThreadText(session);
  }

  async buildChatgptThreadsText(session: BridgeSession | null): Promise<string> {
    const shouldRefresh = session
      ? this.chatgptThreadListRefreshSessionKeys.delete(session.sessionKey)
      : false;
    return this.deps.chatgptCommandActions.buildThreadsText(session, shouldRefresh);
  }

  async useChatgptThread(sessionKey: string, index: number): Promise<string> {
    return this.deps.chatgptCommandActions.useThread(sessionKey, index, "cgpt-command");
  }

  async createChatgptThread(sessionKey: string, session: BridgeSession | null): Promise<string> {
    return this.deps.chatgptCommandActions.createThread(sessionKey, session);
  }

  async useThread(
    sessionKey: string,
    session: BridgeSession | null,
    index: number
  ): Promise<string> {
    if (this.currentProvider(session) === "chatgpt-desktop") {
      return this.deps.chatgptCommandActions.useThread(sessionKey, index, "thread-command");
    }

    return this.deps.codexThreadCommandActions.useThread(sessionKey, index);
  }

  async createThread(
    sessionKey: string,
    session: BridgeSession | null,
    title: string
  ): Promise<string> {
    if (this.currentProvider(session) === "chatgpt-desktop") {
      return this.deps.chatgptCommandActions.createThread(sessionKey, session);
    }

    return this.deps.codexThreadCommandActions.createThread(sessionKey, title);
  }

  async forkThread(
    sessionKey: string,
    session: BridgeSession | null,
    title: string
  ): Promise<string> {
    if (this.currentProvider(session) === "chatgpt-desktop") {
      return this.deps.chatgptCommandActions.createThread(sessionKey, session);
    }

    return this.deps.codexThreadCommandActions.forkThread(sessionKey, title);
  }

  private currentProvider(session: BridgeSession | null): ConversationProviderKind {
    return session?.conversationProvider ?? "codex-desktop";
  }
}

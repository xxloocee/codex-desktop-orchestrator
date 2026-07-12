import type { ConversationProviderKind } from "../../../packages/domain/src/session.js";
import type { SessionStorePort } from "../../../packages/ports/src/store.js";

export type SourceCommandTarget = "codex" | "chatgpt";

type SourceCommandActionsDeps = {
  sessionStore: Pick<SessionStorePort, "getSession" | "updateConversationProvider">;
};

export type SwitchSourceResult = {
  provider: ConversationProviderKind;
  refreshChatgptThreads: boolean;
  text: string;
};

export class SourceCommandActions {
  constructor(private readonly deps: SourceCommandActionsDeps) {}

  async switchSource(sessionKey: string, sourceTarget: SourceCommandTarget): Promise<SwitchSourceResult> {
    const provider = toConversationProvider(sourceTarget);
    await this.deps.sessionStore.updateConversationProvider(sessionKey, provider);
    const label = formatProviderLabel(provider);
    return {
      provider,
      refreshChatgptThreads: provider === "chatgpt-desktop",
      text: `已切换对话源：${label}\n后续消息将通过 ${label} 回复。`
    };
  }

  async buildCurrentSourceText(sessionKey: string): Promise<string> {
    const session = await this.deps.sessionStore.getSession(sessionKey);
    const current = session?.conversationProvider ?? "codex-desktop（全局默认）";
    return `当前对话源：${current}\n切换：/source codex 或 /source chatgpt`;
  }
}

function toConversationProvider(sourceTarget: SourceCommandTarget): ConversationProviderKind {
  return sourceTarget === "chatgpt" ? "chatgpt-desktop" : "codex-desktop";
}

function formatProviderLabel(provider: ConversationProviderKind): string {
  return provider === "chatgpt-desktop" ? "ChatGPT Desktop" : "Codex Desktop";
}

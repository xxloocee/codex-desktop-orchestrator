import { BridgeSessionStatus } from "../../../packages/domain/src/session.js";
import type { InboundMessage, OutboundDraft } from "../../../packages/domain/src/message.js";
import type { DesktopDriverPort } from "../../../packages/ports/src/conversation.js";
import type { SessionStorePort } from "../../../packages/ports/src/store.js";

type CodeReviewCommandActionsDeps = {
  sessionStore: Pick<SessionStorePort, "getSession" | "updateBinding" | "updateSessionStatus">;
  desktopDriver: Pick<
    DesktopDriverPort,
    "openOrBindSession" | "sendUserMessage" | "collectAssistantReply"
  >;
};

export type CodeReviewCommandResult =
  | { type: "control-reply"; text: string }
  | { type: "drafts"; drafts: OutboundDraft[] };

export class CodeReviewCommandActions {
  constructor(private readonly deps: CodeReviewCommandActionsDeps) {}

  async run(message: InboundMessage): Promise<CodeReviewCommandResult> {
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
      return { type: "control-reply", text: "已触发 Codex 代码审查。" };
    }

    return {
      type: "drafts",
      drafts: drafts.map((draft) => ({
        ...draft,
        replyToMessageId: draft.replyToMessageId ?? message.messageId
      }))
    };
  }
}

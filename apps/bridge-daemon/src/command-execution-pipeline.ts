import { BridgeSessionStatus, type BridgeSession } from "../../../packages/domain/src/session.js";
import type { InboundMessage } from "../../../packages/domain/src/message.js";
import type {
  SessionStorePort,
  TranscriptStorePort
} from "../../../packages/ports/src/store.js";
import {
  routeThreadCommand,
  type ThreadCommandRoute
} from "./command-classifier.js";

export type ImmediateThreadCommandRoute = Extract<
  ThreadCommandRoute,
  { kind: "cancel" | "retry" | "task-query" | "delivery-query" }
>;

export type UnknownThreadCommandRoute = Extract<ThreadCommandRoute, { kind: "unknown" }>;

export type LockedThreadCommandRoute = Exclude<
  ThreadCommandRoute,
  | { kind: "not-command" }
  | UnknownThreadCommandRoute
  | ImmediateThreadCommandRoute
>;

type CommandExecutionPipelineDeps = {
  sessionStore: SessionStorePort;
  transcriptStore: TranscriptStorePort;
  handleImmediateCommand: (
    message: InboundMessage,
    route: ImmediateThreadCommandRoute
  ) => Promise<void>;
  handleUnknownCommand: (
    message: InboundMessage,
    route: UnknownThreadCommandRoute,
    session: BridgeSession | null
  ) => Promise<void>;
  handleLockedCommand: (
    message: InboundMessage,
    route: LockedThreadCommandRoute
  ) => Promise<void>;
};

export class CommandExecutionPipeline {
  constructor(private readonly deps: CommandExecutionPipelineDeps) {}

  async handleIfCommand(message: InboundMessage): Promise<boolean> {
    if (message.chatType !== "c2c") {
      return false;
    }

    const route = routeThreadCommand(message.text.trim());
    if (route.kind === "not-command") {
      return false;
    }

    if (this.isImmediateRoute(route)) {
      if (await this.hasAlreadySeen(message)) {
        return true;
      }

      await this.deps.transcriptStore.recordInbound(message);
      await this.deps.handleImmediateCommand(message, route);
      return true;
    }

    if (await this.hasAlreadySeen(message)) {
      return true;
    }

    await this.deps.sessionStore.withSessionLock(message.sessionKey, async () => {
      if (await this.hasAlreadySeen(message)) {
        return;
      }

      const session = await this.ensureSessionExists(message);
      await this.deps.transcriptStore.recordInbound(message);

      if (route.kind === "unknown") {
        await this.deps.handleUnknownCommand(message, route, session);
        return;
      }

      await this.deps.handleLockedCommand(message, route);
    });

    return true;
  }

  private isImmediateRoute(route: ThreadCommandRoute): route is ImmediateThreadCommandRoute {
    return route.kind === "cancel"
      || route.kind === "retry"
      || route.kind === "task-query"
      || route.kind === "delivery-query";
  }

  private async hasAlreadySeen(message: InboundMessage): Promise<boolean> {
    return this.deps.transcriptStore.hasInbound(message.messageId);
  }

  private async ensureSessionExists(message: InboundMessage): Promise<BridgeSession | null> {
    const existing = await this.deps.sessionStore.getSession(message.sessionKey);
    if (existing) {
      return existing;
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
    return created;
  }
}

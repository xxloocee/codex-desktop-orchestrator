import { type BridgeSession, type ConversationProviderKind } from "../../../packages/domain/src/session.js";
import type { ChatgptDesktopDriver } from "../../../packages/adapters/chatgpt-desktop/src/driver.js";
import type { DesktopDriverPort } from "../../../packages/ports/src/conversation.js";
import {
  type InboundMessage,
  type OutboundDraft
} from "../../../packages/domain/src/message.js";
import type { QqEgressPort } from "../../../packages/ports/src/qq.js";
import type {
  DeliveryJobStorePort,
  SessionStorePort,
  TranscriptStorePort,
  TurnStorePort
} from "../../../packages/ports/src/store.js";
import { DeliveryQuery } from "../../../packages/orchestrator/src/delivery-query.js";
import { TurnControl } from "../../../packages/orchestrator/src/turn-control.js";
import { TurnQuery } from "../../../packages/orchestrator/src/turn-query.js";
import {
  buildAccountsText,
  buildHelpText,
  buildProjectAliasesText,
  buildUnknownCommandText
} from "./command-presenter.js";
import { ChatgptCommandActions } from "./chatgpt-command-actions.js";
import { CodeReviewCommandActions } from "./code-review-command-actions.js";
import { CodexThreadCommandActions } from "./codex-thread-command-actions.js";
import type { AppConfig } from "./config.js";
import { ControlReplyDelivery } from "./control-reply-delivery.js";
import {
  CommandExecutionPipeline,
  type ImmediateThreadCommandRoute,
  type LockedThreadCommandRoute,
  type UnknownThreadCommandRoute
} from "./command-execution-pipeline.js";
import { DesktopControlCommandActions } from "./desktop-control-command-actions.js";
import { ProviderThreadCommandExecutor } from "./provider-thread-command-executor.js";
import { SourceCommandActions } from "./source-command-actions.js";

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
  private readonly codeReviewCommandActions: CodeReviewCommandActions;
  private readonly commandExecutionPipeline: CommandExecutionPipeline;
  private readonly codexThreadCommandActions: CodexThreadCommandActions;
  private readonly controlReplyDelivery: ControlReplyDelivery;
  private readonly desktopControlCommandActions: DesktopControlCommandActions;
  private readonly deliveryQuery: DeliveryQuery;
  private readonly providerThreadCommandExecutor: ProviderThreadCommandExecutor;
  private readonly sourceCommandActions: SourceCommandActions;
  private readonly turnControl: TurnControl;
  private readonly turnQuery: TurnQuery;

  constructor(private readonly deps: ThreadCommandHandlerDeps) {
    const chatgptCommandActions = new ChatgptCommandActions({
      chatgptDriver: deps.chatgptDriver,
      sessionStore: deps.sessionStore
    });
    this.codeReviewCommandActions = new CodeReviewCommandActions({
      sessionStore: deps.sessionStore,
      desktopDriver: deps.desktopDriver
    });
    this.codexThreadCommandActions = new CodexThreadCommandActions({
      desktopDriver: deps.desktopDriver,
      sessionStore: deps.sessionStore,
      transcriptStore: deps.transcriptStore,
      projectAliases: deps.projectAliases
    });
    this.providerThreadCommandExecutor = new ProviderThreadCommandExecutor({
      chatgptCommandActions,
      codexThreadCommandActions: this.codexThreadCommandActions
    });
    this.controlReplyDelivery = new ControlReplyDelivery({
      transcriptStore: deps.transcriptStore,
      qqEgress: deps.qqEgress,
      deliveryJobStore: deps.deliveryJobStore
    });
    this.desktopControlCommandActions = new DesktopControlCommandActions({
      desktopDriver: deps.desktopDriver,
      sessionStore: deps.sessionStore
    });
    this.deliveryQuery = new DeliveryQuery({
      deliveryJobStore: deps.deliveryJobStore
    });
    this.sourceCommandActions = new SourceCommandActions({
      sessionStore: deps.sessionStore
    });
    this.turnControl = new TurnControl({
      turnStore: deps.turnStore,
      desktopDriver: deps.desktopDriver
    });
    this.turnQuery = new TurnQuery({
      turnStore: deps.turnStore
    });
    this.commandExecutionPipeline = new CommandExecutionPipeline({
      sessionStore: deps.sessionStore,
      transcriptStore: deps.transcriptStore,
      handleImmediateCommand: (message, route) => this.handleImmediateCommand(message, route),
      handleUnknownCommand: (message, route, session) => this.handleUnknownCommand(message, route, session),
      handleLockedCommand: (message, route) => this.handleLockedCommand(message, route)
    });
  }

  async handleIfCommand(message: InboundMessage): Promise<boolean> {
    return this.commandExecutionPipeline.handleIfCommand(message);
  }

  private async handleLockedCommand(
    message: InboundMessage,
    route: LockedThreadCommandRoute
  ): Promise<void> {
    switch (route.kind) {
      case "threads": {
        const session = await this.deps.sessionStore.getSession(message.sessionKey);
        await this.deliverControlReply(
          message,
          await this.providerThreadCommandExecutor.buildThreadsText(session)
        );
        return;
      }
      case "thread-current": {
        const session = await this.deps.sessionStore.getSession(message.sessionKey);
        await this.deliverControlReply(
          message,
          await this.providerThreadCommandExecutor.buildCurrentThreadText(session)
        );
        return;
      }
      case "source-switch": {
        const result = await this.sourceCommandActions.switchSource(message.sessionKey, route.sourceTarget);
        this.providerThreadCommandExecutor.setChatgptThreadListRefresh(
          message.sessionKey,
          result.refreshChatgptThreads
        );
        await this.deliverControlReply(message, result.text);
        return;
      }
      case "source-current":
        await this.deliverControlReply(
          message,
          await this.sourceCommandActions.buildCurrentSourceText(message.sessionKey)
        );
        return;
      case "accounts": {
        const session = await this.deps.sessionStore.getSession(message.sessionKey);
        await this.deliverControlReply(
          message,
          buildAccountsText({
            accountKey: message.accountKey,
            sessionKey: message.sessionKey,
            provider: this.currentProvider(session),
            accountKeys: this.deps.accountKeys ?? [message.accountKey]
          })
        );
        return;
      }
      case "projects":
        await this.deliverControlReply(message, await this.codexThreadCommandActions.buildProjectsText());
        return;
      case "aliases":
        await this.deliverControlReply(message, buildProjectAliasesText(this.deps.projectAliases));
        return;
      case "chatgpt-threads": {
        const session = await this.deps.sessionStore.getSession(message.sessionKey);
        await this.deliverControlReply(
          message,
          await this.providerThreadCommandExecutor.buildChatgptThreadsText(session)
        );
        return;
      }
      case "chatgpt-use":
        await this.deliverControlReply(
          message,
          await this.providerThreadCommandExecutor.useChatgptThread(message.sessionKey, route.index)
        );
        return;
      case "chatgpt-new": {
        const session = await this.deps.sessionStore.getSession(message.sessionKey);
        await this.deliverControlReply(
          message,
          await this.providerThreadCommandExecutor.createChatgptThread(message.sessionKey, session)
        );
        return;
      }
      case "help": {
        const session = await this.deps.sessionStore.getSession(message.sessionKey);
        await this.deliverControlReply(message, buildHelpText(this.currentProvider(session)));
        return;
      }
      case "model-current":
        await this.deliverControlReply(message, await this.desktopControlCommandActions.buildModelText());
        return;
      case "model-switch":
        await this.deliverControlReply(
          message,
          await this.desktopControlCommandActions.switchModel(route.targetModel)
        );
        return;
      case "quota":
        await this.deliverControlReply(message, await this.desktopControlCommandActions.buildQuotaText());
        return;
      case "status":
        await this.deliverControlReply(
          message,
          await this.desktopControlCommandActions.buildStatusText(message.sessionKey)
        );
        return;
      case "code-review":
        await this.handleCodeReviewCommand(message);
        return;
      case "thread-use": {
        const session = await this.deps.sessionStore.getSession(message.sessionKey);
        await this.deliverControlReply(
          message,
          await this.providerThreadCommandExecutor.useThread(
            message.sessionKey,
            session,
            route.index
          )
        );
        return;
      }
      case "thread-new": {
        const session = await this.deps.sessionStore.getSession(message.sessionKey);
        await this.deliverControlReply(
          message,
          await this.providerThreadCommandExecutor.createThread(
            message.sessionKey,
            session,
            route.title
          )
        );
        return;
      }
      case "project-new":
        await this.deliverControlReply(
          message,
          await this.codexThreadCommandActions.createProjectThread(
            message.sessionKey,
            route.alias,
            route.task
          )
        );
        return;
      case "thread-fork": {
        const session = await this.deps.sessionStore.getSession(message.sessionKey);
        await this.deliverControlReply(
          message,
          await this.providerThreadCommandExecutor.forkThread(
            message.sessionKey,
            session,
            route.title
          )
        );
        return;
      }
    }
  }

  private currentProvider(session: BridgeSession | null): ConversationProviderKind {
    return session?.conversationProvider ?? "codex-desktop";
  }

  private async handleImmediateCommand(
    message: InboundMessage,
    route: ImmediateThreadCommandRoute
  ): Promise<void> {
    switch (route.kind) {
      case "cancel":
        await this.handleCancelCommand(message, route.taskId);
        return;
      case "task-query":
        await this.handleTaskQueryCommand(message, route.query);
        return;
      case "delivery-query":
        await this.handleDeliveryQueryCommand(message);
        return;
    }
  }

  private async handleUnknownCommand(
    message: InboundMessage,
    route: UnknownThreadCommandRoute,
    session: BridgeSession | null
  ): Promise<void> {
    await this.deliverControlReply(
      message,
      buildUnknownCommandText(route.text, this.currentProvider(session))
    );
  }

  private async deliverControlReply(message: InboundMessage, text: string): Promise<void> {
    await this.controlReplyDelivery.deliverControlReply(message, text);
  }

  private async deliverDraft(draft: OutboundDraft): Promise<void> {
    await this.controlReplyDelivery.deliverDraft(draft);
  }

  private async handleCodeReviewCommand(message: InboundMessage): Promise<void> {
    const result = await this.codeReviewCommandActions.run(message);
    if (result.type === "control-reply") {
      await this.deliverControlReply(message, result.text);
      return;
    }

    for (const draft of result.drafts) {
      await this.deliverDraft(draft);
    }
  }

  private async handleTaskQueryCommand(
    message: InboundMessage,
    query: "current" | "recent"
  ): Promise<void> {
    await this.deliverControlReply(
      message,
      query === "current"
        ? await this.turnQuery.buildCurrentTaskText(message.sessionKey)
        : await this.turnQuery.buildRecentTasksText(message.sessionKey)
    );
  }

  private async handleDeliveryQueryCommand(message: InboundMessage): Promise<void> {
    await this.deliverControlReply(
      message,
      await this.deliveryQuery.buildDeliveryJobsText(message.sessionKey)
    );
  }

  private async handleCancelCommand(message: InboundMessage, taskId: string | null): Promise<void> {
    const result = await this.turnControl.cancelCurrentTurn(
      message.sessionKey,
      taskId
    );

    if (result.status === "tracking-not-configured") {
      await this.deliverControlReply(message, "Task tracking is not configured.");
      return;
    }

    if (result.status === "no-active-turn") {
      await this.deliverControlReply(message, "No active task to cancel for this conversation.");
      return;
    }

    if (result.status === "task-mismatch") {
      await this.deliverControlReply(
        message,
        [
          `No active task matches: ${result.requestedTaskId}`,
          `Current task: ${result.currentTurnId}`,
          "Use /tasks to inspect recent task IDs."
        ].join("\n")
      );
      return;
    }

    if (result.status === "interrupt-failed") {
      await this.deliverControlReply(
        message,
        [
          `Cancel failed for task: ${result.turnId}`,
          `Interrupt error: ${result.error}`
        ].join("\n")
      );
      return;
    }

    await this.deliverControlReply(
      message,
      [
        `Cancelled task: ${result.turnId}`,
        result.interrupted
          ? "Codex turn interrupt sent."
          : "No active Codex turn was found in the driver; future output from this task will be suppressed."
      ].join("\n")
    );
  }

}

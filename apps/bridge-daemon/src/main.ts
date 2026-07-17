import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import {
  DesktopDriverError,
  type CodexPermissionMode
} from "../../../packages/domain/src/driver.js";
import type {
  DeliveryRecord,
  InboundMessage,
  OutboundDraft,
  TurnEvent
} from "../../../packages/domain/src/message.js";
import {
  markSynchronousDeliveryFailure,
  markSynchronousDeliveryResult
} from "../../../packages/orchestrator/src/delivery-worker.js";
import { TurnRecoveryController } from "../../../packages/orchestrator/src/turn-recovery-controller.js";
import type { DeliveryJobStorePort, TranscriptStorePort } from "../../../packages/ports/src/store.js";
import {
  authorizeInboundMessage,
  canChangePermissionMode,
  type AccessDecision
} from "./access-control.js";
import { bootstrap, INTERNAL_TURN_EVENT_PATH } from "./bootstrap.js";
import { updateRuntimeConfigFile } from "./config-management.js";
import { resolveConfigPath } from "./config.js";
import { createBridgeHttpServer } from "./http-server.js";
import {
  clearRuntimeState,
  appendRuntimeLog,
  ensureManagementToken,
  readRuntimeLogTail,
  readRuntimeStatus,
  runtimePaths,
  writeRuntimeState
} from "./runtime-state.js";
import { ThreadCommandHandler } from "./thread-command-handler.js";
import { startWeixinGatewayService, type WeixinGatewayServiceHandle } from "../../weixin-gateway/src/cli.js";

type IngressMessageHandlerDeps = {
  accessControl?: Parameters<typeof authorizeInboundMessage>[1];
  onRejected?: (message: InboundMessage, decision: AccessDecision) => void;
  threadCommandHandler: Pick<ThreadCommandHandler, "handleIfCommand">;
  orchestrator: {
    handleInbound: (message: InboundMessage) => Promise<void>;
  };
  errorEgress?: {
    deliver(draft: OutboundDraft): Promise<DeliveryRecord>;
  };
  transcriptStore?: Pick<TranscriptStorePort, "recordOutbound">;
  deliveryJobStore?: DeliveryJobStorePort;
};

export function createIngressMessageHandler(deps: IngressMessageHandlerDeps) {
  return async (message: InboundMessage) => {
    const decision = authorizeInboundMessage(message, deps.accessControl);
    if (!decision.allowed) {
      deps.onRejected?.(message, decision);
      return;
    }

    try {
      const handled = await deps.threadCommandHandler.handleIfCommand(message);
      if (handled) {
        return;
      }
      await deps.orchestrator.handleInbound(message);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("[codex-desktop-orchestrator] message handling failed", {
        messageId: message.messageId,
        sessionKey: message.sessionKey,
        error: errorMessage
      });
      if (error instanceof Error && error.stack) {
        console.error("  stack:", error.stack);
      }
      if (deps.errorEgress) {
        const errorDraft: OutboundDraft = {
          draftId: randomUUID(),
          sessionKey: message.sessionKey,
          text: buildBridgeErrorReplyText(error, errorMessage),
          createdAt: new Date().toISOString(),
          replyToMessageId: message.replyToMessageId ?? message.messageId
        };
        try {
          await deps.transcriptStore?.recordOutbound(errorDraft);
          const delivery = await deps.errorEgress.deliver(errorDraft);
          await markSynchronousDeliveryResult(deps.deliveryJobStore, errorDraft, delivery);
        } catch (replyError) {
          await markSynchronousDeliveryFailure(deps.deliveryJobStore, errorDraft, replyError);
          console.warn("[codex-desktop-orchestrator] failed to send error reply", {
            replyError: replyError instanceof Error ? replyError.message : String(replyError)
          });
        }
      }
    }
  };
}

function buildBridgeErrorReplyText(error: unknown, errorMessage: string): string {
  if (error instanceof DesktopDriverError && error.reason === "context_length_exceeded") {
    return [
      "[bridge error] Current Codex thread exceeds the model context window.",
      "Start a fresh thread with /tn <title>, or use /new <project-alias> <task>, then send the task again."
    ].join("\n");
  }
  if (error instanceof DesktopDriverError && error.reason === "service_error") {
    return [
      "[bridge error] Codex rejected this message input.",
      "The task ended without a model reply. Try sending the request again in plain text, or start a fresh thread with /tn <title>."
    ].join("\n");
  }
  return `[bridge error] ${errorMessage}`;
}

export type BridgeRuntimeHandle = {
  shutdown(): Promise<void>;
  channels: string[];
};

export async function runBridgeDaemon(): Promise<BridgeRuntimeHandle> {
  const app = bootstrap();
  const paths = runtimePaths();
  const configPath = resolveConfigPath(process.env);
  const managementToken = ensureManagementToken(paths);
  const recovery = new TurnRecoveryController({
    runtimeRecoveryStore: app.runtimeRecoveryStore
  }).recoverAbandonedState();
  appendRuntimeLog(paths, recovery.logLine);
  const qqGatewayDisabled = process.env.QQ_CODEX_DISABLE_QQ_GATEWAY === "1"
    || process.env.QQ_CODEX_DISABLE_QQ_GATEWAY === "true";
  const managedServices: Array<Pick<WeixinGatewayServiceHandle, "shutdown">> = [];
  let runtimeHandle: BridgeRuntimeHandle | null = null;
  const configuredAccountKeys = Object.keys(app.orchestrators.byAccountKey);
  const permissionModeControl = app.adapters.codexDesktop.getPermissionMode
    && app.adapters.codexDesktop.setPermissionMode
    ? {
        getMode: () => app.adapters.codexDesktop.getPermissionMode!(),
        setMode: async (mode: CodexPermissionMode) => {
          const updated = updateRuntimeConfigFile({
            configPath,
            env: process.env,
            patch: {
              codexDesktop: {
                permissionMode: mode
              }
            }
          });
          app.adapters.codexDesktop.setPermissionMode!(
            updated.effectiveConfig.codexDesktop.permissionMode
          );
          app.config.codexDesktop.permissionMode = updated.effectiveConfig.codexDesktop.permissionMode;
        }
      }
    : undefined;
  const qqIngressHandlers = Object.entries(app.adapters.qqByAccountKey).map(([accountKey, adapter]) => {
    const orchestrator = app.orchestrators.byAccountKey[accountKey];
    if (!orchestrator) {
      throw new Error(`missing orchestrator for ${accountKey}`);
    }
    let ingressHandler!: ReturnType<typeof createIngressMessageHandler>;
    const threadCommandHandler = new ThreadCommandHandler({
      sessionStore: app.sessionStore,
      transcriptStore: app.transcriptStore,
      turnStore: app.turnStore,
      deliveryJobStore: app.deliveryJobStore,
      desktopDriver: app.adapters.codexDesktop,
      qqEgress: adapter.egress,
      chatgptDriver: app.chatgptDriver,
      accountKeys: configuredAccountKeys,
      projectAliases: app.config.projectAliases,
      permissionModeControl,
      canSwitchPermissionMode: (message) =>
        canChangePermissionMode(message, app.config.accessControl),
      retryInbound: (retryMessage) => {
        void ingressHandler(retryMessage);
      }
    });
    ingressHandler = createIngressMessageHandler({
      threadCommandHandler,
      orchestrator,
      errorEgress: adapter.egress,
      transcriptStore: app.transcriptStore,
      deliveryJobStore: app.deliveryJobStore,
      accessControl: app.config.accessControl,
      onRejected: logRejectedInbound
    });
    return {
      accountKey,
      adapter,
      ingressHandler
    };
  });
  const weixinRoutes = Object.entries(app.adapters.weixinByAccountKey).map(([accountKey, adapter]) => {
    const orchestrator = app.orchestrators.byAccountKey[accountKey];
    if (!orchestrator) {
      throw new Error(`missing orchestrator for ${accountKey}`);
    }
    let ingressHandler!: ReturnType<typeof createIngressMessageHandler>;
    const threadCommandHandler = new ThreadCommandHandler({
      sessionStore: app.sessionStore,
      transcriptStore: app.transcriptStore,
      turnStore: app.turnStore,
      deliveryJobStore: app.deliveryJobStore,
      desktopDriver: app.adapters.codexDesktop,
      qqEgress: adapter.egress,
      chatgptDriver: app.chatgptDriver,
      accountKeys: configuredAccountKeys,
      projectAliases: app.config.projectAliases,
      permissionModeControl,
      canSwitchPermissionMode: (message) =>
        canChangePermissionMode(message, app.config.accessControl),
      retryInbound: (retryMessage) => {
        void ingressHandler(retryMessage);
      }
    });
    ingressHandler = createIngressMessageHandler({
      threadCommandHandler,
      orchestrator,
      errorEgress: adapter.egress,
      transcriptStore: app.transcriptStore,
      deliveryJobStore: app.deliveryJobStore,
      accessControl: app.config.accessControl,
      onRejected: logRejectedInbound
    });
    return {
      accountKey,
      adapter,
      ingressHandler
    };
  });
  const bridgeHttpServer = createBridgeHttpServer([
    {
      routePath: "/health",
      method: "GET",
      allowOnlyLocal: true,
      requiredToken: managementToken,
      dispatchPayload: async () => ({
        status: "ok",
        runtime: readRuntimeStatus(paths),
        config: {
          databasePath: app.config.databasePath,
          listenHost: app.config.runtime.listenHost,
          listenPort: app.config.runtime.listenPort,
          conversationProvider: app.config.conversationProvider
        }
      })
    },
    {
      routePath: "/status",
      method: "GET",
      allowOnlyLocal: true,
      requiredToken: managementToken,
      dispatchPayload: async () => readRuntimeStatus(paths)
    },
    {
      routePath: "/logs",
      method: "GET",
      allowOnlyLocal: true,
      requiredToken: managementToken,
      dispatchPayload: async () => ({
        logPath: paths.logPath,
        lines: readRuntimeLogTail(paths, 200)
      })
    },
    {
      routePath: "/config",
      method: "GET",
      allowOnlyLocal: true,
      requiredToken: managementToken,
      dispatchPayload: async () => ({
        configPath,
        restartRequired: false,
        config: redactConfig(app.config)
      })
    },
    {
      routePath: "/config",
      method: "PUT",
      allowOnlyLocal: true,
      requiredToken: managementToken,
      respondWithJson: true,
      dispatchPayload: async (payload) => {
        const updated = updateRuntimeConfigFile({
          configPath,
          env: process.env,
          patch: payload
        });
        appendRuntimeLog(paths, "config updated restartRequired=true");
        return {
          status: "updated",
          configPath: updated.configPath,
          restartRequired: true,
          config: redactConfig(updated.effectiveConfig)
        };
      }
    },
    {
      routePath: "/control/stop",
      method: "POST",
      allowOnlyLocal: true,
      requiredToken: managementToken,
      respondWithJson: true,
      dispatchPayload: async () => {
        const handle = runtimeHandle;
        if (!handle) {
          const error = new Error("Bridge runtime is still starting");
          (error as Error & { statusCode?: number }).statusCode = 503;
          throw error;
        }
        appendRuntimeLog(paths, `stop requested pid=${process.pid}`);
        setTimeout(() => {
          void handle.shutdown();
        }, 0);
        return {
          status: "stopping",
          pid: process.pid
        };
      }
    },
    {
      routePath: INTERNAL_TURN_EVENT_PATH,
      allowOnlyLocal: true,
      respondWithJson: true,
      dispatchPayload: async (payload) => {
        const event = payload as TurnEvent;
        await resolveTurnEventOrchestrator(event, app.orchestrators).handleTurnEvent(event);
      },
      onDispatchError: (error, payload) => {
        console.warn("[codex-desktop-orchestrator] internal turn event dispatch failed", {
          error: error.message,
          payload
        });
      }
    },
    ...weixinRoutes.map((route) => ({
      routePath: route.adapter.webhook.routePath,
      dispatchPayload: async (payload: unknown) => {
        const message = route.adapter.webhook.toInboundMessage(payload);
        await route.ingressHandler(message);
      },
      onDispatchError: (error: Error, payload: unknown) => {
        console.warn("[codex-desktop-orchestrator] weixin webhook dispatch failed", {
          accountKey: route.accountKey,
          error: error.message,
          payload
        });
      }
    }))
  ]);

  function logRejectedInbound(message: InboundMessage, decision: AccessDecision): void {
    const summary = `rejected account=${message.accountKey} chatType=${message.chatType} sender=${message.senderId} peer=${message.peerKey} reason=${decision.reason}`;
    appendRuntimeLog(paths, summary);
    console.warn("[codex-desktop-orchestrator] inbound rejected by access control", {
      accountKey: message.accountKey,
      chatType: message.chatType,
      senderId: message.senderId,
      peerKey: message.peerKey,
      reason: decision.reason
    });
  }

  await new Promise<void>((resolve, reject) => {
    bridgeHttpServer.once("error", reject);
    bridgeHttpServer.listen(app.config.runtime.listenPort, app.config.runtime.listenHost, () => {
      bridgeHttpServer.off("error", reject);
      resolve();
    });
  });

  if (qqGatewayDisabled) {
    appendRuntimeLog(paths, "qq gateway disabled by QQ_CODEX_DISABLE_QQ_GATEWAY");
    console.warn("[codex-desktop-orchestrator] qq gateway disabled by QQ_CODEX_DISABLE_QQ_GATEWAY");
  } else {
    for (const entry of qqIngressHandlers) {
      await entry.adapter.ingress.onMessage(entry.ingressHandler);
      await entry.adapter.ingress.start();
    }
  }

  const channelSet = new Set(qqIngressHandlers.map((entry) => entry.accountKey));
  if (app.config.weixin.enabled) {
    const weixinService = await startWeixinGatewayService();
    managedServices.push(weixinService);
    channelSet.add(`weixin:${weixinService.status.accountId}`);
    console.log("[codex-desktop-orchestrator] channel ready", {
      channel: "weixin",
      listenHost: weixinService.status.listenHost,
      listenPort: weixinService.status.listenPort,
      loggedIn: weixinService.status.loggedIn,
      accountId: weixinService.status.accountId
    });
  }
  for (const route of weixinRoutes) {
    channelSet.add(route.accountKey);
  }
  app.deliveryWorker.start();
  const channels = [...channelSet];
  writeRuntimeState(paths, {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    listenHost: app.config.runtime.listenHost,
    listenPort: app.config.runtime.listenPort,
    channels,
    version: process.env.npm_package_version ?? "unknown"
  });

  console.log("[codex-desktop-orchestrator] ready", {
    transport: "qq-gateway-websocket",
    accountKeys: channels,
    conversationProvider: app.config.conversationProvider,
    listenHost: app.config.runtime.listenHost,
    listenPort: app.config.runtime.listenPort,
    internalTurnEventPath: INTERNAL_TURN_EVENT_PATH,
    ...(weixinRoutes.length > 0
      ? {
          weixinWebhookPaths: weixinRoutes.map((route) => route.adapter.webhook.routePath)
        }
      : {}),
    channels
  });

  let shutdownPromise: Promise<void> | null = null;
  runtimeHandle = {
    channels,
    shutdown: () => {
      shutdownPromise ??= (async () => {
        await Promise.allSettled([
          ...qqIngressHandlers.map((entry) =>
            new Promise<void>((resolve) => {
              const maybeClose = entry.adapter.ingress as { stop?: () => Promise<void> | void };
              Promise.resolve(maybeClose.stop?.()).finally(() => resolve());
            })
          ),
          ...managedServices.map((service) => service.shutdown())
        ]);
        await app.deliveryWorker.stop();
        await app.adapters.codexDesktop.shutdown?.();
        await new Promise<void>((resolve) => bridgeHttpServer.close(() => resolve()));
        app.db.close();
        clearRuntimeState(paths);
      })();
      return shutdownPromise;
    }
  };
  return runtimeHandle;
}

export function installBridgeRuntimeSignalHandlers(runtime: Pick<BridgeRuntimeHandle, "shutdown">): void {
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    void runtime.shutdown().finally(() => {
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

export function resolveTurnEventOrchestrator(
  event: Pick<TurnEvent, "sessionKey">,
  orchestrators: {
    qq: { handleTurnEvent: (event: TurnEvent) => Promise<void> | void };
    weixin?: { handleTurnEvent: (event: TurnEvent) => Promise<void> | void };
    byAccountKey?: Record<string, { handleTurnEvent: (event: TurnEvent) => Promise<void> | void }>;
  }
) {
  const accountKey = extractAccountKey(event.sessionKey);
  if (accountKey && orchestrators.byAccountKey?.[accountKey]) {
    return orchestrators.byAccountKey[accountKey];
  }

  if (event.sessionKey.startsWith("weixin:") && orchestrators.weixin) {
    return orchestrators.weixin;
  }

  return orchestrators.qq;
}

function extractAccountKey(sessionKey: string): string | null {
  const separatorIndex = sessionKey.indexOf("::");
  if (separatorIndex < 0) {
    return null;
  }
  const accountKey = sessionKey.slice(0, separatorIndex).trim();
  return accountKey || null;
}

function redactConfig<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => redactConfig(item)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        /secret|token|apiKey|accessKey|clientSecret/i.test(key) && typeof entry === "string"
          ? "***"
          : redactConfig(entry)
      ])
    ) as T;
  }
  return value;
}

function handleFatal(error: unknown) {
  const cause = error instanceof Error ? error.cause : undefined;
  console.error("[codex-desktop-orchestrator] fatal:", error instanceof Error ? error.message : String(error));
  if (cause !== undefined) {
    console.error("  caused by:", cause);
  }
  if (error instanceof Error && error.stack) {
    console.error("  stack:", error.stack);
  }
  process.exitCode = 1;
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  runBridgeDaemon().then(installBridgeRuntimeSignalHandlers).catch(handleFatal);
}

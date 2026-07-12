import path from "node:path";
import { QqApiClient } from "../../../packages/adapters/qq/src/qq-api-client.js";
import { createQqChannelAdapter } from "../../../packages/adapters/qq/src/qq-channel-adapter.js";
import { FileQqGatewaySessionStore } from "../../../packages/adapters/qq/src/qq-gateway-session-store.js";
import {
  createWeixinChannelAdapter,
  type WeixinChannelAdapter
} from "../../../packages/adapters/weixin/src/weixin-channel-adapter.js";
import { CdpSession } from "../../../packages/adapters/codex-desktop/src/cdp-session.js";
import { CodexAppServerDriver } from "../../../packages/adapters/codex-desktop/src/codex-app-server-driver.js";
import { CodexDesktopAppUiNotificationForwarder } from "../../../packages/adapters/codex-desktop/src/codex-app-ui-notification-forwarder.js";
import { CodexLocalRolloutReader } from "../../../packages/adapters/codex-desktop/src/codex-local-rollout-reader.js";
import { CodexLocalSubmissionReader } from "../../../packages/adapters/codex-desktop/src/codex-local-submission-reader.js";
import { CodexDesktopDriver } from "../../../packages/adapters/codex-desktop/src/codex-desktop-driver.js";
import { BridgeSessionStatus } from "../../../packages/domain/src/session.js";
import type { TurnEvent } from "../../../packages/domain/src/message.js";
import { BridgeOrchestrator } from "../../../packages/orchestrator/src/bridge-orchestrator.js";
import { buildCodexInboundText } from "../../../packages/orchestrator/src/media-context.js";
import { formatQqOutboundDraft } from "../../../packages/orchestrator/src/qq-outbound-format.js";
import { enrichQqOutboundDraft } from "../../../packages/orchestrator/src/qq-outbound-draft.js";
import { shouldInjectQqbotSkillContext } from "../../../packages/orchestrator/src/qqbot-skill-context.js";
import { formatWeixinOutboundDraft } from "../../../packages/orchestrator/src/weixin-outbound-format.js";
import type {
  ConversationProviderPort,
  ConversationRunOptions,
  DesktopDriverPort
} from "../../../packages/ports/src/conversation.js";
import type { ChatEgressPort } from "../../../packages/ports/src/chat.js";
import { DesktopDriverError, type DriverBinding } from "../../../packages/domain/src/driver.js";
import { SqliteTranscriptStore } from "../../../packages/store/src/message-repo.js";
import { SqliteSessionStore } from "../../../packages/store/src/session-repo.js";
import { SqliteTurnStore } from "../../../packages/store/src/turn-repo.js";
import { SqliteThreadLockStore } from "../../../packages/store/src/thread-lock-repo.js";
import { SqliteDeliveryJobStore } from "../../../packages/store/src/delivery-job-repo.js";
import { SqliteRuntimeRecoveryStore } from "../../../packages/store/src/runtime-recovery-repo.js";
import { createSqliteDatabase } from "../../../packages/store/src/sqlite.js";
import { DeliveryWorker } from "../../../packages/orchestrator/src/delivery-worker.js";
import { loadConfig } from "./config.js";
import { discoverCodexInstallations } from "./codex-discovery.js";
import { ChatgptDesktopProvider } from "../../../packages/adapters/chatgpt-desktop/src/bridge-provider.js";
import type { ChatgptDesktopDriver } from "../../../packages/adapters/chatgpt-desktop/src/driver.js";

const INTERNAL_TURN_EVENT_PATH = "/internal/codex-turn-events";

type BootstrapAdapters = {
  qq: ReturnType<typeof createQqChannelAdapter>;
  qqByAccountKey: Record<string, ReturnType<typeof createQqChannelAdapter>>;
  codexDesktop: DesktopDriverPort;
  weixin?: WeixinChannelAdapter;
  weixinByAccountKey: Record<string, WeixinChannelAdapter>;
};

type BootstrapOrchestrators = {
  qq: BridgeOrchestrator;
  weixin?: BridgeOrchestrator;
  byAccountKey: Record<string, BridgeOrchestrator>;
};

function formatDraftForQq(draft: Parameters<typeof formatQqOutboundDraft>[0]) {
  return formatQqOutboundDraft(enrichQqOutboundDraft(draft));
}

function formatDraftForWeixin(draft: Parameters<typeof formatWeixinOutboundDraft>[0]) {
  return formatWeixinOutboundDraft(enrichQqOutboundDraft(draft));
}

export function bootstrap() {
  const config = loadConfig(process.env);
  const db = createSqliteDatabase(config.databasePath);
  const sessionStore = new SqliteSessionStore(db);
  const transcriptStore = new SqliteTranscriptStore(db);
  const turnStore = new SqliteTurnStore(db);
  const threadLockStore = new SqliteThreadLockStore(db);
  const deliveryJobStore = new SqliteDeliveryJobStore(db);
  const runtimeRecoveryStore = new SqliteRuntimeRecoveryStore(db);
  const runtimeDir = path.dirname(config.databasePath);
  const useDomTransport = process.env.CODEX_DESKTOP_TRANSPORT === "dom";
  const forwardAppServerUiEvents = process.env.CODEX_APP_SERVER_FORWARD_UI_EVENTS === "1";
  const codexInstallations = discoverCodexInstallations({ env: process.env });
  const cdpSession = new CdpSession({
    appName: config.codexDesktop.appName,
    remoteDebuggingPort: config.codexDesktop.remoteDebuggingPort
  });
  const legacyDomDriver = new CodexDesktopDriver(
    cdpSession,
    {
      localRolloutReader: new CodexLocalRolloutReader(),
      localSubmissionReader: new CodexLocalSubmissionReader()
    }
  );
  const codexDriver =
    useDomTransport
      ? legacyDomDriver
      : new CodexAppServerDriver({
          defaultCwd: config.codexDesktop.cwd,
          codexBinaryPath: codexInstallations.binaryPath,
          controlFallback: legacyDomDriver,
          notificationForwarder: forwardAppServerUiEvents
            ? new CodexDesktopAppUiNotificationForwarder(cdpSession)
            : null
        });
  const qqAdapters = config.qqBots.map((bot) => {
    const accountKey = `qqbot:${bot.accountId}`;
    const qqApiClient = new QqApiClient(bot.appId, bot.clientSecret, {
      markdownSupport: bot.markdownSupport
    });
    const qqGatewaySessionStore = new FileQqGatewaySessionStore(
      path.join(runtimeDir, `qq-gateway-session-${safePathSegment(bot.accountId)}.json`),
      accountKey,
      bot.appId
    );
    return {
      accountKey,
      adapter: createQqChannelAdapter({
        accountKey,
        appId: bot.appId,
        apiClient: qqApiClient,
        sessionStore: qqGatewaySessionStore,
        mediaDownloadDir: path.join(runtimeDir, "media", "qq", safePathSegment(bot.accountId)),
        stt: bot.stt
      }),
      sessionStore: qqGatewaySessionStore
    };
  });
  const defaultQqAdapter = qqAdapters[0];
  if (!defaultQqAdapter) {
    throw new Error("at least one QQ bot must be configured");
  }

  const adapters = {
    qq: defaultQqAdapter.adapter,
    qqByAccountKey: Object.fromEntries(qqAdapters.map((entry) => [entry.accountKey, entry.adapter])),
    codexDesktop: codexDriver
  };
  let desktopTurnTail = Promise.resolve();
  let desktopTurnPendingCount = 0;

  const runWithDesktopTurnLock = async <T>(
    work: () => Promise<T>,
    options?: { onQueued?: () => Promise<void> }
  ): Promise<T> => {
    const isQueued = desktopTurnPendingCount > 0;
    const previous = desktopTurnTail;
    let release!: () => void;
    desktopTurnTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    desktopTurnPendingCount += 1;

    if (isQueued) {
      try {
        await options?.onQueued?.();
      } catch (error) {
        console.warn("[codex-desktop-orchestrator] desktop queue notice failed", {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    await previous;
    try {
      return await work();
    } finally {
      release();
      desktopTurnPendingCount -= 1;
    }
  };

  const runCodexTurn = async <T>(
    work: () => Promise<T>,
    options?: { onQueued?: () => Promise<void> }
  ): Promise<T> =>
    useDomTransport ? runWithDesktopTurnLock(work, options) : work();

  const codexConversationProvider = {
    runTurn: async (
      message: Parameters<BridgeOrchestrator["handleInbound"]>[0],
      options?: ConversationRunOptions
    ) =>
    {
      const notifyQueued = options?.onQueued;

      return runCodexTurn(async () => {
        await adapters.codexDesktop.ensureAppReady();
        const session = await sessionStore.getSession(message.sessionKey);
        const currentBinding = session
          && session.status === BridgeSessionStatus.Active
          ? {
              sessionKey: session.sessionKey,
              codexThreadRef: session.codexThreadRef
            }
          : null;
        const binding = await adapters.codexDesktop.openOrBindSession(
          message.sessionKey,
          currentBinding,
          ...(config.codexDesktop.cwd ? [{ cwd: config.codexDesktop.cwd }] : [])
        );
        const skillContextKey = shouldInjectQqbotSkillContext(message)
          ? `${binding.codexThreadRef ?? "unbound"}:qq-media-marker-v1`
          : null;
        const shouldIncludeSkillContext =
          skillContextKey !== null && session?.skillContextKey !== skillContextKey;
        const threadRef = binding.codexThreadRef ?? message.sessionKey;
        return threadLockStore.withThreadLock(
          threadRef,
          async () => {
            await options?.onStarted?.();
            const inboundText = buildCodexInboundText(message, {
              includeSkillContext: shouldIncludeSkillContext
            });
            let persistedCodexThreadRef = session?.codexThreadRef ?? null;
            let persistedSkillContextKey = session?.skillContextKey ?? null;
            const persistStableBinding = async (targetBinding: DriverBinding) => {
              if (persistedCodexThreadRef !== targetBinding.codexThreadRef) {
                await sessionStore.updateBinding(message.sessionKey, targetBinding.codexThreadRef);
                persistedCodexThreadRef = targetBinding.codexThreadRef;
              }
              if (shouldIncludeSkillContext) {
                const nextSkillContextKey = `${targetBinding.codexThreadRef ?? "unbound"}:qq-media-marker-v1`;
                if (persistedSkillContextKey !== nextSkillContextKey) {
                  await sessionStore.updateSkillContextKey(
                    message.sessionKey,
                    nextSkillContextKey
                  );
                  persistedSkillContextKey = nextSkillContextKey;
                }
              }
            };
            const runBoundTurn = async (targetBinding: DriverBinding) => {
              const activeTurn = await turnStore.getCurrentTurn(message.sessionKey);
              if (!activeTurn || activeTurn.qqMessageId !== message.messageId) {
                throw new DesktopDriverError(
                  "Bridge turn was cancelled before submit",
                  "turn_cancelled"
                );
              }
              await adapters.codexDesktop.sendUserMessage(targetBinding, {
                ...message,
                text: inboundText
              });
              await persistStableBinding(targetBinding);
              return adapters.codexDesktop.collectAssistantReply(targetBinding, {
                onDraft: options?.onDraft
                  ? async (draft) => {
                      await options.onDraft!({
                        ...draft,
                        replyToMessageId: message.messageId
                      });
                    }
                  : undefined,
                onTurnEvent: async (event) => {
                  await postTurnEvent(config.runtime.listenPort, {
                    ...event,
                    payload: {
                      ...event.payload,
                      replyToMessageId: message.messageId
                    }
                  });
                }
              });
            };

            let stableBinding = await resolveStableBinding(adapters.codexDesktop, binding);
            await options?.onThreadBound?.(stableBinding.codexThreadRef);

            let drafts;
            try {
              drafts = await runBoundTurn(stableBinding);
            } catch (error) {
              if (!isContextLengthExceeded(error) || !hasCompactThread(adapters.codexDesktop)) {
                throw error;
              }
              await adapters.codexDesktop.compactThread(stableBinding);
              stableBinding = await resolveStableBinding(adapters.codexDesktop, stableBinding);
              drafts = await runBoundTurn(stableBinding);
            }
            return drafts.map((draft) => ({
              ...draft,
              replyToMessageId: message.messageId
            }));
          },
          {
            onQueued: notifyQueued
          }
        );
      }, {
        onQueued: notifyQueued
      });
    }
  };

  const chatgptProvider = new ChatgptDesktopProvider({ outDir: "runtime/media/chatgpt" });
  const activeConversationRuns = new Map<
    string,
    { provider: "codex-desktop" | "chatgpt-desktop" }
  >();

  const conversationProvider: ConversationProviderPort = {
    runTurn: async (message, options) => {
      const session = await sessionStore.getSession(message.sessionKey);
      const effectiveProvider = session?.conversationProvider ?? config.conversationProvider;
      const activeRun = { provider: effectiveProvider };
      activeConversationRuns.set(message.sessionKey, activeRun);
      try {
        if (effectiveProvider === "chatgpt-desktop") {
          return await chatgptProvider.runTurn(message, options);
        }
        return await codexConversationProvider.runTurn(message, options);
      } finally {
        if (activeConversationRuns.get(message.sessionKey) === activeRun) {
          activeConversationRuns.delete(message.sessionKey);
        }
      }
    }
  };

  const createChannelOrchestrator = (
    egress: ChatEgressPort,
    draftFormatter?: (
      draft: Parameters<typeof formatDraftForQq>[0]
    ) => ReturnType<typeof formatDraftForQq>
  ) =>
    new BridgeOrchestrator({
      sessionStore,
      transcriptStore,
      turnStore,
      deliveryJobStore,
      conversationProvider,
      qqEgress: egress,
      draftFormatter,
      turnTimeoutMs: config.runtime.turnTimeoutMs,
      interruptTurn: async (sessionKey) => {
        if (activeConversationRuns.get(sessionKey)?.provider !== "codex-desktop") {
          return false;
        }
        if (!("interruptActiveTurn" in adapters.codexDesktop)) {
          return false;
        }
        return adapters.codexDesktop.interruptActiveTurn(sessionKey);
      }
    });

  const qqOrchestrators = Object.fromEntries(
    qqAdapters.map((entry) => [
      entry.accountKey,
      createChannelOrchestrator(entry.adapter.egress, formatDraftForQq)
    ])
  );

  const weixinAdapters = config.weixinAccounts
    .filter((account) => account.enabled && account.egressBaseUrl && account.egressToken)
    .map((account) => {
      const accountKey = `weixin:${account.accountId}`;
      return {
        accountKey,
        adapter: createWeixinChannelAdapter({
          accountKey,
          webhookPath: account.webhookPath,
          egressBaseUrl: account.egressBaseUrl!,
          egressToken: account.egressToken!
        })
      };
    });
  const weixinOrchestrators = Object.fromEntries(
    weixinAdapters.map((entry) => [
      entry.accountKey,
      createChannelOrchestrator(entry.adapter.egress, formatDraftForWeixin)
    ])
  );
  const defaultWeixinAdapter = weixinAdapters[0]?.adapter;
  const defaultWeixinOrchestrator = weixinAdapters[0]
    ? weixinOrchestrators[weixinAdapters[0].accountKey]
    : undefined;

  const channelOrchestrators: BootstrapOrchestrators = {
    qq: qqOrchestrators[defaultQqAdapter.accountKey],
    ...(defaultWeixinOrchestrator ? { weixin: defaultWeixinOrchestrator } : {}),
    byAccountKey: {
      ...qqOrchestrators,
      ...weixinOrchestrators
    }
  };

  const allAdapters: BootstrapAdapters = {
    ...adapters,
    ...(defaultWeixinAdapter ? { weixin: defaultWeixinAdapter } : {}),
    weixinByAccountKey: Object.fromEntries(
      weixinAdapters.map((entry) => [entry.accountKey, entry.adapter])
    )
  };

  const egressByAccountKey: Record<string, ChatEgressPort> = {
    ...Object.fromEntries(qqAdapters.map((entry) => [entry.accountKey, entry.adapter.egress])),
    ...Object.fromEntries(weixinAdapters.map((entry) => [entry.accountKey, entry.adapter.egress]))
  };
  const deliveryWorker = new DeliveryWorker({
    store: deliveryJobStore,
    resolveEgress: (draft) => {
      const accountKey = accountKeyFromSessionKey(draft.sessionKey);
      return accountKey ? egressByAccountKey[accountKey] ?? null : null;
    }
  });

  return {
    config,
    db,
    sessionStore,
    transcriptStore,
    turnStore,
    threadLockStore,
    deliveryJobStore,
    runtimeRecoveryStore,
    deliveryWorker,
    adapters: allAdapters,
    orchestrator: channelOrchestrators.qq,
    orchestrators: channelOrchestrators,
    qqGatewaySessionStore: defaultQqAdapter.sessionStore,
    chatgptDriver: chatgptProvider.desktopDriver
  };
}

async function resolveStableBinding(
  desktopDriver: Pick<DesktopDriverPort, "listRecentThreads">,
  binding: DriverBinding
): Promise<DriverBinding> {
  if (!binding.codexThreadRef?.startsWith("cdp-target:")) {
    return binding;
  }

  const currentThread = (await desktopDriver.listRecentThreads(200)).find(
    (thread) => thread.isCurrent
  );
  if (!currentThread) {
    return binding;
  }

  return {
    sessionKey: binding.sessionKey,
    codexThreadRef: currentThread.threadRef
  };
}

async function postTurnEvent(port: number, event: TurnEvent): Promise<void> {
  try {
    await fetch(`http://127.0.0.1:${port}${INTERNAL_TURN_EVENT_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(event)
    });
  } catch (error) {
    console.warn("[codex-desktop-orchestrator] turn event callback failed", {
      turnId: event.turnId,
      sessionKey: event.sessionKey,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

export { INTERNAL_TURN_EVENT_PATH };

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_") || "default";
}

function isContextLengthExceeded(error: unknown): boolean {
  return error instanceof DesktopDriverError && error.reason === "context_length_exceeded";
}

function hasCompactThread(
  driver: DesktopDriverPort
): driver is DesktopDriverPort & { compactThread(binding: DriverBinding): Promise<void> } {
  return typeof driver.compactThread === "function";
}

function accountKeyFromSessionKey(sessionKey: string): string | null {
  const separatorIndex = sessionKey.indexOf("::");
  if (separatorIndex < 0) {
    return null;
  }

  const accountKey = sessionKey.slice(0, separatorIndex).trim();
  return accountKey || null;
}

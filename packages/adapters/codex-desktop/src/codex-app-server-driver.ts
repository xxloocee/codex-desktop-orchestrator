import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import WebSocket from "ws";
import {
  type CodexControlState,
  type CodexThreadSummary,
  DesktopDriverError,
  type DriverBinding
} from "../../../domain/src/driver.js";
import {
  type InboundMessage,
  type OutboundDraft,
  TurnEventType,
  type ToolEventStatus,
  type TurnEvent
} from "../../../domain/src/message.js";
import type {
  ConversationRunOptions,
  DesktopDriverPort,
  OpenSessionOptions
} from "../../../ports/src/conversation.js";
import {
  buildMediaArtifactFromReference,
  parseQqMediaSegments
} from "../../qq/src/qq-media-parser.js";

const APP_THREAD_REF_PREFIX = "codex-app-thread:";
const LEGACY_THREAD_REF_PREFIX = "codex-thread:";
const CLIENT_INFO = {
  name: "codex-desktop-orchestrator",
  title: "Codex Desktop Orchestrator",
  version: "0.0.1"
};

type JsonRpcId = number;

type JsonRpcResponse = {
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
};

type JsonRpcNotification = {
  method: string;
  params?: unknown;
};

type CodexAppServerSocket = {
  readyState: number;
  send(data: string): void;
  close(): void;
  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: WebSocket.RawData) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "close", listener: () => void): void;
};

type ThreadRecord = {
  id: string;
  preview?: string;
  name?: string | null;
  cwd?: string;
  updatedAt?: number;
  turns?: Array<{
    id?: string;
    status?: string;
    startedAt?: number | null;
  }>;
  gitInfo?: {
    branch?: string | null;
  } | null;
  modelProvider?: string | null;
};

type ThreadListResponse = {
  data?: ThreadRecord[];
};

type TurnStartResponse = {
  turn?: {
    id?: string;
  };
};

type AgentDeltaParams = {
  threadId?: string;
  turnId?: string;
  itemId?: string;
  delta?: string;
};

type AppServerItem = {
  type?: string;
  id?: string;
  text?: string;
  phase?: string | null;
  name?: string | null;
  title?: string | null;
  command?: string | null;
  status?: string | null;
  output?: string | null;
  error?: unknown;
};

type ItemStartedParams = {
  threadId?: string;
  turnId?: string;
  item?: AppServerItem;
};

type ItemDeltaParams = {
  threadId?: string;
  turnId?: string;
  itemId?: string;
  delta?: string;
  item?: AppServerItem;
};

type ItemCompletedParams = {
  threadId?: string;
  turnId?: string;
  item?: AppServerItem;
};

type TurnCompletedParams = {
  threadId?: string;
  turn?: {
    id?: string;
    status?: string;
    error?: unknown;
  };
};

type ContextCompactedParams = {
  threadId?: string;
  turnId?: string;
};

type PendingTurn = {
  sessionKey: string;
  threadId: string;
  turnId: string;
  completed: boolean;
  failedReason: string | null;
  finalText: string;
  itemTexts: Map<string, string>;
  toolItems: Map<string, ToolItemState>;
  activeToolItemIds: Set<string>;
  toolSilenceTimer: NodeJS.Timeout | null;
  mediaReferences: string[];
  eventSequence: number;
  onTurnEvent: ((event: TurnEvent) => Promise<void>) | null;
  bufferedTurnEvents: TurnEvent[] | null;
  resolve: (result: AppServerTurnResult) => void;
  reject: (error: Error) => void;
  promise: Promise<AppServerTurnResult>;
};

type PendingSubmission = {
  cancelled: boolean;
};

type ToolItemState = {
  id: string;
  type: string | null;
  name: string;
  output: string;
};

type AppServerTurnResult = {
  turnId: string;
  finalText: string;
  mediaReferences: string[];
};

type CodexAppServerDriverOptions = {
  appServerUrl?: string | null;
  codexBinaryPath?: string | null;
  connectTimeoutMs?: number;
  replyTimeoutMs?: number;
  requestTimeoutMs?: number;
  staleTurnInterruptMs?: number;
  toolSilenceTimeoutMs?: number;
  defaultCwd?: string | null;
  sleep?: (ms: number) => Promise<void>;
  createWebSocket?: (url: string) => CodexAppServerSocket;
  controlFallback?: Pick<
    DesktopDriverPort,
    "getControlState" | "getQuotaSummary" | "switchModel"
  > | null;
  notificationForwarder?: {
    forwardNotification(method: string, params: unknown): Promise<void>;
  } | null;
};

export class CodexAppServerDriver implements DesktopDriverPort {
  private readonly connectTimeoutMs: number;
  private readonly replyTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly staleTurnInterruptMs: number;
  private readonly toolSilenceTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly createWebSocket: (url: string) => CodexAppServerSocket;
  private readonly controlFallback: CodexAppServerDriverOptions["controlFallback"];
  private readonly notificationForwarder: NonNullable<
    CodexAppServerDriverOptions["notificationForwarder"]
  > | null;
  private readonly externalAppServerUrl: string | null;
  private readonly codexBinaryPath: string;
  private readonly defaultCwd: string | null;
  private appServerUrl: string | null = null;
  private child: ChildProcess | null = null;
  private managedAppServerStartError: Error | null = null;
  private socket: CodexAppServerSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private nextRequestId = 1;
  private initialized = false;
  private readonly pendingRequests = new Map<
    JsonRpcId,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  private readonly pendingTurnsBySession = new Map<string, PendingTurn>();
  private readonly pendingTurnsByKey = new Map<string, PendingTurn>();
  private readonly pendingSubmissionsBySession = new Map<string, PendingSubmission>();
  private readonly pendingCompactionsByThread = new Map<string, () => void>();
  private notificationForwardTail: Promise<void> = Promise.resolve();
  private lastNotificationForwardErrorAt = 0;

  constructor(options: CodexAppServerDriverOptions = {}) {
    this.externalAppServerUrl =
      options.appServerUrl ?? process.env.CODEX_APP_SERVER_URL ?? null;
    this.codexBinaryPath =
      options.codexBinaryPath
      ?? process.env.CODEX_BINARY_PATH
      ?? resolveDefaultCodexBinaryPath();
    this.defaultCwd = normalizeCwd(options.defaultCwd ?? process.env.CODEX_WORKSPACE_CWD ?? null);
    this.connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
    this.replyTimeoutMs = options.replyTimeoutMs ?? 0;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.staleTurnInterruptMs = options.staleTurnInterruptMs ?? 10 * 60_000;
    this.toolSilenceTimeoutMs =
      options.toolSilenceTimeoutMs
      ?? parseOptionalPositiveInteger(process.env.CODEX_TOOL_SILENCE_TIMEOUT_MS)
      ?? 0;
    this.sleep =
      options.sleep ??
      ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.createWebSocket =
      options.createWebSocket ??
      ((url) => new WebSocket(url) as unknown as CodexAppServerSocket);
    this.controlFallback = options.controlFallback ?? null;
    this.notificationForwarder = options.notificationForwarder ?? null;
  }

  async ensureAppReady(): Promise<void> {
    await this.ensureConnected();
  }

  async shutdown(): Promise<void> {
    this.socket?.close();
    this.socket = null;
    this.initialized = false;
    this.appServerUrl = null;

    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new DesktopDriverError("Codex app-server driver is shutting down", "app_not_ready"));
    }
    this.pendingRequests.clear();

    for (const pending of this.pendingTurnsBySession.values()) {
      this.clearToolSilenceTimer(pending);
      pending.reject(new DesktopDriverError("Codex app-server driver is shutting down", "reply_timeout"));
    }
    this.pendingTurnsBySession.clear();
    this.pendingTurnsByKey.clear();

    const child = this.child;
    this.child = null;
    if (!child?.pid) {
      return;
    }

    await terminateProcessTree(child);
  }

  async getControlState(binding: DriverBinding | null = null): Promise<CodexControlState> {
    try {
      await this.ensureConnected();
      const [config, controlThread] = await Promise.all([
        this.request<{ config?: Record<string, unknown> }>("config/read", {
          includeLayers: false
        }).catch(() => null),
        this.getControlThread(binding?.codexThreadRef ?? null).catch(() => null)
      ]);
      const quotaSummary = await this.getQuotaSummary().catch(() => null);
      const effectiveConfig = config?.config ?? {};
      const threadSummary = controlThread ? this.threadToSummary(controlThread, 1) : null;

      return {
        threadRef: threadSummary?.threadRef ?? binding?.codexThreadRef ?? null,
        threadTitle: threadSummary?.title ?? null,
        threadProjectName: threadSummary?.projectName ?? null,
        threadRelativeTime: threadSummary?.relativeTime ?? null,
        model: readString(effectiveConfig.model),
        reasoningEffort: readString(effectiveConfig.model_reasoning_effort),
        workspace: controlThread?.cwd ? path.basename(controlThread.cwd) : null,
        branch: controlThread?.gitInfo?.branch ?? null,
        permissionMode:
          formatPermissionMode(effectiveConfig.approval_policy, effectiveConfig.sandbox_mode),
        quotaSummary
      };
    } catch {
      return (
        await this.controlFallback?.getControlState().catch(() => null)
      ) ?? {
        model: null,
        reasoningEffort: null,
        workspace: null,
        branch: null,
        permissionMode: null,
        quotaSummary: null
      };
    }
  }

  async getQuotaSummary(): Promise<string | null> {
    try {
      await this.ensureConnected();
      const response = await this.request<{
        rateLimits?: RateLimitSnapshot;
        rateLimitsByLimitId?: Record<string, RateLimitSnapshot | undefined> | null;
      }>("account/rateLimits/read");
      const snapshot = response.rateLimitsByLimitId?.codex ?? response.rateLimits ?? null;
      return formatRateLimitSnapshot(snapshot);
    } catch {
      return this.controlFallback?.getQuotaSummary().catch(() => null) ?? null;
    }
  }

  async switchModel(model: string): Promise<CodexControlState> {
    if (this.controlFallback) {
      return this.controlFallback.switchModel(model);
    }

    throw new DesktopDriverError(
      "Codex app-server model switching is not enabled in bridge yet",
      "control_not_found"
    );
  }

  async openOrBindSession(
    sessionKey: string,
    binding: DriverBinding | null,
    options: OpenSessionOptions = {}
  ): Promise<DriverBinding> {
    await this.ensureConnected();

    const existingThreadId = await this.resolveThreadId(binding?.codexThreadRef ?? null);
    if (existingThreadId) {
      const thread = await this.findThreadById(existingThreadId);
      return {
        sessionKey,
        codexThreadRef: this.encodeThreadRef(
          existingThreadId,
          thread ? this.threadToSummary(thread, 1).title : existingThreadId,
          thread ? this.threadToSummary(thread, 1).projectName : null
        )
      };
    }

    return this.createThread(sessionKey, "", options);
  }

  async listRecentThreads(limit: number): Promise<CodexThreadSummary[]> {
    await this.ensureConnected();
    const response = await this.request<ThreadListResponse>("thread/list", {
      limit,
      sortKey: "updated_at",
      sortDirection: "desc",
      sourceKinds: [],
      archived: false
    });

    return (response.data ?? [])
      .slice(0, limit)
      .map((thread, index) => this.threadToSummary(thread, index + 1));
  }

  async switchToThread(sessionKey: string, threadRef: string): Promise<DriverBinding> {
    await this.ensureConnected();
    const threadId = await this.resolveThreadId(threadRef);
    if (!threadId) {
      throw new DesktopDriverError("Codex app-server thread binding is invalid", "session_not_found");
    }

    const thread = await this.findThreadById(threadId);
    if (!thread) {
      throw new DesktopDriverError("Codex app-server thread not found", "session_not_found");
    }

    const summary = this.threadToSummary(thread, 1);
    return {
      sessionKey,
      codexThreadRef: summary.threadRef
    };
  }

  async createThread(
    sessionKey: string,
    seedPrompt: string,
    options: OpenSessionOptions = {}
  ): Promise<DriverBinding> {
    await this.ensureConnected();
    const response = await this.request<{ thread?: ThreadRecord }>("thread/start", {
      cwd: this.resolveCwd(options.cwd)
    });
    const thread = response.thread;
    if (!thread?.id) {
      throw new DesktopDriverError("Codex app-server did not return a thread id", "session_not_found");
    }

    const summary = this.threadToSummary(thread, 1);
    const binding = {
      sessionKey,
      codexThreadRef: summary.threadRef
    };

    if (seedPrompt.trim()) {
      await this.sendUserMessage(binding, {
        messageId: `thread-seed:${randomUUID()}`,
        accountKey: "qqbot:default",
        sessionKey,
        peerKey: "qq:c2c:thread-control",
        chatType: "c2c",
        senderId: "thread-control",
        text: seedPrompt,
        receivedAt: new Date().toISOString()
      });
      await this.collectAssistantReply(binding).catch(() => []);
    }

    return binding;
  }

  private resolveCwd(cwd: string | null | undefined): string {
    return normalizeCwd(cwd) ?? this.defaultCwd ?? process.cwd();
  }

  async sendUserMessage(binding: DriverBinding, message: InboundMessage): Promise<void> {
    const submission: PendingSubmission = { cancelled: false };
    this.pendingSubmissionsBySession.set(binding.sessionKey, submission);
    const assertNotCancelled = () => {
      if (submission.cancelled) {
        throw new DesktopDriverError(
          "Codex app-server turn was cancelled before submit",
          "turn_cancelled"
        );
      }
    };

    try {
      await this.ensureConnected();
      assertNotCancelled();
      const threadId = await this.resolveThreadId(binding.codexThreadRef);
      assertNotCancelled();
      if (!threadId) {
        throw new DesktopDriverError("Codex app-server thread binding is missing", "session_not_found");
      }

      await this.request("thread/resume", { threadId }).catch(() => undefined);
      assertNotCancelled();
      await this.interruptStaleRunningTurn(threadId);
      assertNotCancelled();
      await this.forwardThreadSnapshotToApp(threadId);
      assertNotCancelled();

      const response = await this.request<TurnStartResponse>("turn/start", {
        threadId,
        input: [
          {
            type: "text",
            text: message.text,
            text_elements: []
          }
        ]
      });
      const turnId = response.turn?.id;
      if (!turnId) {
        throw new DesktopDriverError("Codex app-server did not return a turn id", "submit_failed");
      }
      if (submission.cancelled) {
        await this.interruptTurn(threadId, turnId).catch(() => undefined);
        assertNotCancelled();
      }

      const pending = this.createPendingTurn(binding.sessionKey, threadId, turnId);
      this.pendingTurnsBySession.set(binding.sessionKey, pending);
      this.pendingTurnsByKey.set(buildTurnKey(threadId, turnId), pending);
    } finally {
      if (this.pendingSubmissionsBySession.get(binding.sessionKey) === submission) {
        this.pendingSubmissionsBySession.delete(binding.sessionKey);
      }
    }
  }

  async collectAssistantReply(
    binding: DriverBinding,
    options: ConversationRunOptions = {}
  ): Promise<OutboundDraft[]> {
    const pending = this.pendingTurnsBySession.get(binding.sessionKey);
    if (!pending) {
      throw new DesktopDriverError(
        "Codex app-server has no pending turn for this session",
        "reply_timeout"
      );
    }
    pending.onTurnEvent = options.onTurnEvent ?? null;

    let result: AppServerTurnResult;
    try {
      const pendingResult = (async () => {
        await this.flushBufferedTurnEvents(pending);
        return pending.promise;
      })();
      result = this.replyTimeoutMs > 0
        ? await withTimeout(
            pendingResult,
            this.replyTimeoutMs,
            "Codex app-server reply did not arrive before timeout"
          )
        : await pendingResult;
    } catch (error) {
      if (!(error instanceof DesktopDriverError && error.reason === "turn_cancelled")) {
        await this.interruptTurn(pending.threadId, pending.turnId).catch(() => undefined);
      }
      throw error;
    } finally {
      this.clearToolSilenceTimer(pending);
      this.pendingTurnsBySession.delete(binding.sessionKey);
      this.pendingTurnsByKey.delete(buildTurnKey(pending.threadId, pending.turnId));
    }

    const draft = this.buildOutboundDraftFromText(
      binding.sessionKey,
      result.finalText,
      result.mediaReferences,
      result.turnId
    );

    if (options.onDraft) {
      await options.onDraft(draft);
      return [];
    }

    return [draft];
  }

  async interruptActiveTurn(sessionKey: string): Promise<boolean> {
    await this.ensureConnected();
    const pending = this.pendingTurnsBySession.get(sessionKey);
    if (!pending) {
      const submission = this.pendingSubmissionsBySession.get(sessionKey);
      if (!submission) {
        return false;
      }
      submission.cancelled = true;
      return true;
    }

    await this.interruptTurn(pending.threadId, pending.turnId);
    this.clearToolSilenceTimer(pending);
    pending.reject(
      new DesktopDriverError("Codex app-server turn was cancelled", "turn_cancelled")
    );
    return true;
  }

  async compactThread(binding: DriverBinding): Promise<void> {
    await this.ensureConnected();
    const threadId = await this.resolveThreadId(binding.codexThreadRef);
    if (!threadId) {
      throw new DesktopDriverError("Codex app-server thread binding is missing", "session_not_found");
    }

    await this.request("thread/resume", { threadId }).catch(() => undefined);
    await this.forwardThreadSnapshotToApp(threadId);
    await this.waitForThreadCompaction(threadId);
    await this.request("thread/resume", { threadId }).catch(() => undefined);
    await this.forwardThreadSnapshotToApp(threadId);
  }

  async markSessionBroken(_sessionKey: string, _reason: string): Promise<void> {
    return;
  }

  private async ensureConnected(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN && this.initialized) {
      return;
    }

    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }

    this.connectPromise = this.connect();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private async connect(): Promise<void> {
    const url = this.externalAppServerUrl ?? await this.startManagedAppServer();
    const startedAt = Date.now();
    let lastError: Error | null = null;

    while (Date.now() - startedAt < this.connectTimeoutMs) {
      try {
        if (this.managedAppServerStartError) {
          throw this.managedAppServerStartError;
        }
        await this.openSocket(url);
        await this.request("initialize", {
          clientInfo: CLIENT_INFO,
          capabilities: {
            experimentalApi: true
          }
        });
        this.initialized = true;
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.socket?.close();
        this.socket = null;
        await this.sleep(250);
      }
    }

    throw new DesktopDriverError(
      `Codex app-server is not ready: ${lastError?.message ?? "connection timeout"}`,
      "app_not_ready"
    );
  }

  private async startManagedAppServer(): Promise<string> {
    if (this.appServerUrl) {
      return this.appServerUrl;
    }

    const port = await getFreePort();
    const url = `ws://127.0.0.1:${port}`;
    this.managedAppServerStartError = null;
    try {
      this.child = spawn(
        this.codexBinaryPath,
        ["app-server", "--listen", url, "-c", "analytics.enabled=false"],
        {
          stdio: ["ignore", "pipe", "pipe"],
          shell: shouldSpawnCodexViaShell(this.codexBinaryPath)
        }
      );
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.managedAppServerStartError = normalized;
      this.appServerUrl = url;
      console.error("[codex-desktop-orchestrator] codex app-server failed to start", {
        binary: this.codexBinaryPath,
        error: normalized.message
      });
      return url;
    }
    this.child.on("exit", () => {
      this.socket?.close();
      this.socket = null;
      this.initialized = false;
      this.appServerUrl = null;
    });
    this.child.on("error", (error) => {
      this.managedAppServerStartError = error;
      this.socket?.close();
      this.socket = null;
      this.initialized = false;
      this.appServerUrl = null;
      console.error("[codex-desktop-orchestrator] codex app-server failed to start", {
        binary: this.codexBinaryPath,
        error: error.message
      });
    });
    this.child.stderr?.on("data", (chunk) => {
      this.logCodexAppServerStderr(String(chunk));
    });
    this.child.stdout?.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) {
        console.info("[codex-desktop-orchestrator] codex app-server", { text });
      }
    });
    this.appServerUrl = url;
    console.info("[codex-desktop-orchestrator] codex app-server starting", {
      url,
      binary: this.codexBinaryPath
    });
    return url;
  }

  private logCodexAppServerStderr(rawText: string): void {
    const text = stripAnsi(rawText).trim();
    if (!text || isNoisyCodexBackendWebsocketError(text)) {
      return;
    }

    console.warn("[codex-desktop-orchestrator] codex app-server stderr", { text });
  }

  private async openSocket(url: string): Promise<void> {
    const socket = this.createWebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("websocket open timeout"));
      }, this.connectTimeoutMs);
      socket.on("open", () => {
        clearTimeout(timeout);
        resolve();
      });
      socket.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });

    socket.on("message", (data) => {
      this.handleSocketMessage(String(data));
    });
    socket.on("close", () => {
      this.initialized = false;
      this.socket = null;
      for (const request of this.pendingRequests.values()) {
        clearTimeout(request.timeout);
        request.reject(new Error("Codex app-server websocket closed"));
      }
      this.pendingRequests.clear();
    });
    socket.on("error", (error) => {
      console.warn("[codex-desktop-orchestrator] codex app-server websocket error", {
        error: error.message
      });
    });
    this.socket = socket;
  }

  private request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Codex app-server websocket is not connected"));
    }

    const id = this.nextRequestId++;
    const payload =
      typeof params === "undefined"
        ? { jsonrpc: "2.0", id, method }
        : { jsonrpc: "2.0", id, method, params };

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, this.requestTimeoutMs);

      this.pendingRequests.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout
      });
      this.socket!.send(JSON.stringify(payload));
    });
  }

  private handleSocketMessage(raw: string): void {
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    if (isJsonRpcResponse(message)) {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) {
        return;
      }

      clearTimeout(pending.timeout);
      this.pendingRequests.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? "Codex app-server request failed"));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (!isJsonRpcNotification(message)) {
      return;
    }

    if ("id" in message && typeof message.id === "number") {
      this.socket?.send(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32601,
          message: "codex-desktop-orchestrator does not handle server requests yet"
        }
      }));
      return;
    }

    this.handleNotification(message.method, message.params);
  }

  private handleNotification(method: string, params: unknown): void {
    this.forwardNotificationToApp(method, params);

    if (method === "item/agentMessage/delta") {
      this.handleAgentDelta(params as AgentDeltaParams);
      return;
    }

    if (method === "item/started") {
      this.handleItemStarted(params as ItemStartedParams);
      return;
    }

    if (method === "item/delta") {
      this.handleItemDelta(params as ItemDeltaParams);
      return;
    }

    if (method === "item/completed") {
      this.handleItemCompleted(params as ItemCompletedParams);
      return;
    }

    if (method === "turn/completed") {
      void this.handleTurnCompleted(params as TurnCompletedParams).catch((error) => {
        console.warn("[codex-desktop-orchestrator] turn completion handling failed", {
          error: error instanceof Error ? error.message : String(error)
        });
      });
      return;
    }

    if (method === "thread/compacted") {
      this.handleThreadCompacted(params as ContextCompactedParams);
    }
  }

  private handleAgentDelta(params: AgentDeltaParams): void {
    const pending = this.findPendingTurn(params.threadId, params.turnId);
    if (!pending || !params.itemId || typeof params.delta !== "string") {
      return;
    }

    pending.itemTexts.set(
      params.itemId,
      `${pending.itemTexts.get(params.itemId) ?? ""}${params.delta}`
    );
    void this.emitTurnEvent(pending, TurnEventType.Delta, {
      text: params.delta
    });
  }

  private handleItemStarted(params: ItemStartedParams): void {
    const pending = this.findPendingTurn(params.threadId, params.turnId);
    const item = params.item;
    if (!pending || !item?.id || isAgentMessageItem(item)) {
      return;
    }

    const tool = this.upsertToolItem(pending, item);
    pending.activeToolItemIds.add(tool.id);
    this.refreshToolSilenceTimer(pending);
    this.emitToolEvent(pending, "started", tool, summarizeToolItem(item));
  }

  private handleItemDelta(params: ItemDeltaParams): void {
    const pending = this.findPendingTurn(params.threadId, params.turnId);
    if (!pending || !params.itemId || typeof params.delta !== "string") {
      return;
    }

    if (params.item && isAgentMessageItem(params.item)) {
      return;
    }

    const knownTool = pending.toolItems.get(params.itemId);
    if (!knownTool && params.item?.type && isAgentMessageType(params.item.type)) {
      return;
    }

    const tool = knownTool
      ?? this.upsertToolItem(pending, {
        ...(params.item ?? {}),
        id: params.itemId
      });
    tool.output += params.delta;
    pending.activeToolItemIds.add(tool.id);
    this.refreshToolSilenceTimer(pending);
    this.emitToolEvent(pending, "output", tool, truncateSummary(params.delta));
  }

  private handleItemCompleted(params: ItemCompletedParams): void {
    const pending = this.findPendingTurn(params.threadId, params.turnId);
    const item = params.item;
    if (!pending || !item?.id) {
      return;
    }

    if (!isAgentMessageItem(item)) {
      this.handleToolItemCompleted(pending, item);
      return;
    }

    const text = (item.text ?? pending.itemTexts.get(item.id) ?? "").trim();
    if (!text) {
      return;
    }

    pending.finalText = text;
    pending.mediaReferences = extractMediaReferences(text);
  }

  private handleToolItemCompleted(pending: PendingTurn, item: AppServerItem): void {
    const tool = this.upsertToolItem(pending, item);
    const summary = summarizeToolItem(item) || truncateSummary(tool.output);
    const status = isFailedToolItem(item) ? "failed" : "completed";
    pending.activeToolItemIds.delete(tool.id);
    this.refreshToolSilenceTimer(pending);
    this.emitToolEvent(pending, status, tool, summary);
  }

  private async handleTurnCompleted(params: TurnCompletedParams): Promise<void> {
    const turnId = params.turn?.id;
    const pending = this.findPendingTurn(params.threadId, turnId);
    if (!pending || !turnId) {
      return;
    }

    if (params.turn?.status && params.turn.status !== "completed") {
      pending.completed = true;
      pending.failedReason = JSON.stringify(params.turn.error ?? params.turn.status);
      this.clearToolSilenceTimer(pending);
      await this.emitTurnEvent(
        pending,
        TurnEventType.Completed,
        {
          status: pending.failedReason
        },
        true
      );
      pending.reject(
        new DesktopDriverError(
          `Codex app-server turn failed: ${pending.failedReason}`,
          getFailedTurnReason(params.turn.error)
        )
      );
      return;
    }

    const finalText = pending.finalText || getLastMapValue(pending.itemTexts).trim();
    pending.completed = true;
    this.clearToolSilenceTimer(pending);
    await this.emitTurnEvent(
      pending,
      TurnEventType.Completed,
      {
        fullText: finalText,
        mediaReferences: extractMediaReferences(finalText),
        completionReason: "stable"
      },
      true
    );
    pending.resolve({
      turnId,
      finalText,
      mediaReferences: extractMediaReferences(finalText)
    });
  }

  private handleThreadCompacted(params: ContextCompactedParams): void {
    if (!params.threadId) {
      return;
    }

    const resolve = this.pendingCompactionsByThread.get(params.threadId);
    if (!resolve) {
      return;
    }

    this.pendingCompactionsByThread.delete(params.threadId);
    resolve();
  }

  private async waitForThreadCompaction(threadId: string): Promise<void> {
    const compacted = new Promise<void>((resolve) => {
      this.pendingCompactionsByThread.set(threadId, resolve);
    });

    try {
      await this.request("thread/compact/start", { threadId });
      await withTimeout(
        compacted,
        this.requestTimeoutMs,
        "Codex app-server thread compaction did not finish before timeout"
      );
    } finally {
      this.pendingCompactionsByThread.delete(threadId);
    }
  }

  private findPendingTurn(
    threadId: string | null | undefined,
    turnId: string | null | undefined
  ): PendingTurn | null {
    if (!threadId || !turnId) {
      return null;
    }

    return this.pendingTurnsByKey.get(buildTurnKey(threadId, turnId)) ?? null;
  }

  private createPendingTurn(sessionKey: string, threadId: string, turnId: string): PendingTurn {
    let resolve!: (result: AppServerTurnResult) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<AppServerTurnResult>((innerResolve, innerReject) => {
      resolve = innerResolve;
      reject = innerReject;
    });

    return {
      sessionKey,
      threadId,
      turnId,
      completed: false,
      failedReason: null,
      finalText: "",
      itemTexts: new Map(),
      toolItems: new Map(),
      activeToolItemIds: new Set(),
      toolSilenceTimer: null,
      mediaReferences: [],
      eventSequence: 0,
      onTurnEvent: null,
      bufferedTurnEvents: [],
      resolve,
      reject,
      promise
    };
  }

  private upsertToolItem(pending: PendingTurn, item: AppServerItem): ToolItemState {
    const id = item.id!;
    const existing = pending.toolItems.get(id);
    if (existing) {
      existing.name = readToolName(item) ?? existing.name;
      existing.type = readString(item.type) ?? existing.type;
      return existing;
    }

    const created: ToolItemState = {
      id,
      type: readString(item.type),
      name: readToolName(item) ?? "tool",
      output: ""
    };
    pending.toolItems.set(id, created);
    return created;
  }

  private emitToolEvent(
    pending: PendingTurn,
    toolStatus: ToolEventStatus,
    tool: ToolItemState,
    summary: string | null
  ): void {
    void this.emitTurnEvent(pending, TurnEventType.Status, {
      toolName: tool.name,
      toolStatus,
      ...(summary ? { summary } : {})
    });
  }

  private refreshToolSilenceTimer(pending: PendingTurn): void {
    this.clearToolSilenceTimer(pending);
    if (
      this.toolSilenceTimeoutMs <= 0
      || pending.completed
      || pending.activeToolItemIds.size === 0
    ) {
      return;
    }

    pending.toolSilenceTimer = setTimeout(() => {
      void this.handleToolSilenceTimeout(pending);
    }, this.toolSilenceTimeoutMs);
  }

  private async handleToolSilenceTimeout(pending: PendingTurn): Promise<void> {
    if (pending.completed || pending.activeToolItemIds.size === 0) {
      return;
    }

    pending.completed = true;
    const activeToolId = pending.activeToolItemIds.values().next().value as string | undefined;
    const tool = activeToolId ? pending.toolItems.get(activeToolId) : null;
    const toolName = tool?.name ?? "tool";
    const status = `tool silence timeout: ${toolName}`;
    pending.failedReason = status;
    this.clearToolSilenceTimer(pending);
    await this.emitTurnEvent(
      pending,
      TurnEventType.Completed,
      {
        status,
        toolName,
        toolStatus: "silence-timeout"
      },
      true
    );
    pending.reject(new DesktopDriverError(status, "reply_timeout"));
  }

  private clearToolSilenceTimer(pending: PendingTurn): void {
    if (!pending.toolSilenceTimer) {
      return;
    }

    clearTimeout(pending.toolSilenceTimer);
    pending.toolSilenceTimer = null;
  }

  private async emitTurnEvent(
    pending: PendingTurn,
    eventType: TurnEventType,
    payload: TurnEvent["payload"],
    isFinal = false
  ): Promise<void> {
    pending.eventSequence += 1;
    const event: TurnEvent = {
      sessionKey: pending.sessionKey,
      turnId: pending.turnId,
      sequence: pending.eventSequence,
      eventType,
      createdAt: new Date().toISOString(),
      isFinal,
      payload
    };
    const onTurnEvent = pending.onTurnEvent;
    if (!onTurnEvent) {
      pending.bufferedTurnEvents?.push(event);
      return;
    }

    await this.deliverTurnEvent(onTurnEvent, event);
  }

  private async flushBufferedTurnEvents(pending: PendingTurn): Promise<void> {
    const events = pending.bufferedTurnEvents;
    const onTurnEvent = pending.onTurnEvent;
    if (!events) {
      return;
    }

    pending.bufferedTurnEvents = onTurnEvent ? [] : null;
    if (!onTurnEvent) {
      return;
    }

    for (const event of events) {
      await this.deliverTurnEvent(onTurnEvent, event);
    }
  }

  private async deliverTurnEvent(
    onTurnEvent: (event: TurnEvent) => Promise<void>,
    event: TurnEvent
  ): Promise<void> {
    try {
      await onTurnEvent(event);
    } catch (error) {
      console.warn("[codex-desktop-orchestrator] codex app-server turn event callback failed", {
        sessionKey: event.sessionKey,
        turnId: event.turnId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async forwardThreadSnapshotToApp(threadId: string): Promise<void> {
    if (!this.notificationForwarder) {
      return;
    }

    const thread = await this.findThreadById(threadId).catch(() => null);
    if (!thread) {
      return;
    }

    await this.forwardNotificationToApp("thread/started", { thread }, { wait: true });
  }

  private async forwardNotificationToApp(
    method: string,
    params: unknown,
    options: { wait?: boolean } = {}
  ): Promise<void> {
    if (!this.notificationForwarder) {
      return;
    }

    const task = this.notificationForwardTail
      .catch(() => undefined)
      .then(() => this.notificationForwarder!.forwardNotification(method, params));
    this.notificationForwardTail = task.catch((error) => {
      this.logNotificationForwardError(error);
    });

    if (options.wait) {
      await this.notificationForwardTail;
    }
  }

  private logNotificationForwardError(error: unknown): void {
    const now = Date.now();
    if (now - this.lastNotificationForwardErrorAt < 30_000) {
      return;
    }
    this.lastNotificationForwardErrorAt = now;
    console.warn("[codex-desktop-orchestrator] codex app ui notification forward failed", {
      error: error instanceof Error ? error.message : String(error)
    });
  }

  private async getLatestThread(): Promise<ThreadRecord | null> {
    const response = await this.request<ThreadListResponse>("thread/list", {
      limit: 1,
      sortKey: "updated_at",
      sortDirection: "desc",
      sourceKinds: [],
      archived: false
    });

    return response.data?.[0] ?? null;
  }

  private async getControlThread(threadRef: string | null | undefined): Promise<ThreadRecord | null> {
    const threadId = await this.resolveThreadId(threadRef);
    if (threadId) {
      return this.findThreadById(threadId);
    }

    return this.getLatestThread();
  }

  private async findThreadById(threadId: string): Promise<ThreadRecord | null> {
    return this.readThreadById(threadId, false);
  }

  private async readThreadById(threadId: string, includeTurns: boolean): Promise<ThreadRecord | null> {
    const response = await this.request<{ thread?: ThreadRecord }>("thread/read", {
      threadId,
      includeTurns
    }).catch(() => null);
    return response?.thread ?? null;
  }

  private async interruptStaleRunningTurn(threadId: string): Promise<void> {
    if (this.staleTurnInterruptMs <= 0) {
      return;
    }

    const thread = await this.readThreadById(threadId, true);
    const staleTurns = (thread?.turns ?? [])
      .filter((turn) =>
        turn.id
        && turn.status === "inProgress"
        && isStaleTurn(turn.startedAt, this.staleTurnInterruptMs)
      );

    for (const turn of staleTurns) {
      await this.interruptTurn(threadId, turn.id!).catch((error) => {
        console.warn("[codex-desktop-orchestrator] codex stale turn interrupt failed", {
          threadId,
          turnId: turn.id,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }
  }

  private async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.request("turn/interrupt", { threadId, turnId });
  }

  private async resolveThreadId(threadRef: string | null | undefined): Promise<string | null> {
    if (!threadRef) {
      return null;
    }

    if (threadRef.startsWith(APP_THREAD_REF_PREFIX)) {
      const payload = threadRef.slice(APP_THREAD_REF_PREFIX.length);
      const separatorIndex = payload.indexOf(":");
      return separatorIndex >= 0 ? payload.slice(0, separatorIndex) : payload;
    }

    const legacyLocator = decodeLegacyThreadRef(threadRef);
    if (!legacyLocator) {
      return null;
    }

    const threads = await this.listRecentThreads(200);
    const matched = threads.find((thread) =>
      thread.title === legacyLocator.title
      && (
        !legacyLocator.projectName
        || thread.projectName === legacyLocator.projectName
      )
    );
    return matched ? this.resolveThreadId(matched.threadRef) : null;
  }

  private encodeThreadRef(
    threadId: string,
    title: string,
    projectName: string | null
  ): string {
    const encoded = Buffer.from(
      JSON.stringify({ title, projectName }),
      "utf8"
    ).toString("base64url");
    return `${APP_THREAD_REF_PREFIX}${threadId}:${encoded}`;
  }

  private threadToSummary(thread: ThreadRecord, index: number): CodexThreadSummary {
    const title = normalizeThreadTitle(thread);
    const projectName = thread.cwd ? path.basename(thread.cwd) : null;
    return {
      index,
      title,
      projectName,
      relativeTime: formatRelativeTime(thread.updatedAt),
      isCurrent: false,
      threadRef: this.encodeThreadRef(thread.id, title, projectName)
    };
  }

  private buildOutboundDraftFromText(
    sessionKey: string,
    text: string,
    mediaReferences: string[],
    turnId: string
  ): OutboundDraft {
    return {
      draftId: randomUUID(),
      turnId,
      sessionKey,
      text,
      ...(mediaReferences.length > 0
        ? {
            mediaArtifacts: mediaReferences.map((reference) =>
              buildMediaArtifactFromReference(reference)
            )
          }
        : {}),
      createdAt: new Date().toISOString()
    };
  }
}

type RateLimitSnapshot = {
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
};

type RateLimitWindow = {
  remainingPercent?: number | null;
  usedPercent?: number | null;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
};

function resolveDefaultCodexBinaryPath(): string {
  const appBundleBinary = "/Applications/Codex.app/Contents/Resources/codex";
  return fs.existsSync(appBundleBinary) ? appBundleBinary : "codex";
}

function shouldSpawnCodexViaShell(binaryPath: string): boolean {
  if (process.platform !== "win32") {
    return false;
  }
  return !/\.exe$/i.test(binaryPath);
}

function normalizeCwd(cwd: string | null | undefined): string | null {
  const value = cwd?.trim();
  return value ? value : null;
}

function parseOptionalPositiveInteger(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getFailedTurnReason(error: unknown): DesktopDriverError["reason"] {
  if (containsText(error, "context_length_exceeded")) {
    return "context_length_exceeded";
  }
  if (isCodexServiceError(error)) {
    return "service_error";
  }
  return "submit_failed";
}

function isCodexServiceError(value: unknown): boolean {
  return containsText(value, "service_error");
}

function containsText(value: unknown, needle: string): boolean {
  if (typeof value === "string") {
    return value.includes(needle);
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  return Object.values(value).some((entry) => containsText(entry, needle));
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid) {
    return;
  }

  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      execFile("taskkill.exe", ["/pid", String(pid), "/t", "/f"], { windowsHide: true }, () => resolve());
    });
    return;
  }

  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 2_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function isNoisyCodexBackendWebsocketError(text: string): boolean {
  return (
    text.includes("codex_api::endpoint::responses_websocket")
    && text.includes("failed to connect to websocket")
    && text.includes("wss://chatgpt.com/backend-api/codex/responses")
    && (
      text.includes("Connection reset by peer")
      || text.includes("Broken pipe")
    )
  );
}

function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  return (
    typeof value === "object"
    && value !== null
    && "id" in value
    && !("method" in value)
  );
}

function isJsonRpcNotification(value: unknown): value is JsonRpcNotification & { id?: number } {
  return (
    typeof value === "object"
    && value !== null
    && "method" in value
    && typeof (value as { method?: unknown }).method === "string"
  );
}

function buildTurnKey(threadId: string, turnId: string): string {
  return `${threadId}:${turnId}`;
}

function getLastMapValue(map: Map<string, string>): string {
  let value = "";
  for (const next of map.values()) {
    value = next;
  }
  return value;
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "object" && address?.port) {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("failed to allocate port")));
      }
    });
    server.on("error", reject);
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new DesktopDriverError(message, "reply_timeout")), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function normalizeThreadTitle(thread: ThreadRecord): string {
  const explicitName = thread.name?.trim();
  if (explicitName) {
    return explicitName;
  }

  const firstLine = thread.preview?.split(/\r?\n/).find((line) => line.trim())?.trim();
  return firstLine || thread.id;
}

function formatRelativeTime(updatedAt: number | null | undefined): string | null {
  if (!updatedAt) {
    return null;
  }

  const elapsedMs = Math.max(0, Date.now() - updatedAt * 1000);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (elapsedMs < minute) {
    return "刚刚";
  }
  if (elapsedMs < hour) {
    return `${Math.floor(elapsedMs / minute)} 分钟前`;
  }
  if (elapsedMs < day) {
    return `${Math.floor(elapsedMs / hour)} 小时前`;
  }
  return `${Math.floor(elapsedMs / day)} 天前`;
}

function isStaleTurn(startedAt: number | null | undefined, staleTurnInterruptMs: number): boolean {
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) {
    return false;
  }

  return Date.now() - startedAt * 1000 >= staleTurnInterruptMs;
}

function decodeLegacyThreadRef(threadRef: string): { title: string; projectName: string | null } | null {
  if (!threadRef.startsWith(LEGACY_THREAD_REF_PREFIX)) {
    return null;
  }

  const payload = threadRef.slice(LEGACY_THREAD_REF_PREFIX.length);
  const separatorIndex = payload.indexOf(":");
  if (separatorIndex <= 0) {
    return null;
  }

  try {
    const locator = JSON.parse(
      Buffer.from(payload.slice(separatorIndex + 1), "base64url").toString("utf8")
    ) as { title?: string; projectName?: string | null };
    if (typeof locator.title !== "string" || !locator.title.trim()) {
      return null;
    }
    return {
      title: locator.title,
      projectName:
        typeof locator.projectName === "string" && locator.projectName.trim()
          ? locator.projectName
          : null
    };
  } catch {
    return null;
  }
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function isAgentMessageItem(item: AppServerItem): boolean {
  return isAgentMessageType(item.type);
}

function isAgentMessageType(type: string | null | undefined): boolean {
  return type === "agentMessage";
}

function readToolName(item: AppServerItem): string | null {
  return (
    readString(item.name)
    ?? readString(item.title)
    ?? readString(item.command)
    ?? readString(item.type)
  );
}

function summarizeToolItem(item: AppServerItem): string | null {
  return truncateSummary(
    readString(item.text)
    ?? readString(item.output)
    ?? (item.error ? JSON.stringify(item.error) : null)
    ?? readString(item.status)
  );
}

function truncateSummary(value: string | null | undefined): string | null {
  const text = value?.trim();
  if (!text) {
    return null;
  }

  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}

function isFailedToolItem(item: AppServerItem): boolean {
  if (item.error) {
    return true;
  }

  const status = item.status?.trim();
  return Boolean(status && /fail|error|cancel|timeout/i.test(status));
}

function formatPermissionMode(
  approvalPolicy: unknown,
  sandboxMode: unknown
): string | null {
  const parts = [readString(approvalPolicy), readString(sandboxMode)].filter(Boolean);
  return parts.length > 0 ? parts.join(" / ") : null;
}

function formatRateLimitSnapshot(snapshot: RateLimitSnapshot | null | undefined): string | null {
  if (!snapshot) {
    return null;
  }

  const lines = [
    formatRateLimitWindow("5 小时", snapshot.primary),
    formatRateLimitWindow("1 周", snapshot.secondary)
  ].filter(Boolean);
  return lines.length > 0 ? lines.join("\n") : null;
}

function formatRateLimitWindow(label: string, window: RateLimitWindow | null | undefined): string | null {
  if (!window) {
    return null;
  }

  const remainingPercent =
    typeof window.remainingPercent === "number"
      ? window.remainingPercent
      : typeof window.usedPercent === "number"
        ? 100 - window.usedPercent
        : null;
  if (remainingPercent === null) {
    return null;
  }

  const normalizedPercent = Math.max(0, Math.min(100, remainingPercent));
  const reset = typeof window.resetsAt === "number"
    ? new Date(window.resetsAt * 1000).toLocaleString("zh-CN", {
        month: "numeric",
        day: label === "1 周" ? "numeric" : undefined,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      })
    : null;
  return reset
    ? `${label} ${Math.round(normalizedPercent)}%（${reset} 重置）`
    : `${label} ${Math.round(normalizedPercent)}%`;
}

function extractMediaReferences(text: string): string[] {
  return parseQqMediaSegments(text)
    .filter((segment) => segment.type === "media")
    .map((segment) => segment.reference);
}

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { CodexAppServerDriver } from "../../packages/adapters/codex-desktop/src/codex-app-server-driver.js";
import { TurnEventType } from "../../packages/domain/src/message.js";

class FakeAppServerSocket extends EventEmitter {
  readyState = 0;
  readonly sent: unknown[] = [];
  private readonly handlers = new Map<string, (message: Record<string, unknown>) => void>();

  constructor() {
    super();
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit("open");
    });
  }

  send(data: string): void {
    const message = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(message);
    const method = message.method;
    if (typeof method === "string") {
      this.handlers.get(method)?.(message);
    }
  }

  close(): void {
    this.readyState = 3;
    this.emit("close");
  }

  onRequest(method: string, handler: (message: Record<string, unknown>) => void): void {
    this.handlers.set(method, handler);
  }

  respond(id: unknown, result: unknown): void {
    this.emit("message", JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  notify(method: string, params: unknown): void {
    this.emit("message", JSON.stringify({ jsonrpc: "2.0", method, params }));
  }
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

describe("codex app-server driver", () => {
  it("reports a managed app-server spawn failure without crashing the process", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    class FailingSocket extends EventEmitter {
      readyState = 0;
      send(): void {}
      close(): void {}

      constructor() {
        super();
        queueMicrotask(() => {
          this.emit("error", new Error("socket unavailable"));
        });
      }
    }

    const driver = new CodexAppServerDriver({
      codexBinaryPath: "__missing_codex_binary_for_test__",
      connectTimeoutMs: 500,
      requestTimeoutMs: 100,
      createWebSocket: () => new FailingSocket() as never,
      sleep: async () => undefined
    });

    await expect(driver.ensureAppReady()).rejects.toThrow(
      /Codex app-server is not ready/
    );
    errorSpy.mockRestore();
  });

  it("closes the app-server socket on shutdown", async () => {
    const socket = new FakeAppServerSocket();
    socket.onRequest("initialize", (message) => {
      socket.respond(message.id, {
        userAgent: "fake",
        codexHome: "/tmp/codex",
        platformFamily: "unix",
        platformOs: "macos"
      });
    });

    const driver = new CodexAppServerDriver({
      appServerUrl: "ws://127.0.0.1:1",
      createWebSocket: () => socket as never,
      requestTimeoutMs: 1_000,
      sleep: async () => undefined
    });

    await driver.ensureAppReady();
    expect(socket.sent[0]).toMatchObject({
      method: "initialize",
      params: {
        clientInfo: {
          name: "codex-desktop-orchestrator",
          title: "Codex Desktop Orchestrator",
          version: "0.0.1"
        }
      }
    });
    await driver.shutdown();

    expect(socket.readyState).toBe(3);
  });

  it("starts new app-server threads with the configured cwd", async () => {
    const socket = new FakeAppServerSocket();
    const threadStartRequests: unknown[] = [];
    socket.onRequest("initialize", (message) => {
      socket.respond(message.id, {
        userAgent: "fake",
        codexHome: "/tmp/codex",
        platformFamily: "unix",
        platformOs: "macos"
      });
    });
    socket.onRequest("thread/start", (message) => {
      threadStartRequests.push(message);
      socket.respond(message.id, {
        thread: {
          id: "thread-new",
          cwd: "D:/Project/demo"
        }
      });
    });

    const driver = new CodexAppServerDriver({
      appServerUrl: "ws://127.0.0.1:1",
      createWebSocket: () => socket as never,
      defaultCwd: "D:/Project/default",
      requestTimeoutMs: 1_000,
      sleep: async () => undefined
    });

    const binding = await driver.createThread("qqbot:default::qq:c2c:user-1", "", {
      cwd: "D:/Project/demo"
    });

    expect(threadStartRequests).toHaveLength(1);
    expect(threadStartRequests[0]).toMatchObject({
      method: "thread/start",
      params: {
        cwd: "D:/Project/demo"
      }
    });
    expect(binding.codexThreadRef).toMatch(/^codex-app-thread:thread-new:/);
  });

  it("starts a new app-server thread instead of binding an unbound session to the latest thread", async () => {
    const socket = new FakeAppServerSocket();
    const threadList = vi.fn();
    const threadStart = vi.fn((message: Record<string, unknown>) => {
      socket.respond(message.id, {
        thread: {
          id: "thread-new",
          name: "fresh thread",
          cwd: "D:/Project/demo"
        }
      });
    });
    socket.onRequest("initialize", (message) => {
      socket.respond(message.id, {
        userAgent: "fake",
        codexHome: "/tmp/codex",
        platformFamily: "unix",
        platformOs: "macos"
      });
    });
    socket.onRequest("thread/list", (message) => {
      threadList(message);
      socket.respond(message.id, {
        data: [
          {
            id: "thread-latest",
            name: "old latest",
            cwd: "D:/Project/demo"
          }
        ]
      });
    });
    socket.onRequest("thread/start", threadStart);

    const driver = new CodexAppServerDriver({
      appServerUrl: "ws://127.0.0.1:1",
      createWebSocket: () => socket as never,
      requestTimeoutMs: 1_000,
      sleep: async () => undefined
    });

    const binding = await driver.openOrBindSession("qqbot:default::qq:c2c:user-1", null, {
      cwd: "D:/Project/demo"
    });

    expect(threadList).not.toHaveBeenCalled();
    expect(threadStart).toHaveBeenCalledTimes(1);
    expect(binding.codexThreadRef).toContain("thread-new");
  });

  it("routes replies by thread id and turn id instead of the active desktop UI", async () => {
    const socket = new FakeAppServerSocket();
    socket.onRequest("initialize", (message) => {
      socket.respond(message.id, {
        userAgent: "fake",
        codexHome: "/tmp/codex",
        platformFamily: "unix",
        platformOs: "macos"
      });
    });
    socket.onRequest("thread/resume", (message) => {
      socket.respond(message.id, {});
    });
    socket.onRequest("thread/read", (message) => {
      socket.respond(message.id, {
        thread: {
          id: "thread-target",
          turns: []
        }
      });
    });
    socket.onRequest("turn/start", (message) => {
      socket.respond(message.id, {
        turn: {
          id: "turn-target"
        }
      });

      setTimeout(() => {
        socket.notify("item/agentMessage/delta", {
          threadId: "thread-other",
          turnId: "turn-other",
          itemId: "item-other",
          delta: "WRONG_THREAD_REPLY"
        });
        socket.notify("item/agentMessage/delta", {
          threadId: "thread-target",
          turnId: "turn-target",
          itemId: "item-target",
          delta: "RIGHT_REPLY"
        });
        socket.notify("item/completed", {
          threadId: "thread-other",
          turnId: "turn-other",
          item: {
            type: "agentMessage",
            id: "item-other",
            text: "WRONG_THREAD_REPLY",
            phase: "final_answer"
          }
        });
        socket.notify("item/completed", {
          threadId: "thread-target",
          turnId: "turn-target",
          item: {
            type: "agentMessage",
            id: "item-target",
            text: "RIGHT_REPLY",
            phase: "final_answer"
          }
        });
        socket.notify("turn/completed", {
          threadId: "thread-target",
          turn: {
            id: "turn-target",
            status: "completed"
          }
        });
      }, 0);
    });

    const driver = new CodexAppServerDriver({
      appServerUrl: "ws://127.0.0.1:1",
      createWebSocket: () => socket as never,
      replyTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
      sleep: async () => undefined
    });
    const binding = {
      sessionKey: "qqbot:default::qq:c2c:user-1",
      codexThreadRef: "codex-app-thread:thread-target"
    };

    await driver.sendUserMessage(binding, {
      messageId: "msg-1",
      accountKey: "qqbot:default",
      sessionKey: binding.sessionKey,
      peerKey: "qq:c2c:user-1",
      chatType: "c2c",
      senderId: "user-1",
      text: "hello",
      receivedAt: "2026-04-21T14:30:00.000Z"
    });
    const drafts = await driver.collectAssistantReply(binding);

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      sessionKey: binding.sessionKey,
      turnId: "turn-target",
      text: "RIGHT_REPLY"
    });
  });

  it("preserves app-server service errors instead of reporting them as reply timeouts", async () => {
    const socket = new FakeAppServerSocket();
    socket.onRequest("initialize", (message) => {
      socket.respond(message.id, {
        userAgent: "fake",
        codexHome: "/tmp/codex",
        platformFamily: "unix",
        platformOs: "macos"
      });
    });
    socket.onRequest("thread/resume", (message) => {
      socket.respond(message.id, {});
    });
    socket.onRequest("thread/read", (message) => {
      socket.respond(message.id, {
        thread: {
          id: "thread-target",
          turns: []
        }
      });
    });
    socket.onRequest("turn/start", (message) => {
      socket.respond(message.id, {
        turn: {
          id: "turn-target"
        }
      });

      setTimeout(() => {
        socket.notify("turn/completed", {
          threadId: "thread-target",
          turn: {
            id: "turn-target",
            status: "failed",
            error: {
              message: "{\"error\":{\"message\":\"service validation failed\",\"type\":\"service_error\",\"param\":\"input\",\"code\":\"service_error\"}}",
              codexErrorInfo: "other",
              additionalDetails: null
            }
          }
        });
      }, 0);
    });

    const driver = new CodexAppServerDriver({
      appServerUrl: "ws://127.0.0.1:1",
      createWebSocket: () => socket as never,
      replyTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
      sleep: async () => undefined
    });
    const binding = {
      sessionKey: "qqbot:default::qq:c2c:user-1",
      codexThreadRef: "codex-app-thread:thread-target"
    };

    await driver.sendUserMessage(binding, {
      messageId: "msg-1",
      accountKey: "qqbot:default",
      sessionKey: binding.sessionKey,
      peerKey: "qq:c2c:user-1",
      chatType: "c2c",
      senderId: "user-1",
      text: "hello",
      receivedAt: "2026-04-21T14:30:00.000Z"
    });

    await expect(driver.collectAssistantReply(binding)).rejects.toMatchObject({
      reason: "service_error"
    });
  });

  it("preserves app-server context length errors for user-visible recovery", async () => {
    const socket = new FakeAppServerSocket();
    socket.onRequest("initialize", (message) => {
      socket.respond(message.id, {
        userAgent: "fake",
        codexHome: "/tmp/codex",
        platformFamily: "unix",
        platformOs: "macos"
      });
    });
    socket.onRequest("thread/resume", (message) => {
      socket.respond(message.id, {});
    });
    socket.onRequest("thread/read", (message) => {
      socket.respond(message.id, {
        thread: {
          id: "thread-target",
          turns: []
        }
      });
    });
    socket.onRequest("turn/start", (message) => {
      socket.respond(message.id, {
        turn: {
          id: "turn-target"
        }
      });

      setTimeout(() => {
        socket.notify("turn/completed", {
          threadId: "thread-target",
          turn: {
            id: "turn-target",
            status: "failed",
            error: {
              message: "Your input exceeds the context window of this model",
              kind: "context_length_exceeded",
              code: "context_length_exceeded"
            }
          }
        });
      }, 0);
    });

    const driver = new CodexAppServerDriver({
      appServerUrl: "ws://127.0.0.1:1",
      createWebSocket: () => socket as never,
      replyTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
      sleep: async () => undefined
    });
    const binding = {
      sessionKey: "qqbot:default::qq:c2c:user-1",
      codexThreadRef: "codex-app-thread:thread-target"
    };

    await driver.sendUserMessage(binding, {
      messageId: "msg-1",
      accountKey: "qqbot:default",
      sessionKey: binding.sessionKey,
      peerKey: "qq:c2c:user-1",
      chatType: "c2c",
      senderId: "user-1",
      text: "hello",
      receivedAt: "2026-04-21T14:30:00.000Z"
    });

    await expect(driver.collectAssistantReply(binding)).rejects.toMatchObject({
      reason: "context_length_exceeded"
    });
  });

  it("starts native app-server compaction and waits for compacted notification", async () => {
    const socket = new FakeAppServerSocket();
    const compactStart = vi.fn((message: Record<string, unknown>) => {
      socket.respond(message.id, {});
      socket.notify("thread/compacted", {
        threadId: "thread-target",
        turnId: "compact-turn-1"
      });
    });
    socket.onRequest("initialize", (message) => {
      socket.respond(message.id, {
        userAgent: "fake",
        codexHome: "/tmp/codex",
        platformFamily: "unix",
        platformOs: "macos"
      });
    });
    socket.onRequest("thread/resume", (message) => {
      socket.respond(message.id, {});
    });
    socket.onRequest("thread/read", (message) => {
      socket.respond(message.id, {
        thread: {
          id: "thread-target",
          turns: []
        }
      });
    });
    socket.onRequest("thread/compact/start", compactStart);

    const driver = new CodexAppServerDriver({
      appServerUrl: "ws://127.0.0.1:1",
      createWebSocket: () => socket as never,
      requestTimeoutMs: 1_000,
      replyTimeoutMs: 1_000,
      sleep: async () => undefined
    });

    await expect(driver.compactThread({
      sessionKey: "qqbot:default::qq:c2c:user-1",
      codexThreadRef: "codex-app-thread:thread-target"
    })).resolves.toBeUndefined();

    expect(compactStart).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "thread/compact/start",
        params: {
          threadId: "thread-target"
        }
      })
    );
  });

  it("forwards app-server notifications to the desktop app ui in thread order", async () => {
    const socket = new FakeAppServerSocket();
    const forwarded: Array<{ method: string; params: unknown }> = [];
    socket.onRequest("initialize", (message) => {
      socket.respond(message.id, {
        userAgent: "fake",
        codexHome: "/tmp/codex",
        platformFamily: "unix",
        platformOs: "macos"
      });
    });
    socket.onRequest("thread/resume", (message) => {
      socket.respond(message.id, {});
    });
    socket.onRequest("thread/read", (message) => {
      expect(message.params).toMatchObject({ threadId: "thread-target" });
      socket.respond(message.id, {
        thread: {
          id: "thread-target",
          name: "目标线程",
          cwd: "/Volumes/workspaces/codex-desktop-orchestrator",
          updatedAt: Math.floor(Date.now() / 1000)
        }
      });
    });
    socket.onRequest("turn/start", (message) => {
      socket.respond(message.id, {
        turn: {
          id: "turn-target"
        }
      });
      socket.notify("turn/started", {
        threadId: "thread-target",
        turn: {
          id: "turn-target",
          status: "inProgress"
        }
      });
    });

    const driver = new CodexAppServerDriver({
      appServerUrl: "ws://127.0.0.1:1",
      createWebSocket: () => socket as never,
      notificationForwarder: {
        async forwardNotification(method, params) {
          forwarded.push({ method, params });
        }
      },
      requestTimeoutMs: 1_000,
      sleep: async () => undefined
    });
    const binding = {
      sessionKey: "qqbot:default::qq:c2c:user-1",
      codexThreadRef: "codex-app-thread:thread-target"
    };

    await driver.sendUserMessage(binding, {
      messageId: "msg-1",
      accountKey: "qqbot:default",
      sessionKey: binding.sessionKey,
      peerKey: "qq:c2c:user-1",
      chatType: "c2c",
      senderId: "user-1",
      text: "hello",
      receivedAt: "2026-04-21T14:30:00.000Z"
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(forwarded.map((entry) => entry.method)).toEqual([
      "thread/started",
      "turn/started"
    ]);
    expect(forwarded[0]?.params).toMatchObject({
      thread: {
        id: "thread-target",
        name: "目标线程"
      }
    });
  });

  it("interrupts a stale in-progress turn before starting a new message", async () => {
    const socket = new FakeAppServerSocket();
    socket.onRequest("initialize", (message) => {
      socket.respond(message.id, {
        userAgent: "fake",
        codexHome: "/tmp/codex",
        platformFamily: "unix",
        platformOs: "macos"
      });
    });
    socket.onRequest("thread/resume", (message) => {
      socket.respond(message.id, {});
    });
    socket.onRequest("thread/read", (message) => {
      socket.respond(message.id, {
        thread: {
          id: "thread-target",
          turns: [
            {
              id: "turn-stale",
              status: "inProgress",
              startedAt: Math.floor((Date.now() - 60_000) / 1000)
            }
          ]
        }
      });
    });
    socket.onRequest("turn/interrupt", (message) => {
      socket.respond(message.id, {});
    });
    socket.onRequest("turn/start", (message) => {
      socket.respond(message.id, {
        turn: {
          id: "turn-target"
        }
      });
    });

    const driver = new CodexAppServerDriver({
      appServerUrl: "ws://127.0.0.1:1",
      createWebSocket: () => socket as never,
      requestTimeoutMs: 1_000,
      staleTurnInterruptMs: 1,
      sleep: async () => undefined
    });
    const binding = {
      sessionKey: "qqbot:default::qq:c2c:user-1",
      codexThreadRef: "codex-app-thread:thread-target"
    };

    await driver.sendUserMessage(binding, {
      messageId: "msg-1",
      accountKey: "qqbot:default",
      sessionKey: binding.sessionKey,
      peerKey: "qq:c2c:user-1",
      chatType: "c2c",
      senderId: "user-1",
      text: "hello",
      receivedAt: "2026-04-21T14:30:00.000Z"
    });

    const methods = socket.sent
      .map((message) => (message as { method?: string }).method)
      .filter(Boolean);
    expect(methods).toEqual([
      "initialize",
      "thread/resume",
      "thread/read",
      "turn/interrupt",
      "turn/start"
    ]);
  });

  it("cleans pending turns and interrupts app-server when reply collection times out", async () => {
    const socket = new FakeAppServerSocket();
    socket.onRequest("initialize", (message) => {
      socket.respond(message.id, {
        userAgent: "fake",
        codexHome: "/tmp/codex",
        platformFamily: "unix",
        platformOs: "macos"
      });
    });
    socket.onRequest("thread/resume", (message) => {
      socket.respond(message.id, {});
    });
    socket.onRequest("thread/read", (message) => {
      socket.respond(message.id, {
        thread: {
          id: "thread-target",
          turns: []
        }
      });
    });
    socket.onRequest("turn/start", (message) => {
      socket.respond(message.id, {
        turn: {
          id: "turn-target"
        }
      });
    });
    socket.onRequest("turn/interrupt", (message) => {
      socket.respond(message.id, {});
    });

    const driver = new CodexAppServerDriver({
      appServerUrl: "ws://127.0.0.1:1",
      createWebSocket: () => socket as never,
      replyTimeoutMs: 5,
      requestTimeoutMs: 1_000,
      sleep: async () => undefined
    });
    const binding = {
      sessionKey: "qqbot:default::qq:c2c:user-1",
      codexThreadRef: "codex-app-thread:thread-target"
    };

    await driver.sendUserMessage(binding, {
      messageId: "msg-1",
      accountKey: "qqbot:default",
      sessionKey: binding.sessionKey,
      peerKey: "qq:c2c:user-1",
      chatType: "c2c",
      senderId: "user-1",
      text: "hello",
      receivedAt: "2026-04-21T14:30:00.000Z"
    });

    await expect(driver.collectAssistantReply(binding)).rejects.toThrow(
      "Codex app-server reply did not arrive before timeout"
    );
    await expect(driver.collectAssistantReply(binding)).rejects.toThrow(
      "Codex app-server has no pending turn"
    );
    expect(
      socket.sent.some((message) =>
        (message as { method?: string; params?: unknown }).method === "turn/interrupt"
      )
    ).toBe(true);
  });

  it("does not apply a default whole-turn reply timeout", async () => {
    vi.useFakeTimers();
    const socket = new FakeAppServerSocket();
    socket.onRequest("initialize", (message) => {
      socket.respond(message.id, {
        userAgent: "fake",
        codexHome: "/tmp/codex",
        platformFamily: "unix",
        platformOs: "macos"
      });
    });
    socket.onRequest("thread/resume", (message) => {
      socket.respond(message.id, {});
    });
    socket.onRequest("thread/read", (message) => {
      socket.respond(message.id, {
        thread: {
          id: "thread-target",
          turns: []
        }
      });
    });
    socket.onRequest("turn/start", (message) => {
      socket.respond(message.id, {
        turn: {
          id: "turn-target"
        }
      });
    });
    socket.onRequest("turn/interrupt", (message) => {
      socket.respond(message.id, {});
    });

    const driver = new CodexAppServerDriver({
      appServerUrl: "ws://127.0.0.1:1",
      createWebSocket: () => socket as never,
      requestTimeoutMs: 1_000,
      sleep: async () => undefined
    });
    const binding = {
      sessionKey: "qqbot:default::qq:c2c:user-1",
      codexThreadRef: "codex-app-thread:thread-target"
    };

    await driver.sendUserMessage(binding, {
      messageId: "msg-1",
      accountKey: "qqbot:default",
      sessionKey: binding.sessionKey,
      peerKey: "qq:c2c:user-1",
      chatType: "c2c",
      senderId: "user-1",
      text: "hello",
      receivedAt: "2026-04-21T14:30:00.000Z"
    });

    const reply = driver.collectAssistantReply(binding);
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
    expect(
      socket.sent.some((message) =>
        (message as { method?: string }).method === "turn/interrupt"
      )
    ).toBe(false);

    socket.notify("item/agentMessage/delta", {
      threadId: "thread-target",
      turnId: "turn-target",
      itemId: "item-target",
      delta: "still ok"
    });
    socket.notify("item/completed", {
      threadId: "thread-target",
      turnId: "turn-target",
      item: {
        type: "agentMessage",
        id: "item-target",
        text: "still ok",
        phase: "final_answer"
      }
    });
    socket.notify("turn/completed", {
      threadId: "thread-target",
      turn: {
        id: "turn-target",
        status: "completed"
      }
    });

    await expect(reply).resolves.toEqual([
      expect.objectContaining({
        text: "still ok"
      })
    ]);
    vi.useRealTimers();
  });

  it("interrupts the active app-server turn for a session", async () => {
    const socket = new FakeAppServerSocket();
    socket.onRequest("initialize", (message) => {
      socket.respond(message.id, {
        userAgent: "fake",
        codexHome: "/tmp/codex",
        platformFamily: "unix",
        platformOs: "macos"
      });
    });
    socket.onRequest("thread/resume", (message) => {
      socket.respond(message.id, {});
    });
    socket.onRequest("thread/read", (message) => {
      socket.respond(message.id, {
        thread: {
          id: "thread-target",
          turns: []
        }
      });
    });
    socket.onRequest("turn/start", (message) => {
      socket.respond(message.id, {
        turn: {
          id: "turn-target"
        }
      });
    });
    socket.onRequest("turn/interrupt", (message) => {
      socket.respond(message.id, {});
    });

    const driver = new CodexAppServerDriver({
      appServerUrl: "ws://127.0.0.1:1",
      createWebSocket: () => socket as never,
      requestTimeoutMs: 1_000,
      sleep: async () => undefined
    });
    const binding = {
      sessionKey: "qqbot:default::qq:c2c:user-1",
      codexThreadRef: "codex-app-thread:thread-target"
    };

    await driver.sendUserMessage(binding, {
      messageId: "msg-1",
      accountKey: "qqbot:default",
      sessionKey: binding.sessionKey,
      peerKey: "qq:c2c:user-1",
      chatType: "c2c",
      senderId: "user-1",
      text: "hello",
      receivedAt: "2026-04-21T14:30:00.000Z"
    });

    await expect(driver.interruptActiveTurn(binding.sessionKey)).resolves.toBe(true);
    await expect(driver.collectAssistantReply(binding)).rejects.toThrow(
      "Codex app-server turn was cancelled"
    );

    const interrupts = socket.sent.filter((message) =>
      (message as { method?: string }).method === "turn/interrupt"
    );
    expect(interrupts).toHaveLength(1);
  });

  it("emits app-server turn events while collecting assistant reply", async () => {
    const socket = new FakeAppServerSocket();
    socket.onRequest("initialize", (message) => {
      socket.respond(message.id, {
        userAgent: "fake",
        codexHome: "/tmp/codex",
        platformFamily: "unix",
        platformOs: "macos"
      });
    });
    socket.onRequest("thread/resume", (message) => {
      socket.respond(message.id, {});
    });
    socket.onRequest("thread/read", (message) => {
      socket.respond(message.id, {
        thread: {
          id: "thread-target",
          turns: []
        }
      });
    });
    socket.onRequest("turn/start", (message) => {
      socket.respond(message.id, {
        turn: {
          id: "turn-target"
        }
      });
    });

    const driver = new CodexAppServerDriver({
      appServerUrl: "ws://127.0.0.1:1",
      createWebSocket: () => socket as never,
      requestTimeoutMs: 1_000,
      sleep: async () => undefined
    });
    const binding = {
      sessionKey: "qqbot:default::qq:c2c:user-1",
      codexThreadRef: "codex-app-thread:thread-target"
    };

    await driver.sendUserMessage(binding, {
      messageId: "msg-1",
      accountKey: "qqbot:default",
      sessionKey: binding.sessionKey,
      peerKey: "qq:c2c:user-1",
      chatType: "c2c",
      senderId: "user-1",
      text: "hello",
      receivedAt: "2026-04-21T14:30:00.000Z"
    });

    const events: unknown[] = [];
    const finalDraftsPromise = driver.collectAssistantReply(binding, {
      onTurnEvent: async (event) => {
        events.push(event);
      }
    });

    socket.notify("item/agentMessage/delta", {
      threadId: "thread-target",
      turnId: "turn-target",
      itemId: "item-1",
      delta: "hello"
    });
    socket.notify("item/completed", {
      threadId: "thread-target",
      turnId: "turn-target",
      item: {
        id: "item-1",
        type: "agentMessage",
        text: "hello world"
      }
    });
    socket.notify("turn/completed", {
      threadId: "thread-target",
      turn: {
        id: "turn-target",
        status: "completed"
      }
    });

    await expect(finalDraftsPromise).resolves.toMatchObject([
      {
        turnId: "turn-target",
        text: "hello world"
      }
    ]);
    expect(events).toMatchObject([
      {
        turnId: "turn-target",
        eventType: TurnEventType.Delta,
        payload: {
          text: "hello"
        }
      },
      {
        turnId: "turn-target",
        eventType: TurnEventType.Completed,
        isFinal: true,
        payload: {
          fullText: "hello world",
          completionReason: "stable"
        }
      }
    ]);
  });

  it("buffers turn events that arrive before reply collection starts", async () => {
    const socket = new FakeAppServerSocket();
    socket.onRequest("initialize", (message) => {
      socket.respond(message.id, {
        userAgent: "fake",
        codexHome: "/tmp/codex",
        platformFamily: "unix",
        platformOs: "macos"
      });
    });
    socket.onRequest("thread/resume", (message) => {
      socket.respond(message.id, {});
    });
    socket.onRequest("thread/read", (message) => {
      socket.respond(message.id, {
        thread: {
          id: "thread-target",
          turns: []
        }
      });
    });
    socket.onRequest("turn/start", (message) => {
      socket.respond(message.id, {
        turn: {
          id: "turn-target"
        }
      });
    });

    const driver = new CodexAppServerDriver({
      appServerUrl: "ws://127.0.0.1:1",
      createWebSocket: () => socket as never,
      requestTimeoutMs: 1_000,
      sleep: async () => undefined
    });
    const binding = {
      sessionKey: "qqbot:default::qq:c2c:user-1",
      codexThreadRef: "codex-app-thread:thread-target"
    };

    await driver.sendUserMessage(binding, {
      messageId: "msg-1",
      accountKey: "qqbot:default",
      sessionKey: binding.sessionKey,
      peerKey: "qq:c2c:user-1",
      chatType: "c2c",
      senderId: "user-1",
      text: "hello",
      receivedAt: "2026-04-21T14:30:00.000Z"
    });
    socket.notify("item/agentMessage/delta", {
      threadId: "thread-target",
      turnId: "turn-target",
      itemId: "item-1",
      delta: "early"
    });
    socket.notify("item/completed", {
      threadId: "thread-target",
      turnId: "turn-target",
      item: {
        id: "item-1",
        type: "agentMessage",
        text: "early reply"
      }
    });
    socket.notify("turn/completed", {
      threadId: "thread-target",
      turn: {
        id: "turn-target",
        status: "completed"
      }
    });

    const events: unknown[] = [];
    await expect(driver.collectAssistantReply(binding, {
      onTurnEvent: async (event) => {
        events.push(event);
      }
    })).resolves.toMatchObject([
      {
        turnId: "turn-target",
        text: "early reply"
      }
    ]);
    expect(events).toMatchObject([
      {
        eventType: TurnEventType.Delta,
        payload: {
          text: "early"
        }
      },
      {
        eventType: TurnEventType.Completed,
        isFinal: true,
        payload: {
          fullText: "early reply"
        }
      }
    ]);
  });

  it("times out while flushing buffered turn events", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeAppServerSocket();
      socket.onRequest("initialize", (message) => {
        socket.respond(message.id, {
          userAgent: "fake",
          codexHome: "/tmp/codex",
          platformFamily: "unix",
          platformOs: "macos"
        });
      });
      socket.onRequest("thread/resume", (message) => {
        socket.respond(message.id, {});
      });
      socket.onRequest("thread/read", (message) => {
        socket.respond(message.id, {
          thread: {
            id: "thread-target",
            turns: []
          }
        });
      });
      socket.onRequest("turn/start", (message) => {
        socket.respond(message.id, {
          turn: {
            id: "turn-target"
          }
        });
      });
      socket.onRequest("turn/interrupt", (message) => {
        socket.respond(message.id, {});
      });

      const driver = new CodexAppServerDriver({
        appServerUrl: "ws://127.0.0.1:1",
        createWebSocket: () => socket as never,
        requestTimeoutMs: 1_000,
        replyTimeoutMs: 50,
        sleep: async () => undefined
      });
      const binding = {
        sessionKey: "qqbot:default::qq:c2c:user-1",
        codexThreadRef: "codex-app-thread:thread-target"
      };

      await driver.sendUserMessage(binding, {
        messageId: "msg-1",
        accountKey: "qqbot:default",
        sessionKey: binding.sessionKey,
        peerKey: "qq:c2c:user-1",
        chatType: "c2c",
        senderId: "user-1",
        text: "hello",
        receivedAt: "2026-04-21T14:30:00.000Z"
      });
      socket.notify("item/completed", {
        threadId: "thread-target",
        turnId: "turn-target",
        item: {
          id: "item-1",
          type: "agentMessage",
          text: "early reply"
        }
      });
      socket.notify("turn/completed", {
        threadId: "thread-target",
        turn: {
          id: "turn-target",
          status: "completed"
        }
      });

      const finalDraftsPromise = driver.collectAssistantReply(binding, {
        onTurnEvent: async () => new Promise<void>(() => {})
      });
      const finalDraftsRejection = finalDraftsPromise.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(50);

      const error = await finalDraftsRejection;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        "Codex app-server reply did not arrive before timeout"
      );
      expect(socket.sent).toContainEqual(
        expect.objectContaining({
          method: "turn/interrupt",
          params: {
            threadId: "thread-target",
            turnId: "turn-target"
          }
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for a completed turn event callback before resolving the final draft", async () => {
    const socket = new FakeAppServerSocket();
    socket.onRequest("initialize", (message) => {
      socket.respond(message.id, {
        userAgent: "fake",
        codexHome: "/tmp/codex",
        platformFamily: "unix",
        platformOs: "macos"
      });
    });
    socket.onRequest("thread/resume", (message) => {
      socket.respond(message.id, {});
    });
    socket.onRequest("thread/read", (message) => {
      socket.respond(message.id, {
        thread: {
          id: "thread-target",
          turns: []
        }
      });
    });
    socket.onRequest("turn/start", (message) => {
      socket.respond(message.id, {
        turn: {
          id: "turn-target"
        }
      });
    });

    const driver = new CodexAppServerDriver({
      appServerUrl: "ws://127.0.0.1:1",
      createWebSocket: () => socket as never,
      requestTimeoutMs: 1_000,
      sleep: async () => undefined
    });
    const binding = {
      sessionKey: "qqbot:default::qq:c2c:user-1",
      codexThreadRef: "codex-app-thread:thread-target"
    };
    const completedEventCanFinish = createDeferred<void>();

    await driver.sendUserMessage(binding, {
      messageId: "msg-1",
      accountKey: "qqbot:default",
      sessionKey: binding.sessionKey,
      peerKey: "qq:c2c:user-1",
      chatType: "c2c",
      senderId: "user-1",
      text: "hello",
      receivedAt: "2026-04-21T14:30:00.000Z"
    });

    let resolved = false;
    const finalDraftsPromise = driver.collectAssistantReply(binding, {
      onTurnEvent: async (event) => {
        if (event.eventType === TurnEventType.Completed) {
          await completedEventCanFinish.promise;
        }
      }
    }).then((drafts) => {
      resolved = true;
      return drafts;
    });

    socket.notify("item/completed", {
      threadId: "thread-target",
      turnId: "turn-target",
      item: {
        id: "item-1",
        type: "agentMessage",
        text: "hello world"
      }
    });
    socket.notify("turn/completed", {
      threadId: "thread-target",
      turn: {
        id: "turn-target",
        status: "completed"
      }
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    completedEventCanFinish.resolve();
    await expect(finalDraftsPromise).resolves.toMatchObject([
      {
        turnId: "turn-target",
        text: "hello world"
      }
    ]);
    expect(resolved).toBe(true);
  });

  it("emits normalized tool events for non-agent app-server items", async () => {
    const socket = new FakeAppServerSocket();
    socket.onRequest("initialize", (message) => {
      socket.respond(message.id, {
        userAgent: "fake",
        codexHome: "/tmp/codex",
        platformFamily: "unix",
        platformOs: "macos"
      });
    });
    socket.onRequest("thread/resume", (message) => {
      socket.respond(message.id, {});
    });
    socket.onRequest("thread/read", (message) => {
      socket.respond(message.id, {
        thread: {
          id: "thread-target",
          turns: []
        }
      });
    });
    socket.onRequest("turn/start", (message) => {
      socket.respond(message.id, {
        turn: {
          id: "turn-target"
        }
      });
    });

    const driver = new CodexAppServerDriver({
      appServerUrl: "ws://127.0.0.1:1",
      createWebSocket: () => socket as never,
      requestTimeoutMs: 1_000,
      sleep: async () => undefined
    });
    const binding = {
      sessionKey: "qqbot:default::qq:c2c:user-1",
      codexThreadRef: "codex-app-thread:thread-target"
    };

    await driver.sendUserMessage(binding, {
      messageId: "msg-1",
      accountKey: "qqbot:default",
      sessionKey: binding.sessionKey,
      peerKey: "qq:c2c:user-1",
      chatType: "c2c",
      senderId: "user-1",
      text: "run checks",
      receivedAt: "2026-04-21T14:30:00.000Z"
    });

    const events: unknown[] = [];
    const finalDraftsPromise = driver.collectAssistantReply(binding, {
      onTurnEvent: async (event) => {
        events.push(event);
      }
    });

    socket.notify("item/started", {
      threadId: "thread-target",
      turnId: "turn-target",
      item: {
        id: "tool-1",
        type: "toolCall",
        title: "pnpm run check"
      }
    });
    socket.notify("item/delta", {
      threadId: "thread-target",
      turnId: "turn-target",
      itemId: "tool-1",
      delta: "checking..."
    });
    socket.notify("item/completed", {
      threadId: "thread-target",
      turnId: "turn-target",
      item: {
        id: "tool-1",
        type: "toolCall",
        title: "pnpm run check",
        text: "ok"
      }
    });
    socket.notify("item/completed", {
      threadId: "thread-target",
      turnId: "turn-target",
      item: {
        id: "item-1",
        type: "agentMessage",
        text: "checks passed"
      }
    });
    socket.notify("turn/completed", {
      threadId: "thread-target",
      turn: {
        id: "turn-target",
        status: "completed"
      }
    });

    await expect(finalDraftsPromise).resolves.toMatchObject([
      {
        turnId: "turn-target",
        text: "checks passed"
      }
    ]);
    expect(events).toMatchObject([
      {
        eventType: TurnEventType.Status,
        payload: {
          toolName: "pnpm run check",
          toolStatus: "started"
        }
      },
      {
        eventType: TurnEventType.Status,
        payload: {
          toolName: "pnpm run check",
          toolStatus: "output",
          summary: "checking..."
        }
      },
      {
        eventType: TurnEventType.Status,
        payload: {
          toolName: "pnpm run check",
          toolStatus: "completed",
          summary: "ok"
        }
      },
      {
        eventType: TurnEventType.Completed,
        isFinal: true,
        payload: {
          fullText: "checks passed"
        }
      }
    ]);
  });

  it("interrupts a turn when an active tool is silent past the configured timeout", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeAppServerSocket();
      socket.onRequest("initialize", (message) => {
        socket.respond(message.id, {
          userAgent: "fake",
          codexHome: "/tmp/codex",
          platformFamily: "unix",
          platformOs: "macos"
        });
      });
      socket.onRequest("thread/resume", (message) => {
        socket.respond(message.id, {});
      });
      socket.onRequest("thread/read", (message) => {
        socket.respond(message.id, {
          thread: {
            id: "thread-target",
            turns: []
          }
        });
      });
      socket.onRequest("turn/start", (message) => {
        socket.respond(message.id, {
          turn: {
            id: "turn-target"
          }
        });
      });
      socket.onRequest("turn/interrupt", (message) => {
        socket.respond(message.id, {});
      });

      const driver = new CodexAppServerDriver({
        appServerUrl: "ws://127.0.0.1:1",
        createWebSocket: () => socket as never,
        requestTimeoutMs: 1_000,
        replyTimeoutMs: 10_000,
        toolSilenceTimeoutMs: 50,
        sleep: async () => undefined
      });
      const binding = {
        sessionKey: "qqbot:default::qq:c2c:user-1",
        codexThreadRef: "codex-app-thread:thread-target"
      };

      await driver.sendUserMessage(binding, {
        messageId: "msg-1",
        accountKey: "qqbot:default",
        sessionKey: binding.sessionKey,
        peerKey: "qq:c2c:user-1",
        chatType: "c2c",
        senderId: "user-1",
        text: "run checks",
        receivedAt: "2026-04-21T14:30:00.000Z"
      });

      const events: unknown[] = [];
      const finalDraftsPromise = driver.collectAssistantReply(binding, {
        onTurnEvent: async (event) => {
          events.push(event);
        }
      });
      const finalDraftsRejection = finalDraftsPromise.catch((error: unknown) => error);

      socket.notify("item/started", {
        threadId: "thread-target",
        turnId: "turn-target",
        item: {
          id: "tool-1",
          type: "toolCall",
          title: "pnpm run check"
        }
      });
      await vi.advanceTimersByTimeAsync(50);

      const error = await finalDraftsRejection;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/tool silence timeout/);
      expect(socket.sent).toContainEqual(
        expect.objectContaining({
          method: "turn/interrupt",
          params: {
            threadId: "thread-target",
            turnId: "turn-target"
          }
        })
      );
      expect(socket.sent.filter((message) =>
        (message as { method?: string }).method === "turn/interrupt"
      )).toHaveLength(1);
      expect(events).toContainEqual(
        expect.objectContaining({
          eventType: TurnEventType.Completed,
          isFinal: true,
          payload: expect.objectContaining({
            status: "tool silence timeout: pnpm run check",
            toolName: "pnpm run check",
            toolStatus: "silence-timeout"
          })
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads status from the bound app-server thread instead of the latest thread", async () => {
    const socket = new FakeAppServerSocket();
    socket.onRequest("initialize", (message) => {
      socket.respond(message.id, {
        userAgent: "fake",
        codexHome: "/tmp/codex",
        platformFamily: "unix",
        platformOs: "macos"
      });
    });
    socket.onRequest("config/read", (message) => {
      socket.respond(message.id, {
        config: {
          model: "gpt-5.4",
          model_reasoning_effort: "high",
          approval_policy: "on-request",
          sandbox_mode: "workspace-write"
        }
      });
    });
    socket.onRequest("thread/read", (message) => {
      expect(message.params).toMatchObject({ threadId: "thread-bound" });
      socket.respond(message.id, {
        thread: {
          id: "thread-bound",
          name: "绑定线程",
          cwd: "/Volumes/workspaces/codex-desktop-orchestrator",
          updatedAt: Math.floor(Date.now() / 1000),
          gitInfo: {
            branch: "codex/weixin-multi-channel"
          }
        }
      });
    });
    socket.onRequest("account/rateLimits/read", (message) => {
      socket.respond(message.id, {
        rateLimitsByLimitId: {
          codex: {
            primary: {
              usedPercent: 35,
              windowDurationMins: 300,
              resetsAt: 1776840688
            },
            secondary: {
              usedPercent: 5,
              windowDurationMins: 10080,
              resetsAt: 1777427488
            }
          }
        }
      });
    });
    socket.onRequest("thread/list", () => {
      throw new Error("status should not use latest thread when a bound app-server ref is available");
    });

    const driver = new CodexAppServerDriver({
      appServerUrl: "ws://127.0.0.1:1",
      createWebSocket: () => socket as never,
      requestTimeoutMs: 1_000,
      sleep: async () => undefined
    });

    const state = await driver.getControlState({
      sessionKey: "qqbot:default::qq:c2c:user-1",
      codexThreadRef: "codex-app-thread:thread-bound:stale-title"
    });

    expect(state).toMatchObject({
      threadTitle: "绑定线程",
      threadProjectName: "codex-desktop-orchestrator",
      model: "gpt-5.4",
      reasoningEffort: "high",
      workspace: "codex-desktop-orchestrator",
      branch: "codex/weixin-multi-channel",
      permissionMode: "on-request / workspace-write"
    });
    expect(state.threadRef).toMatch(/^codex-app-thread:thread-bound:/);
    expect(state.quotaSummary).toContain("5 小时 65%");
    expect(state.quotaSummary).toContain("1 周 95%");
  });

  it("suppresses noisy backend websocket reset logs from managed app-server stderr", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const driver = new CodexAppServerDriver();
    const logStderr = (driver as unknown as { logCodexAppServerStderr: (text: string) => void })
      .logCodexAppServerStderr.bind(driver);

    logStderr(
      "\u001B[2m2026-04-22T01:59:41Z\u001B[0m \u001B[31mERROR\u001B[0m " +
      "codex_api::endpoint::responses_websocket: failed to connect to websocket: " +
      "IO error: Connection reset by peer (os error 54), " +
      "url: wss://chatgpt.com/backend-api/codex/responses"
    );

    expect(warnSpy).not.toHaveBeenCalled();

    logStderr("unexpected app-server stderr");
    expect(warnSpy).toHaveBeenCalledWith(
      "[codex-desktop-orchestrator] codex app-server stderr",
      { text: "unexpected app-server stderr" }
    );

    warnSpy.mockRestore();
  });
});

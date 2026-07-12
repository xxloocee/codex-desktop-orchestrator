import { describe, expect, it, vi } from "vitest";
import { BridgeSessionStatus } from "../../packages/domain/src/session.js";
import type { InboundMessage } from "../../packages/domain/src/message.js";
import type {
  SessionStorePort,
  TranscriptStorePort
} from "../../packages/ports/src/store.js";
import { CommandExecutionPipeline } from "../../apps/bridge-daemon/src/command-execution-pipeline.js";

function createPrivateMessage(text: string): InboundMessage {
  return {
    messageId: "msg-1",
    accountKey: "qqbot:default",
    sessionKey: "qqbot:default::qq:c2c:OPENID123",
    peerKey: "qq:c2c:OPENID123",
    chatType: "c2c",
    senderId: "OPENID123",
    text,
    receivedAt: "2026-04-09T16:00:00.000Z"
  };
}

function createGroupMessage(text: string): InboundMessage {
  return {
    ...createPrivateMessage(text),
    chatType: "group",
    sessionKey: "qqbot:default::qq:group:GROUPID"
  };
}

function createSessionStore(): SessionStorePort {
  return {
    getSession: vi.fn().mockResolvedValue({
      sessionKey: "qqbot:default::qq:c2c:OPENID123",
      accountKey: "qqbot:default",
      peerKey: "qq:c2c:OPENID123",
      chatType: "c2c",
      peerId: "OPENID123",
      codexThreadRef: null,
      lastCodexTurnId: null,
      skillContextKey: null,
      conversationProvider: null,
      status: BridgeSessionStatus.Active,
      lastInboundAt: null,
      lastOutboundAt: null,
      lastError: null
    }),
    createSession: vi.fn().mockResolvedValue(undefined),
    updateSessionStatus: vi.fn().mockResolvedValue(undefined),
    updateBinding: vi.fn().mockResolvedValue(undefined),
    updateLastCodexTurnId: vi.fn().mockResolvedValue(undefined),
    updateSkillContextKey: vi.fn().mockResolvedValue(undefined),
    updateConversationProvider: vi.fn().mockResolvedValue(undefined),
    withSessionLock: vi.fn(async (_sessionKey, work) => work())
  };
}

function createTranscriptStore(): TranscriptStorePort {
  return {
    recordInbound: vi.fn().mockResolvedValue(undefined),
    recordOutbound: vi.fn().mockResolvedValue(undefined),
    hasInbound: vi.fn().mockResolvedValue(false),
    listRecentConversation: vi.fn().mockResolvedValue([])
  };
}

function createPipeline(
  overrides: {
    sessionStore?: SessionStorePort;
    transcriptStore?: TranscriptStorePort;
  } = {}
) {
  const sessionStore = overrides.sessionStore ?? createSessionStore();
  const transcriptStore = overrides.transcriptStore ?? createTranscriptStore();
  const handleImmediateCommand = vi.fn().mockResolvedValue(undefined);
  const handleUnknownCommand = vi.fn().mockResolvedValue(undefined);
  const handleLockedCommand = vi.fn().mockResolvedValue(undefined);
  const pipeline = new CommandExecutionPipeline({
    sessionStore,
    transcriptStore,
    handleImmediateCommand,
    handleUnknownCommand,
    handleLockedCommand
  });

  return {
    pipeline,
    sessionStore,
    transcriptStore,
    handleImmediateCommand,
    handleUnknownCommand,
    handleLockedCommand
  };
}

describe("command execution pipeline", () => {
  it("ignores non-private chats and non-commands", async () => {
    const { pipeline, transcriptStore } = createPipeline();

    await expect(pipeline.handleIfCommand(createGroupMessage("/help"))).resolves.toBe(false);
    await expect(pipeline.handleIfCommand(createPrivateMessage("hello"))).resolves.toBe(false);

    expect(transcriptStore.recordInbound).not.toHaveBeenCalled();
  });

  it("records and dispatches immediate commands outside the session lock", async () => {
    const { pipeline, sessionStore, transcriptStore, handleImmediateCommand } = createPipeline();
    const message = createPrivateMessage("/cancel task-1");

    await expect(pipeline.handleIfCommand(message)).resolves.toBe(true);

    expect(sessionStore.withSessionLock).not.toHaveBeenCalled();
    expect(transcriptStore.recordInbound).toHaveBeenCalledWith(message);
    expect(handleImmediateCommand).toHaveBeenCalledWith(
      message,
      { kind: "cancel", taskId: "task-1" }
    );
  });

  it("skips already recorded immediate commands", async () => {
    const transcriptStore = createTranscriptStore();
    vi.mocked(transcriptStore.hasInbound).mockResolvedValue(true);
    const { pipeline, handleImmediateCommand } = createPipeline({ transcriptStore });

    await expect(pipeline.handleIfCommand(createPrivateMessage("/tasks"))).resolves.toBe(true);

    expect(transcriptStore.recordInbound).not.toHaveBeenCalled();
    expect(handleImmediateCommand).not.toHaveBeenCalled();
  });

  it("creates missing sessions and dispatches locked commands inside the session lock", async () => {
    const sessionStore = createSessionStore();
    vi.mocked(sessionStore.getSession).mockResolvedValue(null);
    const { pipeline, transcriptStore, handleLockedCommand } = createPipeline({ sessionStore });
    const message = createPrivateMessage("/threads");

    await expect(pipeline.handleIfCommand(message)).resolves.toBe(true);

    expect(sessionStore.withSessionLock).toHaveBeenCalledWith(message.sessionKey, expect.any(Function));
    expect(sessionStore.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: message.sessionKey,
        status: BridgeSessionStatus.Active,
        lastInboundAt: message.receivedAt
      })
    );
    expect(transcriptStore.recordInbound).toHaveBeenCalledWith(message);
    expect(handleLockedCommand).toHaveBeenCalledWith(message, { kind: "threads" });
  });

  it("dispatches unknown slash commands after session initialization", async () => {
    const sessionStore = createSessionStore();
    vi.mocked(sessionStore.getSession).mockResolvedValue(null);
    const { pipeline, handleUnknownCommand } = createPipeline({ sessionStore });
    const message = createPrivateMessage("/missing");

    await expect(pipeline.handleIfCommand(message)).resolves.toBe(true);

    expect(handleUnknownCommand).toHaveBeenCalledWith(
      message,
      { kind: "unknown", text: "/missing" },
      expect.objectContaining({
        sessionKey: message.sessionKey,
        status: BridgeSessionStatus.Active
      })
    );
  });

  it("rechecks duplicate messages inside the session lock", async () => {
    const transcriptStore = createTranscriptStore();
    vi.mocked(transcriptStore.hasInbound)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const { pipeline, handleLockedCommand } = createPipeline({ transcriptStore });

    await expect(pipeline.handleIfCommand(createPrivateMessage("/threads"))).resolves.toBe(true);

    expect(transcriptStore.recordInbound).not.toHaveBeenCalled();
    expect(handleLockedCommand).not.toHaveBeenCalled();
  });
});

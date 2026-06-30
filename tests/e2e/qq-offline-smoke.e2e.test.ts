import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrap } from "../../apps/bridge-daemon/src/bootstrap.js";
import { createIngressMessageHandler } from "../../apps/bridge-daemon/src/main.js";
import { ThreadCommandHandler } from "../../apps/bridge-daemon/src/thread-command-handler.js";
import { BridgeSessionStatus } from "../../packages/domain/src/session.js";
import type { InboundMessage, OutboundDraft } from "../../packages/domain/src/message.js";
import type { DriverBinding } from "../../packages/domain/src/driver.js";

const ORIGINAL_ENV = { ...process.env };

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

function qqMessage(text: string, overrides: Partial<InboundMessage> = {}): InboundMessage {
  const senderId = overrides.senderId ?? "OPENID_ALLOWED";
  const messageId = overrides.messageId ?? `offline-${Math.random().toString(36).slice(2)}`;
  return {
    messageId,
    accountKey: "qqbot:default",
    sessionKey: `qqbot:default::qq:c2c:${senderId}`,
    peerKey: `qq:c2c:${senderId}`,
    chatType: "c2c",
    senderId,
    text,
    receivedAt: "2026-06-26T10:00:00.000Z",
    ...overrides
  };
}

describe("qq bot offline smoke", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    restoreEnv();
  });

  it("runs the local QQ ingress path without QQ network or a real Codex process", async () => {
    const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), "qq-codex-offline-"));
    const databasePath = path.join(runtimeHome, "offline.sqlite");
    process.env.QQ_CODEX_CONFIG_PATH = path.join(runtimeHome, "missing-config.json");
    process.env.QQ_CODEX_RUNTIME_HOME = runtimeHome;
    process.env.QQ_CODEX_DATABASE_PATH = databasePath;
    process.env.QQBOT_APP_ID = "offline-app";
    process.env.QQBOT_CLIENT_SECRET = "offline-secret";
    process.env.QQ_CODEX_ALLOWED_C2C_SENDERS = "OPENID_ALLOWED";
    process.env.QQ_CODEX_PROJECT_ALIASES_JSON = JSON.stringify({
      bridge: {
        cwd: "D:/Project/github/codex-desktop-orchestrator",
        label: "Codex Desktop Orchestrator"
      }
    });

    const app = bootstrap();
    try {
      const delivered: OutboundDraft[] = [];
      vi.spyOn(app.adapters.qq.egress, "deliver").mockImplementation(async (draft) => {
        delivered.push(draft);
        return {
          jobId: `offline-job-${delivered.length}`,
          sessionKey: draft.sessionKey,
          providerMessageId: `offline-provider-${delivered.length}`,
          deliveredAt: "2026-06-26T10:00:01.000Z"
        };
      });

      const createdThreads: Array<{ sessionKey: string; seedPrompt: string; cwd: string | null | undefined }> = [];
      vi.spyOn(app.adapters.codexDesktop, "ensureAppReady").mockResolvedValue(undefined);
      vi.spyOn(app.adapters.codexDesktop, "openOrBindSession").mockImplementation(async (sessionKey, binding) => ({
        sessionKey,
        codexThreadRef: binding?.codexThreadRef ?? "codex-app-thread:offline-thread:offline"
      }));
      vi.spyOn(app.adapters.codexDesktop, "sendUserMessage").mockResolvedValue(undefined);
      vi.spyOn(app.adapters.codexDesktop, "collectAssistantReply").mockImplementation(async (binding) => [{
        draftId: "offline-draft-1",
        turnId: "offline-turn-1",
        sessionKey: binding.sessionKey,
        text: "offline codex reply",
        createdAt: "2026-06-26T10:00:01.000Z"
      }]);
      vi.spyOn(app.adapters.codexDesktop, "listRecentThreads").mockResolvedValue([
        {
          index: 1,
          title: "Offline Thread",
          projectName: "codex-desktop-orchestrator",
          relativeTime: "now",
          isCurrent: true,
          threadRef: "codex-app-thread:offline-thread:offline"
        }
      ]);
      vi.spyOn(app.adapters.codexDesktop, "createThread").mockImplementation(
        async (sessionKey, seedPrompt, options = {}): Promise<DriverBinding> => {
          createdThreads.push({ sessionKey, seedPrompt, cwd: options.cwd });
          return {
            sessionKey,
            codexThreadRef: "codex-app-thread:offline-new:offline"
          };
        }
      );

      const commandHandler = new ThreadCommandHandler({
        sessionStore: app.sessionStore,
        transcriptStore: app.transcriptStore,
        desktopDriver: app.adapters.codexDesktop,
        qqEgress: app.adapters.qq.egress,
        accountKeys: Object.keys(app.orchestrators.byAccountKey),
        projectAliases: app.config.projectAliases
      });
      const rejected: Array<{ reason: string }> = [];
      const ingress = createIngressMessageHandler({
        accessControl: app.config.accessControl,
        onRejected: (_message, decision) => rejected.push({ reason: decision.reason }),
        threadCommandHandler: commandHandler,
        orchestrator: app.orchestrator,
        errorEgress: app.adapters.qq.egress
      });

      await ingress(qqMessage("/status", {
        messageId: "offline-denied-1",
        senderId: "OPENID_DENIED",
        sessionKey: "qqbot:default::qq:c2c:OPENID_DENIED",
        peerKey: "qq:c2c:OPENID_DENIED"
      }));
      expect(rejected).toEqual([{ reason: "c2c_sender_not_allowed" }]);
      expect(delivered).toHaveLength(0);

      await ingress(qqMessage("/aliases", { messageId: "offline-aliases-1" }));
      expect(delivered.at(-1)?.text).toContain("Configured project aliases:");
      expect(delivered.at(-1)?.text).toContain("bridge");

      await ingress(qqMessage("hello from offline smoke", { messageId: "offline-chat-1" }));
      expect(app.adapters.codexDesktop.ensureAppReady).toHaveBeenCalled();
      expect(app.adapters.codexDesktop.sendUserMessage).toHaveBeenCalledWith(
        expect.objectContaining({ codexThreadRef: "codex-app-thread:offline-thread:offline" }),
        expect.objectContaining({ text: expect.stringContaining("hello from offline smoke") })
      );
      expect(delivered.at(-1)?.text).toBe("offline codex reply");

      await ingress(qqMessage("/new bridge inspect offline flow", { messageId: "offline-new-1" }));
      expect(createdThreads).toEqual([
        expect.objectContaining({
          cwd: "D:/Project/github/codex-desktop-orchestrator",
          seedPrompt: expect.stringContaining("inspect offline flow")
        })
      ]);
      expect(delivered.at(-1)?.text).toContain("Created Codex thread for project: Codex Desktop Orchestrator");

      const session = await app.sessionStore.getSession("qqbot:default::qq:c2c:OPENID_ALLOWED");
      expect(session).toEqual(
        expect.objectContaining({
          status: BridgeSessionStatus.Active,
          codexThreadRef: "codex-app-thread:offline-new:offline",
          lastCodexTurnId: "offline-turn-1"
        })
      );
    } finally {
      await app.adapters.codexDesktop.shutdown?.();
      app.db.close();
    }
  });
});

import type { CodexControlState, CodexThreadSummary, DriverBinding } from "../../domain/src/driver.js";
import type { InboundMessage, OutboundDraft, TurnEvent } from "../../domain/src/message.js";

export type ConversationRunOptions = {
  onDraft?: (draft: OutboundDraft) => Promise<void>;
  onTurnEvent?: (event: TurnEvent) => Promise<void>;
  onQueued?: () => Promise<void>;
  onStarted?: () => Promise<void>;
  onThreadBound?: (codexThreadRef: string | null) => Promise<void>;
};

export type OpenSessionOptions = {
  cwd?: string | null;
};

export interface DesktopDriverPort {
  shutdown?(): Promise<void>;
  ensureAppReady(): Promise<void>;
  getControlState(binding?: DriverBinding | null): Promise<CodexControlState>;
  getQuotaSummary(): Promise<string | null>;
  switchModel(model: string): Promise<CodexControlState>;
  openOrBindSession(
    sessionKey: string,
    binding: DriverBinding | null,
    options?: OpenSessionOptions
  ): Promise<DriverBinding>;
  listRecentThreads(limit: number): Promise<CodexThreadSummary[]>;
  switchToThread(sessionKey: string, threadRef: string): Promise<DriverBinding>;
  createThread(
    sessionKey: string,
    seedPrompt: string,
    options?: OpenSessionOptions
  ): Promise<DriverBinding>;
  sendUserMessage(binding: DriverBinding, message: InboundMessage): Promise<void>;
  collectAssistantReply(
    binding: DriverBinding,
    options?: ConversationRunOptions
  ): Promise<OutboundDraft[]>;
  compactThread?(binding: DriverBinding): Promise<void>;
  interruptActiveTurn?(sessionKey: string): Promise<boolean>;
  markSessionBroken(sessionKey: string, reason: string): Promise<void>;
}

export interface ConversationProviderPort {
  runTurn(
    message: InboundMessage,
    options?: ConversationRunOptions
  ): Promise<OutboundDraft[]>;
}

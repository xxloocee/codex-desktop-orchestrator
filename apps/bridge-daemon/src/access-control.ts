import type { InboundMessage } from "../../../packages/domain/src/message.js";

export type BridgeAccessControlConfig = {
  mode: "deny-by-default" | "allow-all";
  allowedAccountKeys: string[];
  allowedC2cSenderIds: string[];
  allowedGroupIds: string[];
  allowedGroupMemberIds: string[];
  requireMentionInGroup: boolean;
  botMentionPatterns: string[];
};

export type AccessDecision = {
  allowed: boolean;
  reason: string;
};

export function authorizeInboundMessage(
  message: InboundMessage,
  config: BridgeAccessControlConfig | null | undefined
): AccessDecision {
  if (!config || config.mode === "allow-all") {
    return { allowed: true, reason: "allow_all" };
  }

  if (
    config.allowedAccountKeys.length > 0
    && !config.allowedAccountKeys.includes(message.accountKey)
  ) {
    return { allowed: false, reason: "account_not_allowed" };
  }

  if (message.chatType === "c2c") {
    return config.allowedC2cSenderIds.includes(message.senderId)
      ? { allowed: true, reason: "c2c_sender_allowed" }
      : { allowed: false, reason: "c2c_sender_not_allowed" };
  }

  const groupId = extractPeerId(message.peerKey);
  const groupAllowed = groupId !== null && config.allowedGroupIds.includes(groupId);
  const memberAllowed =
    config.allowedGroupMemberIds.includes(message.senderId)
    || (groupId !== null && config.allowedGroupMemberIds.includes(`${groupId}:${message.senderId}`));

  if (!groupAllowed && !memberAllowed) {
    return { allowed: false, reason: "group_source_not_allowed" };
  }

  if (config.requireMentionInGroup && !isExplicitGroupCommand(message.text, config.botMentionPatterns)) {
    return { allowed: false, reason: "group_mention_required" };
  }

  return { allowed: true, reason: memberAllowed ? "group_member_allowed" : "group_allowed" };
}

function extractPeerId(peerKey: string): string | null {
  const parts = peerKey.split(":");
  return parts.length >= 3 ? parts.slice(2).join(":") : null;
}

function isExplicitGroupCommand(text: string, botMentionPatterns: string[]): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }

  if (trimmed.startsWith("/")) {
    return true;
  }

  return botMentionPatterns.some((pattern) => pattern.length > 0 && trimmed.includes(pattern));
}

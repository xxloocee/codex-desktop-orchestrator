import { describe, expect, it } from "vitest";
import type { InboundMessage } from "../../packages/domain/src/message.js";
import {
  authorizeInboundMessage,
  canChangePermissionMode,
  type BridgeAccessControlConfig
} from "../../apps/bridge-daemon/src/access-control.js";

const baseConfig: BridgeAccessControlConfig = {
  mode: "deny-by-default",
  allowedAccountKeys: [],
  allowedC2cSenderIds: [],
  permissionAdminSenderIds: [],
  allowedGroupIds: [],
  allowedGroupMemberIds: [],
  requireMentionInGroup: true,
  botMentionPatterns: ["@bot"]
};

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: "msg-access-1",
    accountKey: "qqbot:default",
    sessionKey: "qqbot:default::qq:c2c:OPENID123",
    peerKey: "qq:c2c:OPENID123",
    chatType: "c2c",
    senderId: "OPENID123",
    text: "hello",
    receivedAt: "2026-04-09T12:00:00.000Z",
    ...overrides
  };
}

describe("access control", () => {
  it("allows all messages when access control is disabled for migration", () => {
    expect(authorizeInboundMessage(message(), { ...baseConfig, mode: "allow-all" })).toEqual(
      expect.objectContaining({ allowed: true })
    );
  });

  it("denies private messages unless the sender is allowlisted", () => {
    expect(authorizeInboundMessage(message(), baseConfig)).toEqual(
      expect.objectContaining({ allowed: false, reason: "c2c_sender_not_allowed" })
    );

    expect(
      authorizeInboundMessage(message(), {
        ...baseConfig,
        allowedC2cSenderIds: ["OPENID123"]
      })
    ).toEqual(expect.objectContaining({ allowed: true, reason: "c2c_sender_allowed" }));
  });

  it("only lets explicitly configured private-chat admins change permission mode", () => {
    const config = {
      ...baseConfig,
      allowedC2cSenderIds: ["OPENID123", "OPENID456"],
      permissionAdminSenderIds: ["OPENID123"]
    };

    expect(canChangePermissionMode(message(), config)).toBe(true);
    expect(canChangePermissionMode(message({ senderId: "OPENID456" }), config)).toBe(false);
    expect(canChangePermissionMode(message({
      chatType: "group",
      senderId: "OPENID123"
    }), config)).toBe(false);
    expect(canChangePermissionMode(message({
      accountKey: "weixin:default",
      senderId: "OPENID123"
    }), config)).toBe(false);
  });

  it("requires group messages to come from an allowlisted group or member and mention the bot", () => {
    const groupMessage = message({
      sessionKey: "qqbot:default::qq:group:GROUP001",
      peerKey: "qq:group:GROUP001",
      chatType: "group",
      senderId: "MEMBER001",
      text: "hello"
    });

    expect(
      authorizeInboundMessage(groupMessage, {
        ...baseConfig,
        allowedGroupIds: ["GROUP001"]
      })
    ).toEqual(expect.objectContaining({ allowed: false, reason: "group_mention_required" }));

    expect(
      authorizeInboundMessage(
        {
          ...groupMessage,
          text: "@bot run status"
        },
        {
          ...baseConfig,
          allowedGroupIds: ["GROUP001"]
        }
      )
    ).toEqual(expect.objectContaining({ allowed: true, reason: "group_allowed" }));

    expect(
      authorizeInboundMessage(
        {
          ...groupMessage,
          text: "/status"
        },
        {
          ...baseConfig,
          allowedGroupMemberIds: ["GROUP001:MEMBER001"]
        }
      )
    ).toEqual(expect.objectContaining({ allowed: true, reason: "group_member_allowed" }));
  });
});

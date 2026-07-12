import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, loadConfigFromEnv } from "../../apps/bridge-daemon/src/config.js";

describe("bridge config", () => {
  it("keeps legacy single qq and weixin envs as default accounts", () => {
    const config = loadConfigFromEnv({
      QQBOT_APP_ID: "qq-app",
      QQBOT_CLIENT_SECRET: "qq-secret",
      WEIXIN_ENABLED: "true",
      WEIXIN_EGRESS_BASE_URL: "http://127.0.0.1:3200",
      WEIXIN_EGRESS_TOKEN: "wx-token"
    });

    expect(config.qqBot.accountId).toBe("default");
    expect(config.qqBots).toEqual([
      expect.objectContaining({
        accountId: "default",
        appId: "qq-app",
        clientSecret: "qq-secret"
      })
    ]);
    expect(config.weixinAccounts).toEqual([
      expect.objectContaining({
        accountId: "default",
        webhookPath: "/webhooks/weixin",
        egressBaseUrl: "http://127.0.0.1:3200"
      })
    ]);
    expect(config.accessControl).toEqual(
      expect.objectContaining({
        mode: "allow-all",
        allowedC2cSenderIds: [],
        requireMentionInGroup: true
      })
    );
  });

  it("infers deny-by-default when access control env lists are configured", () => {
    const config = loadConfigFromEnv({
      QQBOT_APP_ID: "qq-app",
      QQBOT_CLIENT_SECRET: "qq-secret",
      QQ_CODEX_ALLOWED_C2C_SENDERS: "OPENID1"
    });

    expect(config.accessControl).toEqual(
      expect.objectContaining({
        mode: "deny-by-default",
        allowedC2cSenderIds: ["OPENID1"]
      })
    );
  });

  it("loads turn timeout default and env override", () => {
    const defaultConfig = loadConfigFromEnv({
      QQBOT_APP_ID: "qq-app",
      QQBOT_CLIENT_SECRET: "qq-secret"
    });
    const overrideConfig = loadConfigFromEnv({
      QQBOT_APP_ID: "qq-app",
      QQBOT_CLIENT_SECRET: "qq-secret",
      QQ_CODEX_TURN_TIMEOUT_MS: "1234"
    });

    expect(defaultConfig.runtime.turnTimeoutMs).toBe(1800000);
    expect(overrideConfig.runtime.turnTimeoutMs).toBe(1234);
  });

  it("loads multiple qq and weixin accounts from structured env json", () => {
    const config = loadConfigFromEnv({
      QQBOT_APP_ID: "fallback-app",
      QQBOT_CLIENT_SECRET: "fallback-secret",
      QQBOTS_JSON: JSON.stringify([
        {
          accountId: "main",
          appId: "main-app",
          clientSecret: "main-secret",
          markdownSupport: true
        },
        {
          accountId: "shop",
          appId: "shop-app",
          clientSecret: "shop-secret",
          markdownSupport: false
        }
      ]),
      WEIXIN_ACCOUNTS_JSON: JSON.stringify([
        {
          accountId: "main",
          webhookPath: "/webhooks/weixin/main",
          egressBaseUrl: "http://127.0.0.1:3201",
          egressToken: "wx-main-token"
        },
        {
          accountId: "shop",
          webhookPath: "/webhooks/weixin/shop",
          egressBaseUrl: "http://127.0.0.1:3202",
          egressToken: "wx-shop-token"
        }
      ])
    });

    expect(config.qqBots.map((bot) => bot.accountId)).toEqual(["main", "shop"]);
    expect(config.qqBots[1]).toEqual(
      expect.objectContaining({
        appId: "shop-app",
        clientSecret: "shop-secret",
        markdownSupport: false
      })
    );
    expect(config.weixinAccounts.map((account) => account.accountId)).toEqual(["main", "shop"]);
    expect(config.weixinAccounts[1]).toEqual(
      expect.objectContaining({
        webhookPath: "/webhooks/weixin/shop",
        egressBaseUrl: "http://127.0.0.1:3202",
        egressToken: "wx-shop-token"
      })
    );
  });

  it("loads product runtime config json and lets env override runtime port", () => {
    const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), "qq-codex-config-"));
    fs.writeFileSync(
      path.join(runtimeHome, "config.json"),
      JSON.stringify({
        databasePath: "runtime/from-config.sqlite",
        runtime: {
          listenHost: "127.0.0.1",
          listenPort: 3100,
          webhookPath: "/webhooks/qq",
          turnTimeoutMs: 2500
        },
        qqBot: {
          accountId: "main",
          appId: "config-app",
          clientSecret: "config-secret",
          markdownSupport: true
        },
        codexDesktop: {
          appName: "Codex",
          remoteDebuggingPort: 9229
        },
        conversationProvider: "codex-desktop",
        accessControl: {
          mode: "deny-by-default",
          allowedC2cSenderIds: ["OPENID123"],
          allowedGroupIds: ["GROUP001"],
          botMentionPatterns: ["@codex"]
        }
      })
    );

    const config = loadConfig({
      QQ_CODEX_RUNTIME_HOME: runtimeHome,
      QQ_CODEX_LISTEN_PORT: "3999",
      QQ_CODEX_TURN_TIMEOUT_MS: "7777"
    });

    expect(config.databasePath).toBe("runtime/from-config.sqlite");
    expect(config.runtime.listenPort).toBe(3999);
    expect(config.runtime.turnTimeoutMs).toBe(7777);
    expect(config.qqBots).toEqual([
      expect.objectContaining({
        accountId: "main",
        appId: "config-app",
        clientSecret: "config-secret",
        markdownSupport: true
      })
    ]);
    expect(config.accessControl.allowedC2cSenderIds).toEqual(["OPENID123"]);
    expect(config.accessControl.allowedGroupIds).toEqual(["GROUP001"]);
    expect(config.accessControl.botMentionPatterns).toEqual(["@codex"]);
  });

  it("infers deny-by-default for runtime config when access control env lists are configured", () => {
    const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), "qq-codex-config-"));
    fs.writeFileSync(
      path.join(runtimeHome, "config.json"),
      JSON.stringify({
        accessControl: {
          mode: "allow-all",
          allowedC2cSenderIds: []
        }
      })
    );

    const config = loadConfig({
      QQ_CODEX_RUNTIME_HOME: runtimeHome,
      QQBOT_APP_ID: "qq-app",
      QQBOT_CLIENT_SECRET: "qq-secret",
      QQ_CODEX_ALLOWED_C2C_SENDERS: "OPENID1"
    });

    expect(config.accessControl).toEqual(
      expect.objectContaining({
        mode: "deny-by-default",
        allowedC2cSenderIds: ["OPENID1"]
      })
    );
  });

  it("lets non-empty env credentials fill blank runtime config placeholders", () => {
    const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), "qq-codex-config-"));
    fs.writeFileSync(
      path.join(runtimeHome, "config.json"),
      JSON.stringify({
        qqBot: {
          accountId: "default",
          appId: "",
          clientSecret: "",
          markdownSupport: false,
          stt: null
        }
      })
    );

    const config = loadConfig({
      QQ_CODEX_RUNTIME_HOME: runtimeHome,
      QQBOT_APP_ID: "env-app",
      QQBOT_CLIENT_SECRET: "env-secret"
    });

    expect(config.qqBot).toEqual(
      expect.objectContaining({
        accountId: "default",
        appId: "env-app",
        clientSecret: "env-secret"
      })
    );
    expect(config.qqBots[0]).toEqual(config.qqBot);
  });

  it("uses the first configured qqBots entry as the legacy qqBot", () => {
    const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), "qq-codex-config-"));
    fs.writeFileSync(
      path.join(runtimeHome, "config.json"),
      JSON.stringify({
        qqBots: [
          {
            accountId: "main",
            appId: "main-app",
            clientSecret: "main-secret",
            markdownSupport: true,
            stt: null
          }
        ]
      })
    );

    const config = loadConfig({
      QQ_CODEX_RUNTIME_HOME: runtimeHome
    });

    expect(config.qqBot).toEqual(
      expect.objectContaining({
        accountId: "main",
        appId: "main-app",
        clientSecret: "main-secret",
        markdownSupport: true
      })
    );
    expect(config.qqBots).toEqual([config.qqBot]);
  });

  it("loads project aliases from product runtime config json", () => {
    const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), "qq-codex-config-"));
    fs.writeFileSync(
      path.join(runtimeHome, "config.json"),
      JSON.stringify({
        qqBot: {
          appId: "config-app",
          clientSecret: "config-secret"
        },
        projectAliases: {
          "codex-desktop-orchestrator": {
            cwd: "D:/Project/github/codex-desktop-orchestrator",
            label: "Codex Desktop Orchestrator"
          }
        }
      })
    );

    const config = loadConfig({
      QQ_CODEX_RUNTIME_HOME: runtimeHome
    });

    expect(config.projectAliases).toEqual({
      "codex-desktop-orchestrator": {
        cwd: "D:/Project/github/codex-desktop-orchestrator",
        label: "Codex Desktop Orchestrator"
      }
    });
  });

  it("loads project aliases from env json", () => {
    const config = loadConfigFromEnv({
      QQBOT_APP_ID: "qq-app",
      QQBOT_CLIENT_SECRET: "qq-secret",
      QQ_CODEX_PROJECT_ALIASES_JSON: JSON.stringify({
        bridge: {
          path: "D:/Project/github/codex-desktop-orchestrator",
          label: "Bridge"
        }
      })
    });

    expect(config.projectAliases).toEqual({
      bridge: {
        cwd: "D:/Project/github/codex-desktop-orchestrator",
        label: "Bridge"
      }
    });
  });

  it("lets env override access control lists", () => {
    const config = loadConfigFromEnv({
      QQBOT_APP_ID: "qq-app",
      QQBOT_CLIENT_SECRET: "qq-secret",
      CODEX_WORKSPACE_CWD: "D:/Project/demo",
      QQ_CODEX_ACCESS_CONTROL: "allow-all",
      QQ_CODEX_ALLOWED_C2C_SENDERS: "OPENID1,OPENID2",
      QQ_CODEX_ALLOWED_GROUPS: "GROUP1",
      QQ_CODEX_ALLOWED_GROUP_MEMBERS: "GROUP1:MEMBER1",
      QQ_CODEX_BOT_MENTION_PATTERNS: "@codex,@bridge"
    });

    expect(config.accessControl).toEqual(
      expect.objectContaining({
        mode: "allow-all",
        allowedC2cSenderIds: ["OPENID1", "OPENID2"],
        allowedGroupIds: ["GROUP1"],
        allowedGroupMemberIds: ["GROUP1:MEMBER1"],
        botMentionPatterns: ["@codex", "@bridge"]
      })
    );
    expect(config.codexDesktop.cwd).toBe("D:/Project/demo");
  });
});

import fs from "node:fs";
import { z } from "zod";
import type { BridgeAccessControlConfig } from "./access-control.js";
import { runtimePaths } from "./runtime-state.js";

const qqBotConfigSchema = z.object({
  accountId: z.string().min(1),
  appId: z.string().min(1),
  clientSecret: z.string().min(1),
  markdownSupport: z.boolean(),
  stt: z
    .union([
      z.object({
        provider: z.literal("local-whisper-cpp"),
        binaryPath: z.string().min(1),
        modelPath: z.string().min(1),
        language: z.string().min(1).optional()
      }),
      z.object({
        provider: z.literal("openai-compatible"),
        baseUrl: z.string().url(),
        apiKey: z.string().min(1),
        model: z.string().min(1)
      }),
      z.object({
        provider: z.literal("volcengine-flash"),
        endpoint: z.string().url(),
        appId: z.string().min(1),
        accessKey: z.string().min(1),
        resourceId: z.string().min(1),
        model: z.string().min(1)
      })
    ])
    .nullable()
});

const weixinConfigSchema = z.object({
  enabled: z.boolean(),
  accountId: z.string().min(1),
  webhookPath: z.string().startsWith("/"),
  egressBaseUrl: z.string().url().nullable(),
  egressToken: z.string().min(1).nullable()
});

const accessControlConfigSchema = z.object({
  mode: z.enum(["deny-by-default", "allow-all"]),
  allowedAccountKeys: z.array(z.string().min(1)),
  allowedC2cSenderIds: z.array(z.string().min(1)),
  allowedGroupIds: z.array(z.string().min(1)),
  allowedGroupMemberIds: z.array(z.string().min(1)),
  requireMentionInGroup: z.boolean(),
  botMentionPatterns: z.array(z.string().min(1))
});

const projectAliasConfigSchema = z.object({
  cwd: z.string().min(1),
  label: z.string().min(1).optional()
});

export const appConfigSchema = z.object({
  databasePath: z.string().min(1),
  runtime: z.object({
    listenHost: z.string().min(1),
    listenPort: z.number().int().positive(),
    webhookPath: z.string().startsWith("/")
  }),
  qqBot: qqBotConfigSchema,
  qqBots: z.array(qqBotConfigSchema).min(1),
  weixin: weixinConfigSchema,
  weixinAccounts: z.array(weixinConfigSchema),
  codexDesktop: z.object({
    appName: z.string().min(1),
    remoteDebuggingPort: z.number().int().positive(),
    cwd: z.string().min(1).nullable()
  }),
  conversationProvider: z.enum(["codex-desktop", "chatgpt-desktop"]),
  accessControl: accessControlConfigSchema,
  projectAliases: z.record(projectAliasConfigSchema)
});

export type AppConfig = z.infer<typeof appConfigSchema>;

type RuntimeConfigFile = Partial<Omit<AppConfig, "qqBot" | "qqBots" | "weixin" | "weixinAccounts">> & {
  qqBot?: Partial<AppConfig["qqBot"]>;
  qqBots?: Array<Partial<AppConfig["qqBot"]>>;
  weixin?: Partial<AppConfig["weixin"]>;
  weixinAccounts?: Array<Partial<AppConfig["weixin"]>>;
  accessControl?: Partial<BridgeAccessControlConfig>;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const fileConfig = readRuntimeConfigFile(resolveConfigPath(env));
  if (!fileConfig) {
    return loadConfigFromEnv(env);
  }

  const envConfig = loadConfigFromEnvOrDefaults(env);
  const qqBots = hasStructuredQqEnv(env)
    ? envConfig.qqBots
    : (fileConfig.qqBots?.length
        ? fileConfig.qqBots.map((bot, index) => buildQqBotConfig(bot, index === 0 ? envConfig.qqBot : null))
        : [buildQqBotConfig(fileConfig.qqBot, envConfig.qqBot)]);
  return appConfigSchema.parse({
    ...envConfig,
    ...fileConfig,
    databasePath: env.QQ_CODEX_DATABASE_PATH ?? fileConfig.databasePath ?? envConfig.databasePath,
    runtime: {
      ...envConfig.runtime,
      ...fileConfig.runtime,
      listenHost: env.QQ_CODEX_LISTEN_HOST ?? fileConfig.runtime?.listenHost ?? envConfig.runtime.listenHost,
      listenPort: Number(env.QQ_CODEX_LISTEN_PORT ?? fileConfig.runtime?.listenPort ?? envConfig.runtime.listenPort),
      webhookPath: env.QQ_CODEX_WEBHOOK_PATH ?? fileConfig.runtime?.webhookPath ?? envConfig.runtime.webhookPath
    },
    qqBot: qqBots[0],
    qqBots,
    weixin: buildWeixinConfig(fileConfig.weixin, envConfig.weixin),
    weixinAccounts: hasStructuredWeixinEnv(env)
      ? envConfig.weixinAccounts
      : (fileConfig.weixinAccounts?.length
          ? fileConfig.weixinAccounts.map((account, index) => buildWeixinConfig(account, index === 0 ? envConfig.weixin : null))
          : (fileConfig.weixin ? [buildWeixinConfig(fileConfig.weixin, envConfig.weixin)] : envConfig.weixinAccounts)),
    codexDesktop: {
      ...envConfig.codexDesktop,
      ...fileConfig.codexDesktop,
      appName: env.CODEX_APP_NAME ?? fileConfig.codexDesktop?.appName ?? envConfig.codexDesktop.appName,
      remoteDebuggingPort: Number(
        env.CODEX_REMOTE_DEBUGGING_PORT
          ?? fileConfig.codexDesktop?.remoteDebuggingPort
          ?? envConfig.codexDesktop.remoteDebuggingPort
      ),
      cwd: env.CODEX_WORKSPACE_CWD ?? fileConfig.codexDesktop?.cwd ?? envConfig.codexDesktop.cwd
    },
    conversationProvider:
      env.BRIDGE_CONVERSATION_PROVIDER === "chatgpt-desktop" || env.BRIDGE_CONVERSATION_PROVIDER === "codex-desktop"
        ? env.BRIDGE_CONVERSATION_PROVIDER
        : fileConfig.conversationProvider ?? envConfig.conversationProvider,
    accessControl: buildAccessControlConfig(fileConfig.accessControl, envConfig.accessControl, env),
    projectAliases: env.QQ_CODEX_PROJECT_ALIASES_JSON
      ? envConfig.projectAliases
      : fileConfig.projectAliases ?? envConfig.projectAliases
  });
}

export function resolveConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.QQ_CODEX_CONFIG_PATH?.trim() || runtimePaths(env).configPath;
}

export function loadConfigFromEnv(env: NodeJS.ProcessEnv): AppConfig {
  const fallbackQqBot = {
    accountId: env.QQBOT_ACCOUNT_ID ?? "default",
    appId: env.QQBOT_APP_ID,
    clientSecret: env.QQBOT_CLIENT_SECRET,
    markdownSupport: env.QQBOT_MARKDOWN_SUPPORT === "true",
    stt: resolveSttConfig(env)
  };
  const fallbackWeixin = {
    enabled: env.WEIXIN_ENABLED === "true",
    accountId: env.WEIXIN_ACCOUNT_ID ?? "default",
    webhookPath: env.WEIXIN_WEBHOOK_PATH ?? "/webhooks/weixin",
    egressBaseUrl: env.WEIXIN_EGRESS_BASE_URL ?? null,
    egressToken: env.WEIXIN_EGRESS_TOKEN ?? null
  };

  return appConfigSchema.parse({
    databasePath: env.QQ_CODEX_DATABASE_PATH ?? "runtime/codex-desktop-orchestrator.sqlite",
    runtime: {
      listenHost: env.QQ_CODEX_LISTEN_HOST ?? "127.0.0.1",
      listenPort: Number(env.QQ_CODEX_LISTEN_PORT ?? "3100"),
      webhookPath: env.QQ_CODEX_WEBHOOK_PATH ?? "/webhooks/qq"
    },
    qqBot: fallbackQqBot,
    qqBots: resolveQqBotConfigs(env, fallbackQqBot),
    weixin: fallbackWeixin,
    weixinAccounts: resolveWeixinConfigs(env, fallbackWeixin),
    codexDesktop: {
      appName: env.CODEX_APP_NAME ?? "Codex",
      remoteDebuggingPort: Number(env.CODEX_REMOTE_DEBUGGING_PORT ?? "9229"),
      cwd: env.CODEX_WORKSPACE_CWD ?? null
    },
    conversationProvider: (env.BRIDGE_CONVERSATION_PROVIDER === "chatgpt-desktop"
      ? "chatgpt-desktop"
      : "codex-desktop") as "codex-desktop" | "chatgpt-desktop",
    accessControl: loadAccessControlFromEnv(env),
    projectAliases: resolveProjectAliases(env)
  });
}

function readRuntimeConfigFile(configPath: string): RuntimeConfigFile | null {
  if (!fs.existsSync(configPath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(configPath, "utf8")) as RuntimeConfigFile;
}

function loadConfigFromEnvOrDefaults(env: NodeJS.ProcessEnv): AppConfig {
  try {
    return loadConfigFromEnv(env);
  } catch {
    const fallbackQqBot: AppConfig["qqBot"] = {
      accountId: env.QQBOT_ACCOUNT_ID ?? "default",
      appId: env.QQBOT_APP_ID ?? "",
      clientSecret: env.QQBOT_CLIENT_SECRET ?? "",
      markdownSupport: env.QQBOT_MARKDOWN_SUPPORT === "true",
      stt: null
    };
    const fallbackWeixin: AppConfig["weixin"] = {
      enabled: env.WEIXIN_ENABLED === "true",
      accountId: env.WEIXIN_ACCOUNT_ID ?? "default",
      webhookPath: env.WEIXIN_WEBHOOK_PATH ?? "/webhooks/weixin",
      egressBaseUrl: env.WEIXIN_EGRESS_BASE_URL ?? null,
      egressToken: env.WEIXIN_EGRESS_TOKEN ?? null
    };

    return {
      databasePath: env.QQ_CODEX_DATABASE_PATH ?? "runtime/codex-desktop-orchestrator.sqlite",
      runtime: {
        listenHost: env.QQ_CODEX_LISTEN_HOST ?? "127.0.0.1",
        listenPort: Number(env.QQ_CODEX_LISTEN_PORT ?? "3100"),
        webhookPath: env.QQ_CODEX_WEBHOOK_PATH ?? "/webhooks/qq"
      },
      qqBot: fallbackQqBot,
      qqBots: [fallbackQqBot],
      weixin: fallbackWeixin,
      weixinAccounts: fallbackWeixin.enabled ? [fallbackWeixin] : [],
      codexDesktop: {
        appName: env.CODEX_APP_NAME ?? "Codex",
        remoteDebuggingPort: Number(env.CODEX_REMOTE_DEBUGGING_PORT ?? "9229"),
        cwd: env.CODEX_WORKSPACE_CWD ?? null
      },
      conversationProvider: env.BRIDGE_CONVERSATION_PROVIDER === "chatgpt-desktop"
        ? "chatgpt-desktop"
        : "codex-desktop",
      accessControl: loadAccessControlFromEnv(env),
      projectAliases: resolveProjectAliases(env)
    };
  }
}

function resolveProjectAliases(env: NodeJS.ProcessEnv): AppConfig["projectAliases"] {
  const parsed = parseJsonRecord(env.QQ_CODEX_PROJECT_ALIASES_JSON);
  if (!parsed) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(parsed).map(([alias, value]) => {
      const record = asRecord(value);
      return [
        alias,
        {
          cwd: stringValue(record.cwd ?? record.path, ""),
          ...(typeof record.label === "string" && record.label.trim()
            ? { label: record.label.trim() }
            : {})
        }
      ];
    })
  );
}

function loadAccessControlFromEnv(env: NodeJS.ProcessEnv): BridgeAccessControlConfig {
  const hasAccessControlEnv = Boolean(
    env.QQ_CODEX_ALLOWED_ACCOUNT_KEYS
      ?? env.QQ_CODEX_ALLOWED_C2C_SENDERS
      ?? env.QQ_CODEX_ALLOWED_GROUPS
      ?? env.QQ_CODEX_ALLOWED_GROUP_MEMBERS
      ?? env.QQ_CODEX_GROUP_REQUIRE_MENTION
      ?? env.QQ_CODEX_BOT_MENTION_PATTERNS
  );
  return {
    mode: env.QQ_CODEX_ACCESS_CONTROL === "allow-all" || env.QQ_CODEX_ACCESS_CONTROL === "deny-by-default"
      ? env.QQ_CODEX_ACCESS_CONTROL
      : hasAccessControlEnv
        ? "deny-by-default"
        : "allow-all",
    allowedAccountKeys: splitList(env.QQ_CODEX_ALLOWED_ACCOUNT_KEYS),
    allowedC2cSenderIds: splitList(env.QQ_CODEX_ALLOWED_C2C_SENDERS),
    allowedGroupIds: splitList(env.QQ_CODEX_ALLOWED_GROUPS),
    allowedGroupMemberIds: splitList(env.QQ_CODEX_ALLOWED_GROUP_MEMBERS),
    requireMentionInGroup: env.QQ_CODEX_GROUP_REQUIRE_MENTION === "false" ? false : true,
    botMentionPatterns: splitList(env.QQ_CODEX_BOT_MENTION_PATTERNS)
  };
}

function buildAccessControlConfig(
  config: Partial<BridgeAccessControlConfig> | undefined,
  fallback: BridgeAccessControlConfig,
  env: NodeJS.ProcessEnv
): BridgeAccessControlConfig {
  const hasAccessControlEnv = Boolean(
    env.QQ_CODEX_ALLOWED_ACCOUNT_KEYS
      ?? env.QQ_CODEX_ALLOWED_C2C_SENDERS
      ?? env.QQ_CODEX_ALLOWED_GROUPS
      ?? env.QQ_CODEX_ALLOWED_GROUP_MEMBERS
      ?? env.QQ_CODEX_GROUP_REQUIRE_MENTION
      ?? env.QQ_CODEX_BOT_MENTION_PATTERNS
  );
  const merged = {
    mode: config?.mode ?? fallback.mode,
    allowedAccountKeys: config?.allowedAccountKeys ?? fallback.allowedAccountKeys,
    allowedC2cSenderIds: config?.allowedC2cSenderIds ?? fallback.allowedC2cSenderIds,
    allowedGroupIds: config?.allowedGroupIds ?? fallback.allowedGroupIds,
    allowedGroupMemberIds: config?.allowedGroupMemberIds ?? fallback.allowedGroupMemberIds,
    requireMentionInGroup: config?.requireMentionInGroup ?? fallback.requireMentionInGroup,
    botMentionPatterns: config?.botMentionPatterns ?? fallback.botMentionPatterns
  };

  return {
    mode: env.QQ_CODEX_ACCESS_CONTROL === "allow-all" || env.QQ_CODEX_ACCESS_CONTROL === "deny-by-default"
      ? env.QQ_CODEX_ACCESS_CONTROL
      : hasAccessControlEnv
        ? "deny-by-default"
      : merged.mode,
    allowedAccountKeys: env.QQ_CODEX_ALLOWED_ACCOUNT_KEYS
      ? splitList(env.QQ_CODEX_ALLOWED_ACCOUNT_KEYS)
      : merged.allowedAccountKeys,
    allowedC2cSenderIds: env.QQ_CODEX_ALLOWED_C2C_SENDERS
      ? splitList(env.QQ_CODEX_ALLOWED_C2C_SENDERS)
      : merged.allowedC2cSenderIds,
    allowedGroupIds: env.QQ_CODEX_ALLOWED_GROUPS
      ? splitList(env.QQ_CODEX_ALLOWED_GROUPS)
      : merged.allowedGroupIds,
    allowedGroupMemberIds: env.QQ_CODEX_ALLOWED_GROUP_MEMBERS
      ? splitList(env.QQ_CODEX_ALLOWED_GROUP_MEMBERS)
      : merged.allowedGroupMemberIds,
    requireMentionInGroup: env.QQ_CODEX_GROUP_REQUIRE_MENTION
      ? env.QQ_CODEX_GROUP_REQUIRE_MENTION !== "false"
      : merged.requireMentionInGroup,
    botMentionPatterns: env.QQ_CODEX_BOT_MENTION_PATTERNS
      ? splitList(env.QQ_CODEX_BOT_MENTION_PATTERNS)
      : merged.botMentionPatterns
  };
}

function buildQqBotConfig(
  config: Partial<AppConfig["qqBot"]> | undefined,
  fallback: AppConfig["qqBot"] | null
): AppConfig["qqBot"] {
  return {
    accountId: nonEmptyString(config?.accountId) ?? fallback?.accountId ?? "default",
    appId: nonEmptyString(config?.appId) ?? fallback?.appId ?? "",
    clientSecret: nonEmptyString(config?.clientSecret) ?? fallback?.clientSecret ?? "",
    markdownSupport: config?.markdownSupport ?? fallback?.markdownSupport ?? false,
    stt: config?.stt ?? fallback?.stt ?? null
  };
}

function buildWeixinConfig(
  config: Partial<AppConfig["weixin"]> | undefined,
  fallback: AppConfig["weixin"] | null
): AppConfig["weixin"] {
  return {
    enabled: config?.enabled ?? fallback?.enabled ?? false,
    accountId: config?.accountId ?? fallback?.accountId ?? "default",
    webhookPath: config?.webhookPath ?? fallback?.webhookPath ?? "/webhooks/weixin",
    egressBaseUrl: config?.egressBaseUrl ?? fallback?.egressBaseUrl ?? null,
    egressToken: config?.egressToken ?? fallback?.egressToken ?? null
  };
}

function hasStructuredQqEnv(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.QQBOTS_JSON ?? env.QQBOT_ACCOUNTS_JSON ?? env.QQBOT_ACCOUNT_IDS);
}

function hasStructuredWeixinEnv(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.WEIXIN_ACCOUNTS_JSON ?? env.WEIXIN_ACCOUNT_IDS);
}

function resolveQqBotConfigs(
  env: NodeJS.ProcessEnv,
  fallback: {
    accountId: string;
    appId: string | undefined;
    clientSecret: string | undefined;
    markdownSupport: boolean;
    stt: ReturnType<typeof resolveSttConfig>;
  }
) {
  const jsonConfigs = parseJsonArray(env.QQBOTS_JSON ?? env.QQBOT_ACCOUNTS_JSON);
  if (jsonConfigs) {
    return jsonConfigs.map((item, index) => {
      const record = asRecord(item);
      return {
        accountId: stringValue(record.accountId ?? record.id, `bot${index + 1}`),
        appId: stringValue(record.appId ?? record.appID ?? record.qqbotAppId, ""),
        clientSecret: stringValue(record.clientSecret ?? record.secret ?? record.qqbotClientSecret, ""),
        markdownSupport: booleanValue(record.markdownSupport, fallback.markdownSupport),
        stt: fallback.stt
      };
    });
  }

  const accountIds = splitList(env.QQBOT_ACCOUNT_IDS);
  if (accountIds.length > 0) {
    return accountIds.map((accountId, index) => {
      const suffix = envNameSuffix(accountId);
      return {
        accountId,
        appId: env[`QQBOT_${suffix}_APP_ID`] ?? (index === 0 ? fallback.appId : undefined),
        clientSecret: env[`QQBOT_${suffix}_CLIENT_SECRET`] ?? (index === 0 ? fallback.clientSecret : undefined),
        markdownSupport: booleanEnv(env[`QQBOT_${suffix}_MARKDOWN_SUPPORT`], fallback.markdownSupport),
        stt: fallback.stt
      };
    });
  }

  return [fallback];
}

function resolveWeixinConfigs(
  env: NodeJS.ProcessEnv,
  fallback: {
    enabled: boolean;
    accountId: string;
    webhookPath: string;
    egressBaseUrl: string | null;
    egressToken: string | null;
  }
) {
  const jsonConfigs = parseJsonArray(env.WEIXIN_ACCOUNTS_JSON);
  if (jsonConfigs) {
    return jsonConfigs.map((item, index) => {
      const record = asRecord(item);
      const accountId = stringValue(record.accountId ?? record.id, `account${index + 1}`);
      return {
        enabled: booleanValue(record.enabled, true),
        accountId,
        webhookPath: stringValue(record.webhookPath, `/webhooks/weixin/${accountId}`),
        egressBaseUrl: nullableString(record.egressBaseUrl ?? record.baseUrl),
        egressToken: nullableString(record.egressToken ?? record.token)
      };
    });
  }

  const accountIds = splitList(env.WEIXIN_ACCOUNT_IDS);
  if (accountIds.length > 0) {
    return accountIds.map((accountId, index) => {
      const suffix = envNameSuffix(accountId);
      return {
        enabled: booleanEnv(env[`WEIXIN_${suffix}_ENABLED`], true),
        accountId,
        webhookPath: env[`WEIXIN_${suffix}_WEBHOOK_PATH`] ?? `/webhooks/weixin/${accountId}`,
        egressBaseUrl: env[`WEIXIN_${suffix}_EGRESS_BASE_URL`] ?? (index === 0 ? fallback.egressBaseUrl : null),
        egressToken: env[`WEIXIN_${suffix}_EGRESS_TOKEN`] ?? (index === 0 ? fallback.egressToken : null)
      };
    });
  }

  return fallback.enabled ? [fallback] : [];
}

function resolveSttConfig(env: NodeJS.ProcessEnv) {
  if (env.QQBOT_STT_ENABLED === "false") {
    return null;
  }

  if (env.QQBOT_STT_PROVIDER === "local-whisper-cpp") {
    const binaryPath = env.QQBOT_STT_BINARY_PATH;
    const modelPath = env.QQBOT_STT_MODEL_PATH;
    if (!binaryPath || !modelPath) {
      return null;
    }

    return {
      provider: "local-whisper-cpp" as const,
      binaryPath,
      modelPath,
      ...(env.QQBOT_STT_LANGUAGE ? { language: env.QQBOT_STT_LANGUAGE } : {})
    };
  }

  if (env.QQBOT_STT_PROVIDER === "volcengine-flash") {
    const appId = env.QQBOT_STT_APP_ID;
    const accessKey = env.QQBOT_STT_ACCESS_KEY;
    const resourceId = env.QQBOT_STT_RESOURCE_ID;
    if (!appId || !accessKey || !resourceId) {
      return null;
    }

    return {
      provider: "volcengine-flash" as const,
      endpoint:
        env.QQBOT_STT_ENDPOINT ??
        "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash",
      appId,
      accessKey,
      resourceId,
      model: env.QQBOT_STT_MODEL ?? "bigmodel"
    };
  }

  const apiKey = env.QQBOT_STT_API_KEY ?? env.OPENAI_API_KEY;
  if (!apiKey) {
    return null;
  }

  const baseUrl = env.QQBOT_STT_BASE_URL ?? env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  const model = env.QQBOT_STT_MODEL ?? "whisper-1";
  return {
    provider: "openai-compatible" as const,
    baseUrl,
    apiKey,
    model
  };
}

function parseJsonArray(value: string | undefined): unknown[] | null {
  if (!value?.trim()) {
    return null;
  }

  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed : null;
}

function parseJsonRecord(value: string | undefined): Record<string, unknown> | null {
  if (!value?.trim()) {
    return null;
  }

  const parsed = JSON.parse(value) as unknown;
  return asRecord(parsed);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown, fallback: string): string {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function nullableString(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text || null;
}

function nonEmptyString(value: unknown): string | undefined {
  const text = String(value ?? "").trim();
  return text || undefined;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return booleanEnv(value, fallback);
  }
  return fallback;
}

function booleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  return value === "true" || value === "1";
}

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function envNameSuffix(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
}

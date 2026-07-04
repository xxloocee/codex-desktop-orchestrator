import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";
import { discoverCodexInstallations } from "./codex-discovery.js";
import { loadConfig, loadConfigFromEnv, resolveConfigPath } from "./config.js";
import { ensureCodexDesktopForDev, type DevLaunchConfig } from "./dev-launch.js";
import { openReadonlySqliteDatabase } from "../../../packages/store/src/sqlite.js";
import { SqliteRuntimeRecoveryStore } from "../../../packages/store/src/runtime-recovery-repo.js";
import { installBridgeRuntimeSignalHandlers, runBridgeDaemon } from "./main.js";
import {
  clearRuntimeState,
  ensureManagementToken,
  ensureRuntimeHome,
  readRuntimeLogTail,
  readRuntimeStatus,
  runtimePaths
} from "./runtime-state.js";

type CliDeps = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  packageRoot?: string;
  loadEnvFile?: (filePath: string) => void;
  ensureCodexDesktop?: (config: DevLaunchConfig) => Promise<{ launched: boolean }>;
  runBridgeDaemon?: () => Promise<{ channels?: string[]; shutdown?: () => Promise<void> | void } | void>;
  writeStdout?: (line: string) => void;
  writeStderr?: (line: string) => void;
};

const REQUIRED_ENV_MAP: Record<string, string> = {
  "qqBot.appId": "QQBOT_APP_ID",
  "qqBot.clientSecret": "QQBOT_CLIENT_SECRET",
  "codexDesktop.appName": "CODEX_APP_NAME",
  "codexDesktop.remoteDebuggingPort": "CODEX_REMOTE_DEBUGGING_PORT"
};
const CLI_NAME = "codex-desktop-orchestrator";
const LOG_PREFIX = `[${CLI_NAME}]`;

export async function runCli(rawArgs: string[], deps: CliDeps = {}): Promise<number> {
  const args = normalizeArgs(rawArgs);
  const cwd = deps.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
  const packageRoot = deps.packageRoot ?? findPackageRoot(path.dirname(fileURLToPath(import.meta.url)));
  const writeStdout = deps.writeStdout ?? ((line: string) => console.log(line));
  const writeStderr = deps.writeStderr ?? ((line: string) => console.error(line));
  const ensureDesktop = deps.ensureCodexDesktop ?? ensureCodexDesktopForDev;
  const startBridge = deps.runBridgeDaemon ?? runBridgeDaemon;

  if (args[0] === "init") {
    return initEnvTemplate({
      cwd,
      env,
      packageRoot,
      writeStdout,
      writeStderr
    });
  }

  if (args[0] === "help" || args[0] === "-h" || args[0] === "--help") {
    printHelp(writeStdout);
    return 0;
  }

  if (args[0] === "version" || args[0] === "--version" || args[0] === "-v") {
    writeStdout(readPackageVersion(packageRoot));
    return 0;
  }

  const command = args[0] ?? "start";
  const knownCommands = new Set(["start", "status", "doctor", "logs", "stop", "restart"]);
  if (!knownCommands.has(command)) {
    writeStderr(`${LOG_PREFIX} 未知命令：${args.join(" ")}`);
    printHelp(writeStdout);
    return 1;
  }

  loadLocalEnv(cwd, deps.loadEnvFile);

  if (command === "status") {
    writeJsonLine(writeStdout, {
      status: "ok",
      runtime: readRuntimeStatus(runtimePaths(env))
    });
    return 0;
  }

  if (command === "logs") {
    const maxLines = Number(args[1] ?? "200");
    const lines = readRuntimeLogTail(runtimePaths(env), Number.isFinite(maxLines) ? maxLines : 200);
    for (const line of lines) {
      writeStdout(line);
    }
    return 0;
  }

  if (command === "doctor") {
    return runDoctor({ env, writeStdout, writeStderr });
  }

  if (command === "stop") {
    return stopRuntime({ env, writeStdout, writeStderr });
  }

  if (command === "restart") {
    const stopped = await stopRuntime({
      env,
      writeStdout,
      writeStderr,
      allowNotRunning: true,
      waitForExit: true
    });
    if (stopped !== 0) {
      return stopped;
    }
  }

  if (!(await guardSingleRuntimeInstance({ env, writeStderr }))) {
    return 1;
  }

  try {
    const config = loadConfig(env);
    if (shouldSkipDesktopReady(env)) {
      writeStdout(`${LOG_PREFIX} codex desktop readiness check skipped`);
    } else {
      const result = await ensureDesktop({
        appName: config.codexDesktop.appName,
        remoteDebuggingPort: config.codexDesktop.remoteDebuggingPort,
        startupTimeoutMs: Number(env.CODEX_CDP_STARTUP_TIMEOUT_MS ?? "15000"),
        startupPollIntervalMs: Number(env.CODEX_CDP_POLL_INTERVAL_MS ?? "500")
      });

      writeStdout(
        `${LOG_PREFIX} codex desktop ready { launched: ${String(result.launched)}, remoteDebuggingPort: ${config.codexDesktop.remoteDebuggingPort} }`
      );
    }

    const runtime = await startBridge();
    const channels = Array.isArray((runtime as { channels?: string[] } | undefined)?.channels)
      ? (runtime as { channels: string[] }).channels
      : ["qq"];
    if (typeof runtime?.shutdown === "function") {
      installBridgeRuntimeSignalHandlers({
        shutdown: async () => {
          await runtime.shutdown?.();
        }
      });
    }
    writeStdout(`${LOG_PREFIX} channels active: ${channels.join(", ")}`);
    return 0;
  } catch (error) {
    if (error instanceof ZodError) {
      writeStderr(formatConfigError(error, cwd));
      return 1;
    }

    const cause = error instanceof Error ? error.cause : undefined;
    writeStderr(`${LOG_PREFIX} fatal: ${error instanceof Error ? error.message : String(error)}`);
    if (cause !== undefined) {
      writeStderr(`  caused by: ${String(cause)}`);
    }
    if (error instanceof Error && error.stack) {
      writeStderr(`  stack: ${error.stack}`);
    }
    return 1;
  }
}

export async function runCliFromProcess() {
  process.exitCode = await runCli(process.argv.slice(2));
}

function initEnvTemplate(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  packageRoot: string;
  writeStdout: (line: string) => void;
  writeStderr: (line: string) => void;
}) {
  const targetPath = path.join(options.cwd, ".env");
  const configPath = resolveConfigPath(options.env);
  let created = false;

  if (fs.existsSync(targetPath)) {
    options.writeStderr(`${LOG_PREFIX} .env 已存在：${targetPath}`);
    options.writeStderr(`${LOG_PREFIX} 如需重新生成，请先手动备份或删除现有文件。`);
  } else {
    const templatePath = path.join(options.packageRoot, ".env.example");
    const template = fs.readFileSync(templatePath, "utf8");
    fs.writeFileSync(targetPath, template, "utf8");
    options.writeStdout(`${LOG_PREFIX} 已生成配置模板：${targetPath}`);
    created = true;
  }

  if (fs.existsSync(configPath)) {
    options.writeStderr(`${LOG_PREFIX} runtime config 已存在：${configPath}`);
  } else {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(defaultRuntimeConfigTemplate(options.cwd), null, 2)}\n`, "utf8");
    options.writeStdout(`${LOG_PREFIX} 已生成 runtime config：${configPath}`);
    created = true;
  }

  if (created) {
    options.writeStdout(`${LOG_PREFIX} 请先填写 QQ Bot 凭据，再执行 \`${CLI_NAME} start\`。`);
    return 0;
  }

  return 1;
}

async function guardSingleRuntimeInstance(options: {
  env: NodeJS.ProcessEnv;
  writeStderr: (line: string) => void;
}): Promise<boolean> {
  const paths = runtimePaths(options.env);
  const status = readRuntimeStatus(paths);
  if (status.running && status.pid) {
    if (await canReachRuntimeControl(paths, status.state, "/status", "GET")) {
      options.writeStderr(
        `${LOG_PREFIX} already running: pid=${status.pid}, runtimeHome=${paths.home}`
      );
      return false;
    }

    options.writeStderr(
      `${LOG_PREFIX} clearing stale runtime state: pid=${status.pid} did not answer management checks`
    );
    clearRuntimeState(paths, status.pid);
    return true;
  }

  if (status.pid) {
    clearRuntimeState(paths, status.pid);
  }
  return true;
}

function printHelp(writeStdout: (line: string) => void) {
  writeStdout(CLI_NAME);
  writeStdout("");
  writeStdout("用法：");
  writeStdout(`  ${CLI_NAME}                 启动桥接守护进程`);
  writeStdout(`  ${CLI_NAME} start           启动桥接守护进程`);
  writeStdout(`  ${CLI_NAME} status          输出运行状态 JSON`);
  writeStdout(`  ${CLI_NAME} doctor          检查配置和运行目录`);
  writeStdout(`  ${CLI_NAME} logs [行数]     查看最近运行日志`);
  writeStdout(`  ${CLI_NAME} stop            停止已记录的运行进程`);
  writeStdout(`  ${CLI_NAME} restart         停止后重新启动`);
  writeStdout(`  ${CLI_NAME} init            在当前目录生成 .env`);
  writeStdout(`  ${CLI_NAME} version         查看版本`);
  writeStdout(`  ${CLI_NAME} help            查看帮助`);
}

function formatConfigError(error: ZodError, cwd: string) {
  const missingVars = Array.from(
    new Set(
      error.issues
        .map((issue) => REQUIRED_ENV_MAP[issue.path.join(".")])
        .filter((value): value is string => Boolean(value))
    )
  );

  const lines = [`${LOG_PREFIX} 配置不完整，无法启动。`];

  if (missingVars.length > 0) {
    lines.push(`${LOG_PREFIX} 缺少或无效的关键变量：${missingVars.join(", ")}`);
  }

  lines.push(`${LOG_PREFIX} 请在当前目录准备 .env：${path.join(cwd, ".env")}`);
  lines.push(`${LOG_PREFIX} 如果还没有配置文件，可先执行：${CLI_NAME} init`);
  return lines.join("\n");
}

function normalizeArgs(args: string[]) {
  return args.filter((arg) => arg.length > 0 && arg !== "--");
}

function shouldSkipDesktopReady(env: NodeJS.ProcessEnv): boolean {
  if (env.QQ_CODEX_SKIP_DESKTOP_READY === "1" || env.QQ_CODEX_SKIP_DESKTOP_READY === "true") {
    return true;
  }

  return env.CODEX_DESKTOP_TRANSPORT !== "dom" && env.CODEX_APP_SERVER_FORWARD_UI_EVENTS !== "1";
}

function loadLocalEnv(cwd: string, loadEnvFile?: (filePath: string) => void): void {
  const envFilePath = path.join(cwd, ".env");
  if (fs.existsSync(envFilePath)) {
    const loader = loadEnvFile ?? process.loadEnvFile.bind(process);
    loader(envFilePath);
  }
}

function writeJsonLine(writeStdout: (line: string) => void, value: unknown): void {
  writeStdout(JSON.stringify(value));
}

function runDoctor(options: {
  env: NodeJS.ProcessEnv;
  writeStdout: (line: string) => void;
  writeStderr: (line: string) => void;
}): number {
  const paths = runtimePaths(options.env);
  const checks: Array<{ name: string; status: "ok" | "failed"; message: string }> = [];

  try {
    ensureRuntimeHome(paths);
    ensureManagementToken(paths);
    checks.push({ name: "runtimeHome", status: "ok", message: paths.home });
  } catch (error) {
    checks.push({
      name: "runtimeHome",
      status: "failed",
      message: error instanceof Error ? error.message : String(error)
    });
  }

  try {
    const config = loadConfig(options.env);
    const databasePath = path.resolve(config.databasePath);
    if (!fs.existsSync(databasePath)) {
      checks.push({
        name: "recovery",
        status: "ok",
        message: `database not initialized: ${databasePath}`
      });
    } else {
      const db = openReadonlySqliteDatabase(databasePath);
      try {
        const recovery = new SqliteRuntimeRecoveryStore(db).inspect();
        const runtimeStatus = readRuntimeStatus(paths);
        const hasUnhealthyRecoveryState =
          recovery.expiredActiveTurns > 0
          || (
            !runtimeStatus.running
            && (
              recovery.activeTurns > 0
              || recovery.sessionLocks.expired > 0
              || recovery.threadLocks.expired > 0
            )
          );
        checks.push({
          name: "recovery",
          status: hasUnhealthyRecoveryState ? "failed" : "ok",
          message: `activeTurns=${recovery.activeTurns}, expiredActiveTurns=${recovery.expiredActiveTurns}, orphanableActiveTurns=${recovery.orphanableActiveTurns}, sessionLocks=${recovery.sessionLocks.total}/${recovery.sessionLocks.expired} expired, threadLocks=${recovery.threadLocks.total}/${recovery.threadLocks.expired} expired`
        });
      } finally {
        db.close();
      }
    }
    checks.push({
      name: "config",
      status: "ok",
      message: `qqBots=${config.qqBots.length}, listen=${config.runtime.listenHost}:${config.runtime.listenPort}`
    });
  } catch (error) {
    checks.push({
      name: "config",
      status: "failed",
      message: error instanceof Error ? error.message : String(error)
    });
  }

  const codex = discoverCodexInstallations({ env: options.env });
  checks.push({
    name: "codexDesktop",
    status: codex.desktopPath ? "ok" : "failed",
    message: codex.desktopPath
      ? `${codex.desktopPath} (${codex.desktopSource})`
      : "Codex Desktop was not discovered; set CODEX_APP_PATH or CODEX_DESKTOP_PATH"
  });
  checks.push({
    name: "codexBinary",
    status: codex.binaryPath ? "ok" : "failed",
    message: `${codex.binaryPath ?? "not found"} (${codex.binarySource})`
  });

  const failed = checks.some((check) => check.status === "failed");
  writeJsonLine(options.writeStdout, {
    status: failed ? "failed" : "ok",
    runtime: readRuntimeStatus(paths),
    checks
  });
  return failed ? 1 : 0;
}

function defaultRuntimeConfigTemplate(cwd: string) {
  const resolvedCwd = path.resolve(cwd);
  const aliasName = path.basename(resolvedCwd) || "project";
  return {
    version: 1,
    databasePath: "runtime/codex-desktop-orchestrator.sqlite",
    runtime: {
      listenHost: "127.0.0.1",
      listenPort: 3100,
      webhookPath: "/webhooks/qq"
    },
    qqBot: {
      accountId: "default",
      appId: "",
      clientSecret: "",
      markdownSupport: false,
      stt: null
    },
    codexDesktop: {
      appName: "Codex",
      remoteDebuggingPort: 9229,
      cwd: null
    },
    conversationProvider: "codex-desktop",
    accessControl: {
      mode: "allow-all",
      allowedAccountKeys: [],
      allowedC2cSenderIds: [],
      allowedGroupIds: [],
      allowedGroupMemberIds: [],
      requireMentionInGroup: true,
      botMentionPatterns: ["@你的机器人昵称"]
    },
    projectAliases: {
      [aliasName]: {
        cwd: resolvedCwd,
        label: aliasName
      }
    }
  };
}

async function stopRuntime(options: {
  env: NodeJS.ProcessEnv;
  writeStdout: (line: string) => void;
  writeStderr: (line: string) => void;
  allowNotRunning?: boolean;
  waitForExit?: boolean;
}): Promise<number> {
  const paths = runtimePaths(options.env);
  const status = readRuntimeStatus(paths);
  if (!status.pid || !status.running) {
    if (status.pid) {
      clearRuntimeState(paths, status.pid);
    }
    writeJsonLine(options.writeStdout, {
      status: "not_running",
      runtime: readRuntimeStatus(paths)
    });
    return options.allowNotRunning ? 0 : 1;
  }

  try {
    if (!(await canReachRuntimeControl(paths, status.state, "/control/stop", "POST"))) {
      clearRuntimeState(paths, status.pid);
      writeJsonLine(options.writeStdout, {
        status: "not_running",
        runtime: readRuntimeStatus(paths)
      });
      return options.allowNotRunning ? 0 : 1;
    }

    if (options.waitForExit) {
      const exited = await waitForRuntimeExit(paths, status.pid);
      if (!exited) {
        options.writeStderr(`${LOG_PREFIX} timed out waiting for pid=${status.pid} to stop`);
        return 1;
      }
    }
    writeJsonLine(options.writeStdout, {
      status: options.waitForExit ? "stopped" : "stopping",
      pid: status.pid
    });
    return 0;
  } catch (error) {
    options.writeStderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function canReachRuntimeControl(
  paths: ReturnType<typeof runtimePaths>,
  state: ReturnType<typeof readRuntimeStatus>["state"],
  routePath: string,
  method: "GET" | "POST"
): Promise<boolean> {
  const token = readManagementToken(paths);
  if (!token || !state) {
    return false;
  }

  try {
    const response = await fetch(`http://${formatHttpHost(state.listenHost)}:${state.listenPort}${routePath}`, {
      method,
      headers: {
        "x-qq-codex-token": token
      },
      signal: AbortSignal.timeout(1_000)
    });
    return response.ok;
  } catch {
    return false;
  }
}

function readManagementToken(paths: ReturnType<typeof runtimePaths>): string | null {
  if (!fs.existsSync(paths.tokenPath)) {
    return null;
  }

  const token = fs.readFileSync(paths.tokenPath, "utf8").trim();
  return token || null;
}

function formatHttpHost(host: string): string {
  if (host === "0.0.0.0") {
    return "127.0.0.1";
  }
  if (host === "::") {
    return "[::1]";
  }
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

async function waitForRuntimeExit(
  paths: ReturnType<typeof runtimePaths>,
  pid: number,
  timeoutMs = 10_000
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const status = readRuntimeStatus(paths);
    if (!status.running || status.pid !== pid) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function readPackageVersion(packageRoot: string): string {
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof packageJson.version === "string" ? packageJson.version : "unknown";
  } catch {
    return "unknown";
  }
}

function findPackageRoot(startDir: string) {
  let currentDir = startDir;

  while (true) {
    if (fs.existsSync(path.join(currentDir, "package.json"))) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error(`Unable to locate package root from ${startDir}`);
    }
    currentDir = parentDir;
  }
}

const isEntrypoint = (() => {
  const entrypoint = process.argv[1];
  if (!entrypoint) {
    return false;
  }

  try {
    return fileURLToPath(import.meta.url) === path.resolve(entrypoint);
  } catch {
    return false;
  }
})();

if (isEntrypoint) {
  void runCliFromProcess();
}

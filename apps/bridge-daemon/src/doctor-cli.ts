import fs from "node:fs";
import path from "node:path";
import { SqliteRuntimeRecoveryStore } from "../../../packages/store/src/runtime-recovery-repo.js";
import { openReadonlySqliteDatabase } from "../../../packages/store/src/sqlite.js";
import { discoverCodexInstallations } from "./codex-discovery.js";
import { loadConfig } from "./config.js";
import {
  ensureManagementToken,
  ensureRuntimeHome,
  readRuntimeStatus,
  runtimePaths
} from "./runtime-state.js";

type DoctorCheck = {
  name: string;
  status: "ok" | "warning" | "failed";
  message: string;
};

export function runDoctor(options: {
  env: NodeJS.ProcessEnv;
  writeStdout: (line: string) => void;
  writeStderr: (line: string) => void;
}): number {
  const paths = runtimePaths(options.env);
  const checks: DoctorCheck[] = [];

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

  inspectConfigAndRecovery(options.env, checks, paths);

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
  options.writeStdout(JSON.stringify({
    status: failed ? "failed" : "ok",
    runtime: readRuntimeStatus(paths),
    checks
  }));
  return failed ? 1 : 0;
}

function inspectConfigAndRecovery(
  env: NodeJS.ProcessEnv,
  checks: DoctorCheck[],
  paths: ReturnType<typeof runtimePaths>
): void {
  try {
    const config = loadConfig(env);
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
        const unhealthy = recovery.expiredActiveTurns > 0
          || (!runtimeStatus.running && (
            recovery.activeTurns > 0
            || recovery.sessionLocks.expired > 0
            || recovery.threadLocks.expired > 0
          ));
        checks.push({
          name: "recovery",
          status: unhealthy ? "failed" : "ok",
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
    const hasAllowedInbound = config.accessControl.allowedC2cSenderIds.length > 0
      || config.accessControl.allowedGroupIds.length > 0
      || config.accessControl.allowedGroupMemberIds.length > 0;
    checks.push({
      name: "accessControl",
      status: config.accessControl.mode === "allow-all" || !hasAllowedInbound ? "warning" : "ok",
      message: config.accessControl.mode === "allow-all"
        ? "allow-all permits every bot-visible sender to control the local bridge"
        : hasAllowedInbound
          ? "deny-by-default with an explicit inbound allowlist"
          : "deny-by-default is enabled, but no private sender, group, or group member is allowlisted"
    });
  } catch (error) {
    checks.push({
      name: "config",
      status: "failed",
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

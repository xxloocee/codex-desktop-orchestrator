import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type RuntimePaths = {
  home: string;
  configPath: string;
  pidPath: string;
  tokenPath: string;
  statePath: string;
  logPath: string;
  mediaDir: string;
};

export type RuntimeState = {
  pid: number;
  startedAt: string;
  listenHost: string;
  listenPort: number;
  channels: string[];
  version: string;
};

export function resolveRuntimeHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.QQ_CODEX_RUNTIME_HOME?.trim();
  const rawHome = configured || path.join(os.homedir(), ".codex-desktop-orchestrator");
  return path.resolve(expandHome(rawHome));
}

export function runtimePaths(env: NodeJS.ProcessEnv = process.env): RuntimePaths {
  const home = resolveRuntimeHome(env);
  return {
    home,
    configPath: env.QQ_CODEX_CONFIG_PATH?.trim() || path.join(home, "config.json"),
    pidPath: path.join(home, "runtime.pid"),
    tokenPath: path.join(home, "management-token"),
    statePath: path.join(home, "state.json"),
    logPath: path.join(home, "runtime.log"),
    mediaDir: path.join(home, "media")
  };
}

export function ensureRuntimeHome(paths: RuntimePaths): void {
  fs.mkdirSync(paths.home, { recursive: true });
  fs.mkdirSync(paths.mediaDir, { recursive: true });
}

export function ensureManagementToken(paths: RuntimePaths): string {
  ensureRuntimeHome(paths);
  if (fs.existsSync(paths.tokenPath)) {
    const existing = fs.readFileSync(paths.tokenPath, "utf8").trim();
    if (existing) {
      return existing;
    }
  }

  const token = crypto.randomBytes(24).toString("hex");
  fs.writeFileSync(paths.tokenPath, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  return token;
}

export function writeRuntimeState(paths: RuntimePaths, state: RuntimeState): void {
  ensureRuntimeHome(paths);
  fs.writeFileSync(paths.pidPath, `${state.pid}\n`, "utf8");
  fs.writeFileSync(paths.statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  appendRuntimeLog(paths, `ready pid=${state.pid} port=${state.listenPort} channels=${state.channels.join(",")}`);
}

export function clearRuntimeState(paths: RuntimePaths, pid = process.pid): void {
  const recordedPid = readPid(paths.pidPath);
  if (recordedPid === null || recordedPid === pid) {
    removeIfExists(paths.pidPath);
    removeIfExists(paths.statePath);
  }
  appendRuntimeLog(paths, `stopped pid=${pid}`);
}

export function readRuntimeStatus(paths: RuntimePaths): {
  running: boolean;
  pid: number | null;
  state: RuntimeState | null;
  paths: RuntimePaths;
} {
  const pid = readPid(paths.pidPath);
  const state = readJsonFile<RuntimeState>(paths.statePath);
  const running = pid !== null && isProcessRunning(pid);
  if (pid !== null && !running) {
    removeIfExists(paths.pidPath);
    removeIfExists(paths.statePath);
    return {
      running: false,
      pid: null,
      state: null,
      paths
    };
  }

  return {
    running,
    pid,
    state,
    paths
  };
}

export function appendRuntimeLog(paths: RuntimePaths, message: string): void {
  ensureRuntimeHome(paths);
  fs.appendFileSync(paths.logPath, `${new Date().toISOString()} ${message}\n`, "utf8");
}

export function readRuntimeLogTail(paths: RuntimePaths, maxLines: number): string[] {
  if (!fs.existsSync(paths.logPath)) {
    return [];
  }

  const lines = fs.readFileSync(paths.logPath, "utf8").split(/\r?\n/).filter(Boolean);
  return lines.slice(-Math.max(1, maxLines));
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

function readPid(pidPath: string): number | null {
  if (!fs.existsSync(pidPath)) {
    return null;
  }

  const parsed = Number(fs.readFileSync(pidPath, "utf8").trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function readJsonFile<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function removeIfExists(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Best-effort cleanup only.
  }
}

function expandHome(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith(`~${path.sep}`) || value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

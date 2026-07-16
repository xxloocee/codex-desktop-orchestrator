import fs from "node:fs";
import {
  clearRuntimeState,
  readRuntimeStatus,
  runtimePaths
} from "./runtime-state.js";

const LOG_PREFIX = "[codex-desktop-orchestrator]";

export async function guardSingleRuntimeInstance(options: {
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

export async function stopRuntime(options: {
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
    const response = await fetch(
      `http://${formatHttpHost(state.listenHost)}:${state.listenPort}${routePath}`,
      {
        method,
        headers: { "x-qq-codex-token": token },
        signal: AbortSignal.timeout(1_000)
      }
    );
    return response.ok;
  } catch {
    return false;
  }
}

function readManagementToken(paths: ReturnType<typeof runtimePaths>): string | null {
  if (!fs.existsSync(paths.tokenPath)) {
    return null;
  }
  return fs.readFileSync(paths.tokenPath, "utf8").trim() || null;
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

function writeJsonLine(writeStdout: (line: string) => void, value: unknown): void {
  writeStdout(JSON.stringify(value));
}

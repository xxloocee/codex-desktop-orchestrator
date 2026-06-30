import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readRuntimeStatus, runtimePaths, writeRuntimeState } from "../../apps/bridge-daemon/src/runtime-state.js";

describe("runtime state", () => {
  it("clears stale pid and state files when the process is no longer running", () => {
    const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), "qq-codex-runtime-state-"));
    const paths = runtimePaths({ QQ_CODEX_RUNTIME_HOME: runtimeHome });
    writeRuntimeState(paths, {
      pid: 99999999,
      startedAt: "2026-06-24T00:00:00.000Z",
      listenHost: "127.0.0.1",
      listenPort: 3100,
      channels: ["qqbot:default"],
      version: "0.0.1"
    });

    const status = readRuntimeStatus(paths);

    expect(status.running).toBe(false);
    expect(status.pid).toBeNull();
    expect(status.state).toBeNull();
    expect(fs.existsSync(paths.pidPath)).toBe(false);
    expect(fs.existsSync(paths.statePath)).toBe(false);
  });
});

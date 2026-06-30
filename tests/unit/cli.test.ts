import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../apps/bridge-daemon/src/cli.js";

function createTempDir(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function collectWrites() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    writeStdout: (line: string) => {
      stdout.push(line);
    },
    writeStderr: (line: string) => {
      stderr.push(line);
    }
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("cli", () => {
  it("creates .env in the current directory from the packaged template", async () => {
    const cwd = createTempDir("qq-codex-cli-cwd-");
    const packageRoot = createTempDir("qq-codex-cli-pkg-");
    const runtimeHome = createTempDir("qq-codex-runtime-");
    fs.writeFileSync(path.join(packageRoot, ".env.example"), "QQBOT_APP_ID=demo\n");
    const io = collectWrites();

    await expect(
      runCli(["init"], {
        cwd,
        env: { QQ_CODEX_RUNTIME_HOME: runtimeHome },
        packageRoot,
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr
      })
    ).resolves.toBe(0);

    expect(fs.readFileSync(path.join(cwd, ".env"), "utf8")).toBe("QQBOT_APP_ID=demo\n");
    expect(io.stdout.join("\n")).toContain("已生成");
    const config = JSON.parse(fs.readFileSync(path.join(runtimeHome, "config.json"), "utf8")) as {
      accessControl?: { mode?: string };
      projectAliases?: Record<string, { cwd?: string; label?: string }>;
    };
    const aliasName = path.basename(cwd);
    expect(config.accessControl?.mode).toBe("allow-all");
    expect(config.projectAliases?.[aliasName]).toEqual({
      cwd: path.resolve(cwd),
      label: aliasName
    });
    expect(io.stderr).toHaveLength(0);
  });

  it("refuses to overwrite an existing .env file", async () => {
    const cwd = createTempDir("qq-codex-cli-cwd-");
    const packageRoot = createTempDir("qq-codex-cli-pkg-");
    const runtimeHome = createTempDir("qq-codex-runtime-");
    fs.writeFileSync(path.join(packageRoot, ".env.example"), "QQBOT_APP_ID=demo\n");
    fs.writeFileSync(path.join(runtimeHome, "config.json"), "{}\n");
    fs.writeFileSync(path.join(cwd, ".env"), "QQBOT_APP_ID=existing\n");
    const io = collectWrites();

    await expect(
      runCli(["init"], {
        cwd,
        env: { QQ_CODEX_RUNTIME_HOME: runtimeHome },
        packageRoot,
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr
      })
    ).resolves.toBe(1);

    expect(fs.readFileSync(path.join(cwd, ".env"), "utf8")).toBe("QQBOT_APP_ID=existing\n");
    expect(io.stderr.join("\n")).toContain("已存在");
  });

  it("loads the current directory .env before starting the bridge daemon", async () => {
    const cwd = createTempDir("qq-codex-cli-cwd-");
    const runtimeHome = createTempDir("qq-codex-runtime-");
    fs.writeFileSync(path.join(cwd, ".env"), "QQBOT_APP_ID=app-id\n");
    const env: NodeJS.ProcessEnv = { QQ_CODEX_RUNTIME_HOME: runtimeHome };
    const loadEnvFile = vi.fn(() => {
      env.QQBOT_APP_ID = "app-id";
      env.QQBOT_CLIENT_SECRET = "secret";
      env.CODEX_APP_NAME = "Codex";
      env.CODEX_REMOTE_DEBUGGING_PORT = "9229";
      env.CODEX_DESKTOP_TRANSPORT = "dom";
    });
    const ensureCodexDesktop = vi.fn().mockResolvedValue({ launched: false });
    const runBridgeDaemon = vi.fn().mockResolvedValue({ channels: ["qq", "weixin"] });
    const io = collectWrites();

    await expect(
      runCli([], {
        cwd,
        env,
        loadEnvFile,
        ensureCodexDesktop,
        runBridgeDaemon,
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr
      })
    ).resolves.toBe(0);

    expect(loadEnvFile).toHaveBeenCalledWith(path.join(cwd, ".env"));
    expect(ensureCodexDesktop).toHaveBeenCalledWith(
      expect.objectContaining({
        appName: "Codex",
        remoteDebuggingPort: 9229
      })
    );
    expect(runBridgeDaemon).toHaveBeenCalledTimes(1);
    expect(io.stdout.join("\n")).toContain("channels active: qq, weixin");
  });

  it("prints actionable config errors when required env vars are missing", async () => {
    const cwd = createTempDir("qq-codex-cli-cwd-");
    const runtimeHome = createTempDir("qq-codex-runtime-");
    const io = collectWrites();

    await expect(
      runCli([], {
        cwd,
        env: { QQ_CODEX_RUNTIME_HOME: runtimeHome },
        loadEnvFile: vi.fn(),
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr
      })
    ).resolves.toBe(1);

    expect(io.stderr.join("\n")).toContain("配置不完整");
    expect(io.stderr.join("\n")).toContain("QQBOT_APP_ID");
    expect(io.stderr.join("\n")).toContain("QQBOT_CLIENT_SECRET");
    expect(io.stderr.join("\n")).toContain("codex-desktop-orchestrator init");
  });

  it("prints the new primary CLI name in help", async () => {
    const io = collectWrites();

    await expect(
      runCli(["help"], {
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr
      })
    ).resolves.toBe(0);

    const stdout = io.stdout.join("\n");
    expect(stdout).toContain("codex-desktop-orchestrator start");
    expect(stdout).not.toContain("兼容别名");
  });

  it("reports when Codex Desktop was already reachable", async () => {
    const cwd = createTempDir("qq-codex-cli-cwd-");
    const runtimeHome = createTempDir("qq-codex-runtime-");
    fs.writeFileSync(path.join(cwd, ".env"), "QQBOT_APP_ID=app-id\n");
    const env: NodeJS.ProcessEnv = {
      QQ_CODEX_RUNTIME_HOME: runtimeHome,
      CODEX_DESKTOP_TRANSPORT: "dom",
      QQBOT_APP_ID: "app-id",
      QQBOT_CLIENT_SECRET: "secret"
    };
    const ensureCodexDesktop = vi.fn().mockResolvedValue({ launched: false });
    const runBridgeDaemon = vi.fn().mockResolvedValue(undefined);
    const io = collectWrites();

    await expect(
      runCli([], {
        cwd,
        env,
        loadEnvFile: vi.fn(),
        ensureCodexDesktop,
        runBridgeDaemon,
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr
      })
    ).resolves.toBe(0);

    expect(io.stdout.join("\n")).toContain("launched: false");
  });

  it("reports when the cli auto-launches Codex Desktop", async () => {
    const cwd = createTempDir("qq-codex-cli-cwd-");
    const runtimeHome = createTempDir("qq-codex-runtime-");
    fs.writeFileSync(path.join(cwd, ".env"), "QQBOT_APP_ID=app-id\n");
    const env: NodeJS.ProcessEnv = {
      QQ_CODEX_RUNTIME_HOME: runtimeHome,
      CODEX_DESKTOP_TRANSPORT: "dom",
      QQBOT_APP_ID: "app-id",
      QQBOT_CLIENT_SECRET: "secret"
    };
    const ensureCodexDesktop = vi.fn().mockResolvedValue({ launched: true });
    const runBridgeDaemon = vi.fn().mockResolvedValue(undefined);
    const io = collectWrites();

    await expect(
      runCli([], {
        cwd,
        env,
        loadEnvFile: vi.fn(),
        ensureCodexDesktop,
        runBridgeDaemon,
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr
      })
    ).resolves.toBe(0);

    expect(io.stdout.join("\n")).toContain("launched: true");
  });

  it("skips Codex Desktop readiness checks for the default app-server transport", async () => {
    const cwd = createTempDir("qq-codex-cli-cwd-");
    const runtimeHome = createTempDir("qq-codex-runtime-");
    const env: NodeJS.ProcessEnv = {
      QQ_CODEX_RUNTIME_HOME: runtimeHome,
      QQBOT_APP_ID: "app-id",
      QQBOT_CLIENT_SECRET: "secret"
    };
    const ensureCodexDesktop = vi.fn().mockResolvedValue({ launched: false });
    const runBridgeDaemon = vi.fn().mockResolvedValue({ channels: ["qq"] });
    const io = collectWrites();

    await expect(
      runCli(["start"], {
        cwd,
        env,
        loadEnvFile: vi.fn(),
        ensureCodexDesktop,
        runBridgeDaemon,
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr
      })
    ).resolves.toBe(0);

    expect(ensureCodexDesktop).not.toHaveBeenCalled();
    expect(runBridgeDaemon).toHaveBeenCalledTimes(1);
    expect(io.stdout.join("\n")).toContain("codex desktop readiness check skipped");
  });

  it("can skip Codex Desktop readiness checks for local smoke tests", async () => {
    const cwd = createTempDir("qq-codex-cli-cwd-");
    const runtimeHome = createTempDir("qq-codex-runtime-");
    const env: NodeJS.ProcessEnv = {
      QQ_CODEX_RUNTIME_HOME: runtimeHome,
      QQ_CODEX_SKIP_DESKTOP_READY: "1",
      QQBOT_APP_ID: "app-id",
      QQBOT_CLIENT_SECRET: "secret"
    };
    const ensureCodexDesktop = vi.fn().mockResolvedValue({ launched: false });
    const runBridgeDaemon = vi.fn().mockResolvedValue({ channels: ["qq"] });
    const io = collectWrites();

    await expect(
      runCli(["start"], {
        cwd,
        env,
        loadEnvFile: vi.fn(),
        ensureCodexDesktop,
        runBridgeDaemon,
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr
      })
    ).resolves.toBe(0);

    expect(ensureCodexDesktop).not.toHaveBeenCalled();
    expect(runBridgeDaemon).toHaveBeenCalledTimes(1);
    expect(io.stdout.join("\n")).toContain("codex desktop readiness check skipped");
  });

  it("prints package version", async () => {
    const packageRoot = createTempDir("qq-codex-cli-pkg-");
    fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ version: "9.8.7" }));
    const io = collectWrites();

    await expect(
      runCli(["version"], {
        packageRoot,
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr
      })
    ).resolves.toBe(0);

    expect(io.stdout).toEqual(["9.8.7"]);
  });

  it("prints runtime status as json", async () => {
    const runtimeHome = createTempDir("qq-codex-runtime-");
    const io = collectWrites();

    await expect(
      runCli(["status"], {
        env: { QQ_CODEX_RUNTIME_HOME: runtimeHome },
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr
      })
    ).resolves.toBe(0);

    const payload = JSON.parse(io.stdout[0] ?? "{}") as { status?: string; runtime?: { paths?: { home?: string } } };
    expect(payload.status).toBe("ok");
    expect(payload.runtime?.paths?.home).toBe(runtimeHome);
  });

  it("ignores the pnpm argument separator", async () => {
    const runtimeHome = createTempDir("qq-codex-runtime-");
    const io = collectWrites();

    await expect(
      runCli(["--", "status"], {
        env: { QQ_CODEX_RUNTIME_HOME: runtimeHome },
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr
      })
    ).resolves.toBe(0);

    expect(JSON.parse(io.stdout[0] ?? "{}")).toMatchObject({ status: "ok" });
  });

  it("runs doctor and reports config failures as json", async () => {
    const runtimeHome = createTempDir("qq-codex-runtime-");
    const io = collectWrites();

    await expect(
      runCli(["doctor"], {
        env: { QQ_CODEX_RUNTIME_HOME: runtimeHome },
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr
      })
    ).resolves.toBe(1);

    const payload = JSON.parse(io.stdout[0] ?? "{}") as {
      status?: string;
      checks?: Array<{ name: string; status: string }>;
    };
    expect(payload.status).toBe("failed");
    expect(payload.checks).toContainEqual(expect.objectContaining({ name: "config", status: "failed" }));
  });

  it("prints runtime log tail", async () => {
    const runtimeHome = createTempDir("qq-codex-runtime-");
    fs.writeFileSync(path.join(runtimeHome, "runtime.log"), "one\ntwo\nthree\n");
    const io = collectWrites();

    await expect(
      runCli(["logs", "2"], {
        env: { QQ_CODEX_RUNTIME_HOME: runtimeHome },
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr
      })
    ).resolves.toBe(0);

    expect(io.stdout).toEqual(["two", "three"]);
  });

  it("refuses to start when the runtime home already has a running pid", async () => {
    const runtimeHome = createTempDir("qq-codex-runtime-");
    fs.writeFileSync(path.join(runtimeHome, "runtime.pid"), `${process.pid}\n`);
    fs.writeFileSync(path.join(runtimeHome, "management-token"), "secret-token\n");
    fs.writeFileSync(path.join(runtimeHome, "state.json"), `${JSON.stringify({
      pid: process.pid,
      startedAt: "2026-06-24T00:00:00.000Z",
      listenHost: "127.0.0.1",
      listenPort: 3100,
      channels: ["qqbot:default"],
      version: "0.0.1"
    })}\n`);
    vi.spyOn(process, "kill").mockImplementation(() => true);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const ensureCodexDesktop = vi.fn().mockResolvedValue({ launched: false });
    const runBridgeDaemon = vi.fn().mockResolvedValue({ channels: ["qq"] });
    const io = collectWrites();

    await expect(
      runCli(["start"], {
        env: { QQ_CODEX_RUNTIME_HOME: runtimeHome },
        loadEnvFile: vi.fn(),
        ensureCodexDesktop,
        runBridgeDaemon,
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr
      })
    ).resolves.toBe(1);

    expect(io.stderr.join("\n")).toContain("already running");
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3100/status",
      expect.objectContaining({
        method: "GET",
        headers: { "x-qq-codex-token": "secret-token" }
      })
    );
    expect(ensureCodexDesktop).not.toHaveBeenCalled();
    expect(runBridgeDaemon).not.toHaveBeenCalled();
  });

  it("clears a live but unverified pid before starting the runtime", async () => {
    const runtimeHome = createTempDir("qq-codex-runtime-");
    const pidPath = path.join(runtimeHome, "runtime.pid");
    const statePath = path.join(runtimeHome, "state.json");
    fs.writeFileSync(pidPath, `${process.pid}\n`);
    fs.writeFileSync(path.join(runtimeHome, "management-token"), "secret-token\n");
    fs.writeFileSync(statePath, `${JSON.stringify({
      pid: process.pid,
      startedAt: "2026-06-24T00:00:00.000Z",
      listenHost: "127.0.0.1",
      listenPort: 3100,
      channels: ["qqbot:default"],
      version: "0.0.1"
    })}\n`);
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (signal === 0) {
        return true;
      }
      throw new Error(`unexpected kill ${String(pid)} ${String(signal)}`);
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection refused")));
    const ensureCodexDesktop = vi.fn().mockResolvedValue({ launched: false });
    const runBridgeDaemon = vi.fn().mockResolvedValue({ channels: ["qq"] });
    const io = collectWrites();

    await expect(
      runCli(["start"], {
        env: {
          QQ_CODEX_RUNTIME_HOME: runtimeHome,
          QQBOT_APP_ID: "app-id",
          QQBOT_CLIENT_SECRET: "secret"
        },
        loadEnvFile: vi.fn(),
        ensureCodexDesktop,
        runBridgeDaemon,
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr
      })
    ).resolves.toBe(0);

    expect(fs.existsSync(pidPath)).toBe(false);
    expect(fs.existsSync(statePath)).toBe(false);
    expect(io.stderr.join("\n")).toContain("clearing stale runtime state");
    expect(ensureCodexDesktop).not.toHaveBeenCalled();
    expect(runBridgeDaemon).toHaveBeenCalledTimes(1);
  });

  it("clears a stale pid before starting the runtime", async () => {
    const runtimeHome = createTempDir("qq-codex-runtime-");
    const pidPath = path.join(runtimeHome, "runtime.pid");
    fs.writeFileSync(pidPath, "12345\n");
    vi.spyOn(process, "kill").mockImplementation(() => {
      const error = new Error("process not found") as NodeJS.ErrnoException;
      error.code = "ESRCH";
      throw error;
    });
    const ensureCodexDesktop = vi.fn().mockResolvedValue({ launched: false });
    const runBridgeDaemon = vi.fn().mockResolvedValue({ channels: ["qq"] });
    const io = collectWrites();

    await expect(
      runCli(["start"], {
        env: {
          QQ_CODEX_RUNTIME_HOME: runtimeHome,
          QQBOT_APP_ID: "app-id",
          QQBOT_CLIENT_SECRET: "secret"
        },
        loadEnvFile: vi.fn(),
        ensureCodexDesktop,
        runBridgeDaemon,
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr
      })
    ).resolves.toBe(0);

    expect(fs.existsSync(pidPath)).toBe(false);
    expect(ensureCodexDesktop).not.toHaveBeenCalled();
    expect(runBridgeDaemon).toHaveBeenCalledTimes(1);
  });

  it("does not signal a live pid when stop cannot verify runtime control", async () => {
    const runtimeHome = createTempDir("qq-codex-runtime-");
    const pidPath = path.join(runtimeHome, "runtime.pid");
    const statePath = path.join(runtimeHome, "state.json");
    fs.writeFileSync(pidPath, `${process.pid}\n`);
    fs.writeFileSync(path.join(runtimeHome, "management-token"), "secret-token\n");
    fs.writeFileSync(statePath, `${JSON.stringify({
      pid: process.pid,
      startedAt: "2026-06-24T00:00:00.000Z",
      listenHost: "127.0.0.1",
      listenPort: 3100,
      channels: ["qqbot:default"],
      version: "0.0.1"
    })}\n`);
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (signal === 0) {
        return true;
      }
      throw new Error(`unexpected kill ${String(pid)} ${String(signal)}`);
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    const io = collectWrites();

    await expect(
      runCli(["stop"], {
        env: { QQ_CODEX_RUNTIME_HOME: runtimeHome },
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr
      })
    ).resolves.toBe(1);

    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3100/control/stop",
      expect.objectContaining({
        method: "POST",
        headers: { "x-qq-codex-token": "secret-token" }
      })
    );
    expect(JSON.parse(io.stdout[0] ?? "{}")).toMatchObject({ status: "not_running" });
    expect(fs.existsSync(pidPath)).toBe(false);
    expect(fs.existsSync(statePath)).toBe(false);
  });
});

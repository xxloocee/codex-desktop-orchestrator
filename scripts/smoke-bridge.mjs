import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-desktop-orchestrator-smoke-"));
const listenPort = await getFreePort();
const cliPath = path.join(repoRoot, "dist", "apps", "bridge-daemon", "src", "cli.js");
const childOutput = [];

if (!fs.existsSync(cliPath)) {
  fail(`missing built CLI at ${cliPath}; run npm run build first`);
}

const child = spawn(process.execPath, [cliPath, "start"], {
  cwd: repoRoot,
  env: {
    ...process.env,
    QQ_CODEX_RUNTIME_HOME: runtimeHome,
    QQ_CODEX_CONFIG_PATH: path.join(runtimeHome, "missing-config.json"),
    QQ_CODEX_DATABASE_PATH: path.join(runtimeHome, "bridge.sqlite"),
    QQ_CODEX_LISTEN_HOST: "127.0.0.1",
    QQ_CODEX_LISTEN_PORT: String(listenPort),
    QQ_CODEX_DISABLE_QQ_GATEWAY: "1",
    QQ_CODEX_SKIP_DESKTOP_READY: "1",
    QQBOT_APP_ID: "offline-smoke-app",
    QQBOT_CLIENT_SECRET: "offline-smoke-secret",
    QQ_CODEX_ALLOWED_C2C_SENDERS: "OFFLINE_SMOKE_USER",
    WEIXIN_ENABLED: "false"
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});

child.stdout.on("data", (chunk) => rememberOutput("stdout", chunk));
child.stderr.on("data", (chunk) => rememberOutput("stderr", chunk));

try {
  await waitForRuntimeReady();
  const token = fs.readFileSync(path.join(runtimeHome, "management-token"), "utf8").trim();
  if (!token) {
    fail("management token was empty");
  }

  const health = await requestJson("GET", "/health", token);
  assertEqual(health.status, "ok", "health status");
  assertEqual(health.config?.listenPort, listenPort, "health listen port");

  const status = await requestJson("GET", "/status", token);
  assertEqual(status.running, true, "runtime status running");
  assertEqual(status.state?.listenPort, listenPort, "runtime state listen port");

  const logs = await requestJson("GET", "/logs", token);
  if (!Array.isArray(logs.lines) || logs.lines.length === 0) {
    fail("expected non-empty runtime logs");
  }
  if (!logs.lines.some((line) => line.includes("qq gateway disabled"))) {
    fail("expected runtime logs to show QQ gateway disabled smoke mode");
  }

  const stop = await requestJson("POST", "/control/stop", token, {});
  assertEqual(stop.status, "stopping", "stop status");
  await waitForChildExit(10_000);

  console.log(JSON.stringify({
    status: "ok",
    runtimeHome,
    listenPort,
    checks: ["health", "status", "logs", "control/stop"]
  }, null, 2));
} catch (error) {
  await cleanup();
  fail(error instanceof Error ? error.message : String(error));
}

async function waitForRuntimeReady(timeoutMs = 15_000) {
  const startedAt = Date.now();
  const tokenPath = path.join(runtimeHome, "management-token");
  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null) {
      fail(`bridge exited early with code ${child.exitCode}`);
    }
    if (fs.existsSync(tokenPath)) {
      try {
        const token = fs.readFileSync(tokenPath, "utf8").trim();
        if (token) {
          const health = await requestJson("GET", "/health", token, undefined, 500).catch(() => null);
          if (health?.status === "ok") {
            return;
          }
        }
      } catch {
        // Keep polling until the bridge is ready or timeout expires.
      }
    }
    await sleep(100);
  }
  fail("timed out waiting for bridge health endpoint");
}

async function requestJson(method, routePath, token, body, timeoutMs = 5_000) {
  const responseText = await request(method, routePath, token, body, timeoutMs);
  try {
    return JSON.parse(responseText);
  } catch (error) {
    throw new Error(`invalid JSON from ${method} ${routePath}: ${responseText}`);
  }
}

function request(method, routePath, token, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8");
    const req = http.request({
      host: "127.0.0.1",
      port: listenPort,
      path: routePath,
      method,
      headers: {
        "x-qq-codex-token": token,
        ...(payload ? {
          "content-type": "application/json",
          "content-length": String(payload.length)
        } : {})
      },
      timeout: timeoutMs
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`${method} ${routePath} failed: ${res.statusCode} ${text}`));
          return;
        }
        resolve(text);
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error(`${method} ${routePath} timed out`));
    });
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

async function waitForChildExit(timeoutMs) {
  if (child.exitCode !== null) {
    return;
  }
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null) {
      return;
    }
    await sleep(100);
  }
  fail("bridge did not exit after /control/stop");
}

async function cleanup() {
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([
      waitForChildExit(3_000).catch(() => undefined),
      sleep(3_000)
    ]);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
  }
}

function rememberOutput(stream, chunk) {
  childOutput.push(`[${stream}] ${String(chunk).trim()}`);
  while (childOutput.length > 40) {
    childOutput.shift();
  }
}

function fail(message) {
  console.error(JSON.stringify({
    status: "failed",
    runtimeHome,
    listenPort,
    error: message,
    outputTail: childOutput
  }, null, 2));
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("expected address info")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

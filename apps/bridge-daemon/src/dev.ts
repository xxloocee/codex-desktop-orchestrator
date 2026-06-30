import { loadConfig } from "./config.js";
import { ensureCodexDesktopForDev } from "./dev-launch.js";
import { installBridgeRuntimeSignalHandlers, runBridgeDaemon } from "./main.js";

async function runDev() {
  const config = loadConfig(process.env);
  const result = await ensureCodexDesktopForDev({
    appName: config.codexDesktop.appName,
    remoteDebuggingPort: config.codexDesktop.remoteDebuggingPort,
    startupTimeoutMs: Number(process.env.CODEX_CDP_STARTUP_TIMEOUT_MS ?? "15000"),
    startupPollIntervalMs: Number(process.env.CODEX_CDP_POLL_INTERVAL_MS ?? "500")
  });

  console.log("[codex-desktop-orchestrator] codex desktop ready", {
    launched: result.launched,
    remoteDebuggingPort: config.codexDesktop.remoteDebuggingPort
  });

  const runtime = await runBridgeDaemon();
  installBridgeRuntimeSignalHandlers(runtime);
}

runDev().catch((error) => {
  const cause = error instanceof Error ? error.cause : undefined;
  console.error("[codex-desktop-orchestrator] fatal:", error instanceof Error ? error.message : String(error));
  if (cause !== undefined) {
    console.error("  caused by:", cause);
  }
  if (error instanceof Error && error.stack) {
    console.error("  stack:", error.stack);
  }
  process.exitCode = 1;
});

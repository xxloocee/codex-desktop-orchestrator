import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverCodexInstallations } from "../../apps/bridge-daemon/src/codex-discovery.js";

describe("codex discovery", () => {
  it("prefers explicit env paths", () => {
    const result = discoverCodexInstallations({
      platform: "win32",
      env: {
        CODEX_APP_PATH: "C:\\Codex\\Codex.exe",
        CODEX_BINARY_PATH: "C:\\Codex\\codex.exe"
      },
      existsSync: () => false,
      getAppxPackageInstallLocations: () => []
    });

    expect(result.desktopPath).toBe("C:\\Codex\\Codex.exe");
    expect(result.desktopSource).toBe("env");
    expect(result.binaryPath).toBe("C:\\Codex\\codex.exe");
    expect(result.binarySource).toBe("env");
  });

  it("discovers common Windows install paths", () => {
    const localAppData = "C:\\Users\\me\\AppData\\Local";
    const desktop = path.join(localAppData, "Programs", "Codex", "Codex.exe");
    const binary = path.join(localAppData, "Programs", "Codex", "resources", "codex.exe");
    const result = discoverCodexInstallations({
      platform: "win32",
      env: { LOCALAPPDATA: localAppData },
      existsSync: (candidate) => candidate === desktop || candidate === binary,
      getAppxPackageInstallLocations: () => []
    });

    expect(result.desktopPath).toBe(desktop);
    expect(result.desktopSource).toBe("auto");
    expect(result.binaryPath).toBe(binary);
    expect(result.binarySource).toBe("auto");
  });

  it("discovers Microsoft Store WindowsApps installs", () => {
    const programFiles = "C:\\Program Files";
    const packageDir = path.join(programFiles, "WindowsApps", "OpenAI.Codex_26.616.9593.0_x64__2p2nqsd0c76g0");
    const desktop = path.join(packageDir, "app", "Codex.exe");
    const binary = path.join(packageDir, "app", "resources", "codex.exe");
    const result = discoverCodexInstallations({
      platform: "win32",
      env: { PROGRAMFILES: programFiles },
      existsSync: (candidate) => candidate === desktop || candidate === binary,
      getAppxPackageInstallLocations: () => [],
      readdirNames: (directory) =>
        directory === path.join(programFiles, "WindowsApps")
          ? ["Other.Package_1.0_x64__abc", "OpenAI.Codex_26.616.9593.0_x64__2p2nqsd0c76g0"]
          : []
    });

    expect(result.desktopPath).toBe(desktop);
    expect(result.desktopSource).toBe("auto");
    expect(result.binaryPath).toBe(binary);
    expect(result.binarySource).toBe("auto");
  });

  it("discovers Microsoft Store installs through Appx package metadata when WindowsApps cannot be listed", () => {
    const packageDir = "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.616.9593.0_x64__2p2nqsd0c76g0";
    const desktop = path.join(packageDir, "app", "Codex.exe");
    const binary = path.join(packageDir, "app", "resources", "codex.exe");
    const result = discoverCodexInstallations({
      platform: "win32",
      env: {},
      existsSync: (candidate) => candidate === desktop || candidate === binary,
      readdirNames: () => {
        throw new Error("EPERM");
      },
      getAppxPackageInstallLocations: () => [packageDir]
    });

    expect(result.desktopPath).toBe(desktop);
    expect(result.desktopSource).toBe("auto");
    expect(result.binaryPath).toBe(binary);
    expect(result.binarySource).toBe("auto");
  });

  it("prefers spawnable PATH command shims over Microsoft Store package binaries", () => {
    const programFiles = "C:\\Program Files";
    const packageDir = path.join(programFiles, "WindowsApps", "OpenAI.Codex_26.616.9593.0_x64__2p2nqsd0c76g0");
    const appxBinary = path.join(packageDir, "app", "resources", "codex.exe");
    const pathShim = "D:\\DevTools\\nodejs\\codex.cmd";
    const result = discoverCodexInstallations({
      platform: "win32",
      env: { PROGRAMFILES: programFiles },
      existsSync: (candidate) => candidate === appxBinary || candidate === pathShim,
      readdirNames: () => [],
      getAppxPackageInstallLocations: () => [packageDir],
      getPathCommandCandidates: () => [pathShim, appxBinary]
    });

    expect(result.binaryPath).toBe(pathShim);
    expect(result.binarySource).toBe("auto");
  });

  it("falls back to PATH codex command when no binary path is found", () => {
    const result = discoverCodexInstallations({
      platform: "linux",
      env: {},
      existsSync: () => false,
      getAppxPackageInstallLocations: () => []
    });

    expect(result.binaryPath).toBe("codex");
    expect(result.binarySource).toBe("path_fallback");
  });
});

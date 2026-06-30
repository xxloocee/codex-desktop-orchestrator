import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export type CodexDiscoveryResult = {
  desktopPath: string | null;
  desktopSource: "env" | "auto" | "not_found";
  binaryPath: string | null;
  binarySource: "env" | "auto" | "path_fallback";
};

type DiscoveryDeps = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  existsSync?: (candidate: string) => boolean;
  readdirNames?: (directory: string) => string[];
  getAppxPackageInstallLocations?: () => string[];
  getPathCommandCandidates?: () => string[];
};

export function discoverCodexInstallations(deps: DiscoveryDeps = {}): CodexDiscoveryResult {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const existsSync = deps.existsSync ?? fs.existsSync;
  const readdirNames = deps.readdirNames ?? readDirectoryNames;
  const getAppxPackageInstallLocations = deps.getAppxPackageInstallLocations
    ?? discoverWindowsAppxCodexInstallLocations;
  const getPathCommandCandidates = deps.getPathCommandCandidates ?? discoverCodexPathCommandCandidates;
  const desktopEnv = firstNonEmpty(env.CODEX_APP_PATH, env.CODEX_DESKTOP_PATH);
  const binaryEnv = firstNonEmpty(env.CODEX_BINARY_PATH);

  const desktopPath = desktopEnv ?? firstExisting(
    desktopCandidates(platform, env, readdirNames, getAppxPackageInstallLocations),
    existsSync
  );
  const binaryPath = binaryEnv ?? firstExisting(
    binaryCandidates(platform, env, readdirNames, getAppxPackageInstallLocations, getPathCommandCandidates),
    existsSync
  );

  return {
    desktopPath,
    desktopSource: desktopEnv ? "env" : desktopPath ? "auto" : "not_found",
    binaryPath: binaryPath ?? "codex",
    binarySource: binaryEnv ? "env" : binaryPath ? "auto" : "path_fallback"
  };
}

function desktopCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  readdirNames: (directory: string) => string[],
  getAppxPackageInstallLocations: () => string[]
): string[] {
  if (platform === "win32") {
    return [
      path.join(env.LOCALAPPDATA ?? "", "Programs", "Codex", "Codex.exe"),
      path.join(env.PROGRAMFILES ?? "", "Codex", "Codex.exe"),
      path.join(env["PROGRAMFILES(X86)"] ?? "", "Codex", "Codex.exe"),
      ...windowsAppsCodexPackageDirs(env, readdirNames, getAppxPackageInstallLocations).map((dir) =>
        path.join(dir, "app", "Codex.exe")
      )
    ];
  }

  if (platform === "darwin") {
    return [
      "/Applications/Codex.app/Contents/MacOS/Codex",
      path.join(os.homedir(), "Applications", "Codex.app", "Contents", "MacOS", "Codex")
    ];
  }

  return ["codex"];
}

function binaryCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  readdirNames: (directory: string) => string[],
  getAppxPackageInstallLocations: () => string[],
  getPathCommandCandidates: () => string[]
): string[] {
  if (platform === "win32") {
    return [
      path.join(env.LOCALAPPDATA ?? "", "Programs", "Codex", "resources", "codex.exe"),
      path.join(env.LOCALAPPDATA ?? "", "Programs", "Codex", "codex.exe"),
      ...getPathCommandCandidates().filter((candidate) => !candidate.includes("\\WindowsApps\\")),
      ...windowsAppsCodexPackageDirs(env, readdirNames, getAppxPackageInstallLocations).map((dir) =>
        path.join(dir, "app", "resources", "codex.exe")
      )
    ];
  }

  if (platform === "darwin") {
    return ["/Applications/Codex.app/Contents/Resources/codex"];
  }

  return [];
}

function windowsAppsCodexPackageDirs(
  env: NodeJS.ProcessEnv,
  readdirNames: (directory: string) => string[],
  getAppxPackageInstallLocations: () => string[]
): string[] {
  const appxLocations = getAppxPackageInstallLocations();
  const windowsAppsDir = path.join(env.PROGRAMFILES ?? "C:\\Program Files", "WindowsApps");
  let scannedLocations: string[] = [];
  try {
    scannedLocations = readdirNames(windowsAppsDir)
      .filter((name) => /^OpenAI\.Codex_.+__/.test(name))
      .sort()
      .reverse()
      .map((name) => path.join(windowsAppsDir, name));
  } catch {
    scannedLocations = [];
  }

  return [...new Set([...appxLocations, ...scannedLocations])];
}

function readDirectoryNames(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function discoverWindowsAppxCodexInstallLocations(): string[] {
  try {
    return execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "(Get-AppxPackage OpenAI.Codex | Select-Object -ExpandProperty InstallLocation) -join \"`n\""
      ],
      {
        encoding: "utf8",
        timeout: 2_000,
        windowsHide: true
      }
    )
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function discoverCodexPathCommandCandidates(): string[] {
  try {
    return execFileSync("where.exe", ["codex"], {
      encoding: "utf8",
      timeout: 2_000,
      windowsHide: true
    })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function firstExisting(candidates: string[], existsSync: (candidate: string) => boolean): string | null {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function firstNonEmpty(...values: Array<string | undefined>): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
}

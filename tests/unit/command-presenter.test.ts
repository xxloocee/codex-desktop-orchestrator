import { describe, expect, it } from "vitest";
import type { CodexThreadSummary } from "../../packages/domain/src/driver.js";
import {
  areThreadRefsEquivalent,
  buildAccountsText,
  buildHelpText,
  buildProjectAliasesText,
  buildProjectsText,
  buildUnknownCommandText,
  buildUnknownProjectText,
  formatThreads
} from "../../apps/bridge-daemon/src/command-presenter.js";

function createThread(overrides: Partial<CodexThreadSummary> = {}): CodexThreadSummary {
  return {
    index: 1,
    title: "Bridge | Demo",
    projectName: "qq-codex-bridge",
    relativeTime: "2m ago",
    isCurrent: false,
    threadRef: "codex-app-thread:thread-1:turn-1",
    ...overrides
  };
}

describe("command presenter", () => {
  it("formats help and unknown command text by provider", () => {
    expect(buildHelpText("codex-desktop")).toContain("快捷命令（当前源：Codex Desktop）");
    expect(buildHelpText("chatgpt-desktop")).toContain("快捷命令（当前源：ChatGPT Desktop）");
    expect(buildUnknownCommandText("/wat", "codex-desktop")).toContain("未识别的桥接快捷指令：`/wat`");
  });

  it("formats account status with escaped markdown cells", () => {
    const text = buildAccountsText({
      accountKey: "qqbot:main|ops",
      sessionKey: "qqbot:main::qq:c2c:abc|123",
      provider: "codex-desktop",
      accountKeys: ["qqbot:main|ops", "weixin:shop"]
    });

    expect(text).toContain("账号状态：");
    expect(text).toContain("qqbot:main\\|ops");
    expect(text).toContain("qqbot:main::qq:c2c:abc\\|123");
  });

  it("formats threads and marks equivalent app-server refs", () => {
    const text = formatThreads(
      [createThread()],
      "codex-app-thread:thread-1:turn-9"
    );

    expect(areThreadRefsEquivalent("codex-app-thread:thread-1:a", "codex-app-thread:thread-1:b"))
      .toBe(true);
    expect(text).toContain("👉🏻 1");
    expect(text).toContain("Bridge \\| Demo");
  });

  it("formats projects and aliases", () => {
    expect(buildProjectsText([createThread()])).toContain("qq-codex-bridge");
    expect(buildProjectAliasesText({
      bridge: {
        cwd: "D:/Project/github/qq-codex-bridge",
        label: "Bridge"
      }
    })).toContain("Configured project aliases:");
    expect(buildUnknownProjectText("missing", { bridge: { cwd: "D:/x" } }))
      .toContain("Available aliases: bridge");
  });
});

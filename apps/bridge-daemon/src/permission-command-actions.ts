import type { CodexPermissionMode } from "../../../packages/domain/src/driver.js";

export type PermissionModeControl = {
  getMode(): CodexPermissionMode;
  setMode(mode: CodexPermissionMode): Promise<void>;
};

export class PermissionCommandActions {
  constructor(private readonly control: PermissionModeControl | null) {}

  buildCurrentText(): string {
    if (!this.control) {
      return "当前 Codex transport 不支持动态权限模式。";
    }

    const mode = this.control.getMode();
    return [
      `当前 Codex 权限模式：${formatPermissionMode(mode)}`,
      "",
      "可用模式：",
      "- full：完全访问，不请求人工批准（默认）",
      "- reviewed：工作区权限，越权操作交给自动审核",
      "- workspace：仅工作区权限，越权操作直接拒绝",
      "",
      "切换命令：/permission <full|reviewed|workspace>"
    ].join("\n");
  }

  async switchMode(mode: CodexPermissionMode): Promise<string> {
    if (!this.control) {
      return "当前 Codex transport 不支持动态权限模式。";
    }

    await this.control.setMode(mode);
    return `Codex 权限模式已切换为：${formatPermissionMode(mode)}。后续任务立即生效。`;
  }
}

function formatPermissionMode(mode: CodexPermissionMode): string {
  switch (mode) {
    case "full":
      return "完全访问（full）";
    case "reviewed":
      return "自动审核（reviewed）";
    case "workspace":
      return "工作区限制（workspace）";
  }
}

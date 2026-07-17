export type DriverBinding = {
  sessionKey: string;
  codexThreadRef: string | null;
};

export const CODEX_PERMISSION_MODES = ["full", "reviewed", "workspace"] as const;

export type CodexPermissionMode = (typeof CODEX_PERMISSION_MODES)[number];

export type CodexThreadSummary = {
  index: number;
  title: string;
  projectName: string | null;
  relativeTime: string | null;
  isCurrent: boolean;
  threadRef: string;
};

export type CodexControlState = {
  threadRef?: string | null;
  threadTitle?: string | null;
  threadProjectName?: string | null;
  threadRelativeTime?: string | null;
  model: string | null;
  reasoningEffort: string | null;
  workspace: string | null;
  branch: string | null;
  permissionMode: string | null;
  quotaSummary: string | null;
};

export class DesktopDriverError extends Error {
  constructor(
    message: string,
    readonly reason:
      | "app_not_ready"
      | "session_not_found"
      | "input_not_found"
      | "submit_failed"
      | "reply_timeout"
      | "turn_cancelled"
      | "context_length_exceeded"
      | "service_error"
      | "reply_parse_failed"
      | "control_not_found"
  ) {
    super(message);
  }
}

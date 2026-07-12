import type { CodexThreadSummary } from "../../../packages/domain/src/driver.js";
import type { ConversationProviderKind } from "../../../packages/domain/src/session.js";
import type { AppConfig } from "./config.js";

export function formatThreads(
  threads: Array<{
    index: number;
    title: string;
    projectName: string | null;
    relativeTime: string | null;
    isCurrent: boolean;
    threadRef?: string;
  }>,
  boundThreadRef: string | null = null
): string {
  if (threads.length === 0) {
    return "当前没有可用的 Codex 线程。";
  }

  return [
    "最近 20 条最近有消息活动的 Codex 线程：",
    "",
    "| 序号 | 项目 | 线程标题 | 最近活动 |",
    "| --- | --- | --- | --- |",
    ...threads.map((thread) => {
      const isBound = Boolean(
        boundThreadRef
        && thread.threadRef
        && areThreadRefsEquivalent(thread.threadRef, boundThreadRef)
      );
      const shouldMark = boundThreadRef ? isBound : thread.isCurrent;
      const index = shouldMark ? `👉🏻 ${thread.index}` : `${thread.index}`;
      const project = escapeMarkdownCell(thread.projectName ?? "") || "-";
      const title = escapeMarkdownCell(thread.title) || "-";
      const time = escapeMarkdownCell(thread.relativeTime ?? "") || "-";
      return `| ${index} | ${project} | ${title} | ${time} |`;
    })
  ].join("\n");
}

export function buildHelpText(provider: ConversationProviderKind = "codex-desktop"): string {
  if (provider === "chatgpt-desktop") {
    return [
      "快捷命令（当前源：ChatGPT Desktop）：",
      "",
      "| 用途 | 完整命令 | 简写 |",
      "| --- | --- | --- |",
      "| 查看 ChatGPT 最近对话 | `/threads` | `/t` |",
      "| 查看当前绑定 ChatGPT 对话 | `/thread current` | `/tc` |",
      "| 切换 ChatGPT 对话 | `/thread use <序号>` | `/tu <序号>` |",
      "| 新建 ChatGPT 对话 | `/thread new <标题>` | `/tn <标题>` |",
      "| 查看当前对话源 | `/source` | - |",
      "| 查看账号状态 | `/accounts` | - |",
      "| 切换到 Codex Desktop | `/source codex` | - |",
      "| 查看任务/投递状态 | `/tasks`、`/deliveries` | - |",
      "| 取消当前任务 | `/cancel` | - |",
      "| 查看/切换 ChatGPT 对话 | `/cgpt`、`/cgpt use <序号>` | - |",
      "| 新建 ChatGPT 对话 | `/cgpt new` | - |",
      "| 查看帮助 | `/help` | `/h` |",
      "",
      "建议先发 `/t` 刷新并查看 ChatGPT 对话列表，再用 `/tu 2` 切换。",
      "模型、额度、状态和真正的 fork 命令目前只适用于 Codex Desktop。"
    ].join("\n");
  }

  return [
    "快捷命令（当前源：Codex Desktop）：",
    "",
    "| 用途 | 完整命令 | 简写 |",
    "| --- | --- | --- |",
    "| 查看 Codex 最近线程 | `/threads` | `/t` |",
    "| 查看当前绑定 Codex 线程 | `/thread current` | `/tc` |",
    "| 切换 Codex 线程 | `/thread use <序号>` | `/tu <序号>` |",
    "| 新建 Codex 线程 | `/thread new <标题>` | `/tn <标题>` |",
    "| 基于最近对话 fork Codex 线程 | `/thread fork <标题>` | `/tf <标题>` |",
    "| 查看当前模型 | `/model` | `/m` |",
    "| 切换模型 | `/model use <名称>` | `/mu <名称>` |",
    "| 查看额度信息 | `/quota` | `/q` |",
    "| 查看当前运行状态 | `/status` | `/st` |",
    "| 调用 Codex 代码审查 | `/代码审查` | - |",
    "| 查看当前对话源 | `/source` | - |",
    "| 查看账号状态 | `/accounts` | - |",
    "| 查看任务/投递状态 | `/tasks`、`/deliveries` | - |",
    "| 取消当前任务 | `/cancel` | - |",
    "| 查看项目/别名 | `/projects`、`/aliases` | - |",
    "| 按项目新建 Codex 线程 | `/new <别名> <任务>` | - |",
    "| 查看/切换 ChatGPT 对话 | `/cgpt`、`/cgpt use <序号>` | - |",
    "| 新建 ChatGPT 对话 | `/cgpt new` | - |",
    "| 查看帮助 | `/help` | `/h` |",
    "| 切换到 ChatGPT Desktop | `/source chatgpt` | - |",
    "| 切换到 Codex Desktop | `/source codex` | - |",
    "",
    "所有 `/` 开头的桥接快捷指令都会先由桥接层处理，不会直接发给 Codex。",
    "建议先用 `/source` 确认当前对话源，再发 `/t` 看列表，用 `/tu 2` 切换。",
    "切到 ChatGPT 后，这套 `/t`、`/tu`、`/tn` 会自动操作 ChatGPT 对话。"
  ].join("\n");
}

export function buildUnknownCommandText(
  text: string,
  provider: ConversationProviderKind
): string {
  return [
    `未识别的桥接快捷指令：\`${text}\``,
    "这条 `/` 指令不会转发给当前对话源。",
    "",
    buildHelpText(provider)
  ].join("\n");
}

export function buildAccountsText(input: {
  accountKey: string;
  sessionKey: string;
  provider: ConversationProviderKind;
  accountKeys: string[];
}): string {
  const accountKeys = [...new Set(input.accountKeys)].sort();
  return [
    "账号状态：",
    "",
    "| 项目 | 值 |",
    "| --- | --- |",
    `| 当前账号 | ${escapeMarkdownCell(input.accountKey)} |`,
    `| 当前来源 | ${input.accountKey.startsWith("weixin:") ? "微信" : "QQ"} |`,
    `| 当前会话 | ${escapeMarkdownCell(input.sessionKey)} |`,
    `| 当前对话源 | ${input.provider} |`,
    `| 已接入账号 | ${accountKeys.map(escapeMarkdownCell).join(", ")} |`
  ].join("\n");
}

export function buildProjectsText(threads: CodexThreadSummary[]): string {
  const projects = new Map<string, { count: number; latestThread: string; relativeTime: string | null }>();
  for (const thread of threads) {
    const name = thread.projectName?.trim();
    if (!name) {
      continue;
    }
    const existing = projects.get(name);
    if (existing) {
      existing.count += 1;
      continue;
    }
    projects.set(name, {
      count: 1,
      latestThread: thread.title,
      relativeTime: thread.relativeTime
    });
  }

  const entries = [...projects.entries()].sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) {
    return [
      "No Codex Desktop projects found in recent threads.",
      "Use /threads to inspect the current Codex thread list.",
      "Use /aliases to inspect configured cwd aliases for /new <alias> <task>."
    ].join("\n");
  }

  return [
    "Codex Desktop projects from recent threads:",
    "",
    "| Project | Threads | Latest thread | Activity |",
    "| --- | ---: | --- | --- |",
    ...entries.map(([projectName, project]) =>
      `| ${escapeMarkdownCell(projectName)} | ${project.count} | ${escapeMarkdownCell(project.latestThread)} | ${escapeMarkdownCell(project.relativeTime ?? "-")} |`
    ),
    "",
    "Note: /new <alias> <task> uses /aliases, not this recent-project display list."
  ].join("\n");
}

export function buildProjectAliasesText(projectAliases: AppConfig["projectAliases"] = {}): string {
  const entries = Object.entries(projectAliases).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  if (entries.length === 0) {
    return [
      "No project aliases configured.",
      "Configure projectAliases in runtime config or QQ_CODEX_PROJECT_ALIASES_JSON.",
      "Then use /new <alias> <task> to create a Codex thread in that cwd."
    ].join("\n");
  }

  return [
    "Configured project aliases:",
    "",
    "| Alias | Label | cwd |",
    "| --- | --- | --- |",
    ...entries.map(([alias, project]) =>
      `| ${escapeMarkdownCell(alias)} | ${escapeMarkdownCell(project.label ?? "-")} | ${escapeMarkdownCell(project.cwd)} |`
    ),
    "",
    "Use /new <alias> <task> to create a Codex thread in the alias cwd."
  ].join("\n");
}

export function buildUnknownProjectText(
  alias: string,
  projectAliases: AppConfig["projectAliases"] = {}
): string {
  const names = Object.keys(projectAliases).sort();
  return [
    `Unknown project alias: ${alias}`,
    names.length > 0 ? `Available aliases: ${names.join(", ")}` : "No project aliases configured.",
    "Use /aliases to inspect configured aliases."
  ].join("\n");
}

export function areThreadRefsEquivalent(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }

  const leftAppThreadId = extractAppServerThreadId(left);
  const rightAppThreadId = extractAppServerThreadId(right);
  return Boolean(leftAppThreadId && rightAppThreadId && leftAppThreadId === rightAppThreadId);
}

function extractAppServerThreadId(threadRef: string): string | null {
  const prefix = "codex-app-thread:";
  if (!threadRef.startsWith(prefix)) {
    return null;
  }

  const payload = threadRef.slice(prefix.length);
  const separatorIndex = payload.indexOf(":");
  const threadId = separatorIndex >= 0 ? payload.slice(0, separatorIndex) : payload;
  return threadId.trim() ? threadId : null;
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
}

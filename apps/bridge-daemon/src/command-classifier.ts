export type ThreadCommandRoute =
  | { kind: "not-command" }
  | { kind: "unknown"; text: string }
  | { kind: "cancel"; taskId: string | null }
  | { kind: "task-query"; query: "current" | "recent" }
  | { kind: "delivery-query" }
  | { kind: "threads" }
  | { kind: "thread-current" }
  | { kind: "source-switch"; sourceTarget: "codex" | "chatgpt" }
  | { kind: "source-current" }
  | { kind: "accounts" }
  | { kind: "projects" }
  | { kind: "aliases" }
  | { kind: "chatgpt-threads" }
  | { kind: "chatgpt-use"; index: number }
  | { kind: "chatgpt-new" }
  | { kind: "help" }
  | { kind: "model-current" }
  | { kind: "model-switch"; targetModel: string }
  | { kind: "quota" }
  | { kind: "status" }
  | { kind: "code-review" }
  | { kind: "thread-use"; index: number }
  | { kind: "thread-new"; title: string }
  | { kind: "project-new"; alias: string; task: string }
  | { kind: "thread-fork"; title: string };

export function isSupportedCommand(text: string): boolean {
  const route = routeThreadCommand(text);
  return route.kind !== "not-command" && route.kind !== "unknown";
}

export function isCancelCommand(text: string): boolean {
  return (
    text === "/cancel" ||
    /^\/cancel\s+\S+$/.test(text) ||
    /^(?:停止任务|取消任务|停止当前任务|取消当前任务)(?:\s+\S+)?$/.test(text)
  );
}

export function getCancelCommandTaskId(text: string): string | null {
  return text.match(/^\/cancel\s+(\S+)$/)?.[1]
    ?? text.match(/^(?:停止任务|取消任务|停止当前任务|取消当前任务)\s+(\S+)$/)?.[1]
    ?? null;
}

export function isTaskQueryCommand(text: string): boolean {
  return routeThreadCommand(text).kind === "task-query";
}

export function isDeliveryQueryCommand(text: string): boolean {
  return routeThreadCommand(text).kind === "delivery-query";
}

export function routeThreadCommand(text: string): ThreadCommandRoute {
  if (isCancelCommand(text)) {
    return { kind: "cancel", taskId: getCancelCommandTaskId(text) };
  }

  if (!text.startsWith("/")) {
    return { kind: "not-command" };
  }

  if (text === "/task current") {
    return { kind: "task-query", query: "current" };
  }
  if (text === "/tasks") {
    return { kind: "task-query", query: "recent" };
  }
  if (text === "/deliveries" || text === "/delivery jobs") {
    return { kind: "delivery-query" };
  }
  if (text === "/threads" || text === "/t") {
    return { kind: "threads" };
  }
  if (text === "/thread current" || text === "/tc") {
    return { kind: "thread-current" };
  }

  const sourceTarget = matchSourceCommand(text);
  if (sourceTarget) {
    return { kind: "source-switch", sourceTarget };
  }
  if (text === "/source") {
    return { kind: "source-current" };
  }
  if (text === "/accounts") {
    return { kind: "accounts" };
  }
  if (text === "/projects") {
    return { kind: "projects" };
  }
  if (text === "/aliases") {
    return { kind: "aliases" };
  }
  if (text === "/cgpt" || text === "/cgpt threads") {
    return { kind: "chatgpt-threads" };
  }

  const chatgptUseIndex = matchChatgptUseCommand(text);
  if (chatgptUseIndex !== null) {
    return { kind: "chatgpt-use", index: chatgptUseIndex };
  }
  if (text === "/cgpt new") {
    return { kind: "chatgpt-new" };
  }
  if (text === "/help" || text === "/h" || text === "/thread") {
    return { kind: "help" };
  }
  if (text === "/model" || text === "/m") {
    return { kind: "model-current" };
  }

  const targetModel = matchSwitchModelCommand(text);
  if (targetModel) {
    return { kind: "model-switch", targetModel };
  }
  if (text === "/quota" || text === "/q") {
    return { kind: "quota" };
  }
  if (text === "/status" || text === "/st") {
    return { kind: "status" };
  }
  if (text === "/代码审查") {
    return { kind: "code-review" };
  }

  const threadUseIndex = matchUseThreadCommand(text);
  if (threadUseIndex !== null) {
    return { kind: "thread-use", index: threadUseIndex };
  }

  const newThreadTitle = matchNewThreadCommand(text);
  if (newThreadTitle) {
    return { kind: "thread-new", title: newThreadTitle };
  }

  const projectNew = matchNewProjectCommand(text);
  if (projectNew) {
    return { kind: "project-new", alias: projectNew.alias, task: projectNew.task };
  }

  const forkTitle = matchForkThreadCommand(text);
  if (forkTitle) {
    return { kind: "thread-fork", title: forkTitle };
  }

  return { kind: "unknown", text };
}

export function matchSourceCommand(text: string): "codex" | "chatgpt" | null {
  const match = text.match(/^\/source\s+(codex|chatgpt)$/);
  return match ? match[1] as "codex" | "chatgpt" : null;
}

export function matchChatgptUseCommand(text: string): number | null {
  return numberMatch(text, /^\/cgpt\s+use\s+(\d+)$/);
}

export function matchSwitchModelCommand(text: string): string | null {
  return stringMatch(text, /^(?:\/model\s+use|\/mu)\s+(.+)$/);
}

export function matchUseThreadCommand(text: string): number | null {
  return numberMatch(text, /^(?:\/thread\s+use|\/tu)\s+(\d+)$/);
}

export function matchNewThreadCommand(text: string): string | null {
  return stringMatch(text, /^(?:\/thread\s+new|\/tn)\s+(.+)$/);
}

export function matchNewProjectCommand(text: string): {
  alias: string;
  task: string;
} | null {
  const match = text.match(/^\/new\s+(\S+)\s+([\s\S]+)$/);
  if (!match) {
    return null;
  }
  return {
    alias: match[1].trim(),
    task: match[2].trim()
  };
}

export function matchForkThreadCommand(text: string): string | null {
  return stringMatch(text, /^(?:\/thread\s+fork|\/tf)\s+(.+)$/);
}

function numberMatch(text: string, pattern: RegExp): number | null {
  const match = text.match(pattern);
  return match ? Number(match[1]) : null;
}

function stringMatch(text: string, pattern: RegExp): string | null {
  return text.match(pattern)?.[1].trim() ?? null;
}

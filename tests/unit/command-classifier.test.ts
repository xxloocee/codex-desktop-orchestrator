import { describe, expect, it } from "vitest";
import {
  getCancelCommandTaskId,
  isCancelCommand,
  isDeliveryQueryCommand,
  isSupportedCommand,
  isTaskQueryCommand,
  matchChatgptUseCommand,
  matchForkThreadCommand,
    matchNewProjectCommand,
    matchNewThreadCommand,
    matchRetryCommand,
  matchSourceCommand,
  matchSwitchModelCommand,
  matchUseThreadCommand,
  routeThreadCommand
} from "../../apps/bridge-daemon/src/command-classifier.js";

describe("command classifier", () => {
  it("classifies fixed command groups", () => {
    expect(isSupportedCommand("/threads")).toBe(true);
    expect(isSupportedCommand("/wat")).toBe(false);
    expect(isTaskQueryCommand("/task current")).toBe(true);
    expect(isDeliveryQueryCommand("/delivery jobs")).toBe(true);
  });

  it("classifies cancel commands and task ids", () => {
    expect(isCancelCommand("取消当前任务")).toBe(true);
    expect(getCancelCommandTaskId("/cancel bridge-turn-1")).toBe("bridge-turn-1");
    expect(getCancelCommandTaskId("停止任务 bridge-turn-2")).toBe("bridge-turn-2");
    expect(getCancelCommandTaskId("/cancel")).toBeNull();
  });

  it("extracts command payloads", () => {
    expect(matchSourceCommand("/source chatgpt")).toBe("chatgpt");
    expect(matchChatgptUseCommand("/cgpt use 3")).toBe(3);
    expect(matchSwitchModelCommand("/mu GPT-5")).toBe("GPT-5");
    expect(matchUseThreadCommand("/tu 2")).toBe(2);
    expect(matchNewThreadCommand("/tn My thread")).toBe("My thread");
    expect(matchRetryCommand("/retry bridge-turn-1")).toBe("bridge-turn-1");
    expect(matchForkThreadCommand("/tf Forked")).toBe("Forked");
    expect(matchNewProjectCommand("/new bridge fix bug")).toEqual({
      alias: "bridge",
      task: "fix bug"
    });
  });

  it("routes commands with payloads", () => {
    expect(routeThreadCommand("hello")).toEqual({ kind: "not-command" });
    expect(routeThreadCommand("/wat")).toEqual({ kind: "unknown", text: "/wat" });
    expect(routeThreadCommand("/thread")).toEqual({ kind: "help" });
    expect(routeThreadCommand("/source codex")).toEqual({
      kind: "source-switch",
      sourceTarget: "codex"
    });
    expect(routeThreadCommand("/cgpt use 2")).toEqual({
      kind: "chatgpt-use",
      index: 2
    });
    expect(routeThreadCommand("/new bridge fix bug")).toEqual({
      kind: "project-new",
      alias: "bridge",
      task: "fix bug"
    });
    expect(routeThreadCommand("取消任务 turn-1")).toEqual({
      kind: "cancel",
      taskId: "turn-1"
    });
    expect(routeThreadCommand("/retry turn-2")).toEqual({
      kind: "retry",
      taskId: "turn-2"
    });
  });
});

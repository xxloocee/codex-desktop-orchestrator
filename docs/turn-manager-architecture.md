# Turn Manager 架构

Turn Manager 是一次 Codex turn 的控制面。它负责决定一个 turn 如何在系统里推进；具体执行仍交给 adapter、driver、store 和 delivery worker。

## 范围

Turn Manager 负责：

- Turn 生命周期：`queued`、`running`、`tool-running`、`streaming`、`completed`、`failed`、`timed-out`、`cancelled`、`orphaned`。
- 调度：session 队列、Codex thread 锁，以及可选的 desktop 全局锁。
- 事件归一：用户输入、Codex delta、工具事件、完成、取消、超时、投递结果和重启恢复。
- 状态协调：bridge turn id、Codex turn id、session/thread 绑定、原始消息 id、时间戳、最后事件/工具/错误，以及已投递输出进度。
- 控制动作：当前任务、最近任务、取消和基于原始入站消息创建新 turn 的重试。
- 超时：为 running turn 写入 `deadlineAt`，到达硬 deadline 后标记 `timed-out`。
- 恢复：把遗留 active work 标记为 `timed-out` 或 `orphaned`，然后释放本地锁。

Turn Manager 不应该负责：

- QQ/微信 API 细节。
- Codex app-server JSON-RPC 细节。
- SQLite SQL。
- DOM 自动化细节。
- 媒体上传/下载内部逻辑。

这些能力都应该留在端口之后。

## 边界

```text
Ingress Adapter
  -> Command Router
  -> Turn Manager
      -> Turn Scheduler
      -> Turn Lifecycle
      -> Turn Event Reducer
      -> Turn Output Tracker
      -> Turn Control
      -> Turn Delivery Coordinator
      -> Recovery Controller
  -> Conversation Provider / Codex Driver
  -> Delivery Worker
```

推荐端口：

- `TurnStore`：持久化和查询 turn 记录。
- `SessionStore`：维护 session 绑定和 session 锁。
- `ThreadLockStore`：按 Codex thread 串行化 active work。
- `ConversationProvider`：发送用户消息并收集 Codex 输出。
- `DeliveryService`：投递用户可见 draft，并记录投递状态。
- `Notifier`：发出控制/状态消息。

## 状态机

允许的状态转换应该显式定义：

```text
queued -> running
queued -> cancelled
running -> tool-running
running -> streaming
running -> failed | timed-out | cancelled
tool-running -> streaming | failed | timed-out | cancelled
streaming -> completed | failed | timed-out | cancelled
active -> orphaned on daemon restart
terminal -> terminal events are ignored
```

终态不能被迟到的 Codex 事件覆盖。

## 事件归一

每个外部信号都应该归一成一个小的内部动作：

| 信号 | Turn 影响 |
| --- | --- |
| 用户消息已接受 | 创建 `queued` turn |
| 调度器开始执行 | 标记为 `running` |
| Codex 工具事件 | 标记为 `tool-running`，更新最后工具 |
| Codex assistant delta | 标记为 `streaming`，刷新待发送输出 |
| Codex 正常完成 | 标记为 `completed`，刷新最终输出 |
| Codex 异常完成 | 归类为 `failed`、`timed-out` 或 `cancelled` |
| 用户取消 | interrupt driver，标记为 `cancelled`，抑制迟到输出 |
| 工具沉默超时 | interrupt driver，标记为 `timed-out` |
| Turn 硬超时 | 标记为 `timed-out`，释放本地调度流程，抑制迟到输出 |
| daemon 重启 | 把 active turn 标记为 `timed-out` 或 `orphaned` |
| 投递失败 | 保持 turn 状态，进入投递队列/重试 |

## 实施方向

当前代码已经具备大部分行为，但分散在 `BridgeOrchestrator`、driver callback、store 和 command handling 中。按小步、保持行为不变的方式拆分：

1. `TurnScheduler`：session 队列助手，已抽出。
2. `TurnOutputTracker`：assembled/sent 输出状态与重复抑制，已抽出。
3. `TurnEventReducer`：把 `TurnEvent` payload 映射为 bridge 状态，已抽出。
4. `TurnLifecycle`：状态转换助手、取消检查和 recoverable 错误分类，已抽出。
5. 薄 `TurnManager`：编排这些组件，但不吞掉 adapter 或 SQL，已抽出。
6. `TurnDeliveryCoordinator`：集中处理 turn draft 投递、投递结果记录和 delivered text 记账，已抽出。
7. 硬 turn deadline：通过 `QQ_CODEX_TURN_TIMEOUT_MS` / `runtime.turnTimeoutMs` 配置，已接入。
8. `TurnControl`：集中处理当前任务取消、driver interrupt 和取消结果归类，已抽出。
9. `TurnRecoveryController`：集中处理 daemon 启动恢复和恢复日志摘要，已抽出。
10. `TurnQuery`：集中处理当前任务和最近任务查询展示，已抽出。
11. `DeliveryQuery`：集中处理投递队列查询和 delivery job 展示，已抽出。
12. `CommandPresenter`：集中处理帮助、账号状态、线程列表、项目/别名等命令展示，已抽出到命令层。
13. `CommandClassifier`：集中处理命令识别、正则匹配和参数提取，已抽出到命令层。
14. `TurnRetry`：校验失败任务、恢复原始入站消息并创建新的重试消息，已接入 `/retry`。
15. 工具事件历史：`bridge_turn_events` 持久化工具名、状态、摘要和错误，CLI `task` 可查询。
16. Thread lock lease：持久锁不会覆盖未过期 owner，并在长任务期间自动续租。

这样 Turn Manager 是调度中心，不是杂物堆。

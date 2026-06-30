# 可调度 Codex 的 QQ Bot 能力说明

本文记录一个完整的、能够稳定调度 Codex 的 QQ Bot 应具备的能力。它不是单纯把 QQ 消息转发给 Codex，而是要把 Codex 回合、工具调用、长任务、线程绑定和 QQ 回复都纳入可观测、可恢复的调度体系。

## 背景

当前链路更接近单回合桥接：

```text
QQ 消息 -> bridge -> Codex turn -> 等最终回复 -> QQ 回复
```

这条链路适合普通短对话，但遇到 Code Review Skill、长时间 shell 命令、node_repl、文件扫描、测试执行等工具密集任务时，会暴露几个问题：

- bridge 不知道 Codex turn 正在执行哪一步。
- 同一个 QQ 会话会被一个未完成 turn 长时间占住。
- Codex 线程里可能同时出现多个 in-progress turn。
- 工具卡住时，bridge 无法稳定中断、超时、释放锁和回报错误。
- 中间进度无法回传 QQ，用户只看到“断掉了”。
- delivery_jobs 如果只入库不消费，会造成“看起来已排队，实际没发送”的错觉。

因此，目标不是简单增加更多命令，而是补上 Codex turn lifecycle 管理。

## 目标形态

完整形态应该是：

```text
QQ inbound
  -> 创建任务
  -> 选择或创建 Codex thread
  -> 获取 session/thread lock
  -> 启动 Codex turn
  -> 监听模型输出和工具事件
  -> 按需回传进度到 QQ
  -> 完成、失败、超时或取消
  -> 释放锁并落库
```

核心目标：

- QQ 用户可以发起普通对话、代码审查、运行测试、文件分析等复杂任务。
- 长任务有状态、有进度、有超时、有取消能力。
- 同一个 QQ 会话和同一个 Codex thread 不会被并发 turn 搞乱。
- 工具调用失败时，用户能收到明确错误，而不是沉默。
- bridge 重启后可以识别未完成任务，并给出恢复或失败收口。

## 必需能力

### 1. Turn Manager

Turn Manager 是调度核心，负责管理一次 Codex 回合的完整生命周期。

建议状态：

```text
queued
running
tool-running
streaming
completed
failed
timed-out
cancelled
orphaned
```

每个 turn 至少记录：

- `turnId`
- `sessionKey`
- `codexThreadRef`
- `qqMessageId`
- `status`
- `startedAt`
- `updatedAt`
- `deadlineAt`
- `lastEventAt`
- `lastToolName`
- `lastError`
- 已发送到 QQ 的文本范围或 draft id

这样 bridge 才能知道一个任务是“还在跑”、“工具卡住了”、“已经超时”还是“已经完成但回复发送失败”。

### 2. Session 与 Codex Thread 调度

需要区分两个锁：

- QQ session lock：同一个 QQ 私聊或群聊里的消息顺序。
- Codex thread lock：同一个 Codex thread 里是否允许并发 turn。

推荐默认策略：

- 同一个 QQ session 默认串行。
- 同一个 Codex thread 默认只允许一个 active turn。
- 如果用户发起长任务，可以显式创建新 Codex thread，避免阻塞主对话。
- 如果已有 turn 在跑，后续消息进入队列，或者提示用户取消/新开任务。

这能避免同一个 Codex 线程里出现多个 `inProgress` turn，导致上下文和工具状态互相干扰。

### 3. 工具调用事件支持

bridge 不能只等最终回复，还需要理解 Codex app-server 的中间事件。

需要识别并记录：

- 模型开始回复
- 工具调用开始
- 工具调用输出
- 工具调用失败
- 工具调用长时间无输出
- turn completed / failed / interrupted

对 QQ 用户可见的进度可以保持克制，例如：

```text
已开始代码审查，正在读取当前 diff。
正在运行测试：pnpm run check。
任务超过 5 分钟仍在执行，可发送 /cancel 取消。
```

工具事件不是为了把所有日志刷到 QQ，而是为了让 bridge 有能力判断任务是否健康。

### 4. 超时、中断与清理

长任务必须有硬边界。

建议分三层超时：

- request timeout：app-server 单次 JSON-RPC 请求超时。
- turn timeout：一次 Codex turn 的最大执行时间。
- tool silence timeout：工具长时间无输出或无事件。

超时后应执行：

1. interrupt Codex turn。
2. 标记 turn 为 `timed-out`。
3. 释放 QQ session lock 和 Codex thread lock。
4. 给 QQ 返回明确说明。
5. 保留可诊断日志。

不能只依赖进程自然退出。只要锁没有释放，用户就会感知为“Bot 死了”。

### 5. 取消与恢复命令

QQ 侧至少需要这些控制命令：

```text
/tasks              查看当前会话任务
/task current       查看当前任务状态
/cancel             取消当前任务
/cancel <taskId>    取消指定任务
/retry <taskId>     重试失败任务
/new <alias> <task> 在指定项目中新建 Codex thread 并启动任务
```

取消命令应能打断正在执行的 Codex turn，并清理本地锁。重试命令应新建 turn，不要复用已经状态不明的 pending turn。

### 6. Delivery Worker

如果系统保留 `delivery_jobs`，就必须有真正的消费器。

Delivery Worker 负责：

- 从 pending 队列取出待发送 draft。
- 调用 QQ egress。
- 成功后标记 delivered。
- 失败后按策略重试。
- 超过次数后标记 failed 并记录错误。

如果当前发送是同步完成的，就不要把它伪装成持久化队列。否则排查时会误以为消息还在等待发送。

### 7. 可观测性

至少需要三类日志：

- runtime log：daemon 启停、gateway 连接、管理命令。
- turn log：turn 状态变化、超时、中断、完成。
- tool log：工具名、开始时间、结束时间、退出状态、摘要输出。

管理命令建议补充：

```text
pnpm start -- status
pnpm start -- tasks
pnpm start -- task <taskId>
pnpm start -- logs <n>
```

这能让本地排障不再依赖手动查 SQLite 和进程树。

## 建议架构

```text
QQ Gateway
    |
    v
Ingress Handler
    |
    v
Command Router -----> Task Control Commands
    |
    v
Turn Manager
    |        \
    |         -> Session Lock Store
    |         -> Thread Lock Store
    |         -> Turn State Store
    |
    v
Codex App-Server Driver
    |
    v
Codex Thread / Tool Calls
    |
    v
Turn Events
    |
    v
Draft Formatter -> Delivery Worker -> QQ Egress
```

模块边界：

- `Ingress Handler` 只负责接收和标准化 QQ 消息。
- `Command Router` 只处理桥接控制命令。
- `Turn Manager` 负责任务状态、锁、超时和恢复。
- `Codex App-Server Driver` 负责和 Codex 通信，不决定 QQ 发送策略。
- `Delivery Worker` 负责可靠发送，不决定 Codex 调度。

## 分阶段落地

### Phase 1：先补 Turn Manager

目标是让任务不再沉默卡死。

- 新增 turn 状态表。
- 将当前 `runTurn` 包进 turn lifecycle。
- 记录 queued/running/completed/failed/timed-out。
- 超时后释放 session lock。
- 增加 `/task current` 和 `/cancel`。

### Phase 2：补 Codex thread 并发保护

目标是避免同一 Codex thread 多个 turn 同时 in-progress。

- 新增 thread lock。
- 发送前检查目标 thread 是否已有 active turn。
- 支持排队、拒绝或新建 thread。
- QQ 返回明确提示。

### Phase 3：接入工具事件和进度回传

目标是让长任务有可见进度。

- 监听 app-server turn events。
- 记录工具开始、输出、结束。
- 对长时间任务发送节流后的进度消息。
- 增加 tool silence timeout。

### Phase 4：补可靠出站队列

目标是让 `delivery_jobs` 真正可用。

- 实现 Delivery Worker。
- 支持重试、失败标记和恢复。
- 管理命令可查看 pending/failed jobs。

### Phase 5：恢复与巡检

目标是 daemon 重启后能处理历史异常状态。

- 启动时扫描 orphaned turns。
- 对过期 running turn 标记 orphaned 或 timed-out。
- 清理过期锁。
- 输出 doctor 报告。

## 验证标准

至少覆盖这些场景：

- 普通 QQ 短对话能正常完成。
- Code Review Skill 长任务执行期间，QQ 能看到任务状态。
- 同一个 QQ 会话连续发两条消息时，第二条不会打乱第一条 turn。
- 同一个 Codex thread 已有 active turn 时，新消息会排队或提示。
- 工具调用卡住超过阈值后，turn 会 timed-out，锁会释放。
- `/cancel` 能中断当前任务并释放锁。
- daemon 重启后，旧的 running turn 不会永久占锁。
- delivery job 失败后会重试，最终 delivered 或 failed。

## 非目标

第一阶段不需要做完整多 Agent 系统，也不需要让 QQ 用户直接操作所有 Codex 内部工具。

当前更重要的是把“单回合黑盒桥接”升级为“可调度、可观测、可恢复的 Codex 任务系统”。等这层稳定后，再扩展多 Agent、复杂任务编排和自动代码审查流水线，才不会一跑工具就把整条会话拖死。

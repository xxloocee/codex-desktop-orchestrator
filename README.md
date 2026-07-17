# codex-desktop-orchestrator

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-10-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)

> Orchestrate and command Codex Desktop from QQ and WeChat, with room for Lark, Telegram, and other chat adapters.

**codex-desktop-orchestrator** 是一个本地 Codex Desktop 调度桥接服务。它让你通过 QQ、微信等聊天入口指挥本机 Codex Desktop 执行代码审查、项目分析、测试运行、文件处理和长任务协作。

当前包名、主 CLI、runtime 默认目录和文档示例均统一使用 `codex-desktop-orchestrator`。`QQ_CODEX_*` 环境变量表示 QQ 与 Codex 的配置域，仍作为当前配置前缀保留。

![codex-desktop-orchestrator README Hero](./output/readme-hero-nanobanana-productized-v1.png)

## 核心定位

这个项目不是普通聊天机器人。它的核心目标是：

```text
聊天平台消息
  -> 本地 bridge / daemon
  -> 调度 Codex Desktop 线程和任务
  -> 指挥 Codex 执行开发工作
  -> 将结果、进度和媒体回传到聊天平台
```

换句话说，它要把 Codex Desktop 变成一个可以被聊天平台远程调度的本地开发助手。

## 当前支持情况

| 平台 | 当前状态 | 说明 |
| --- | --- | --- |
| QQ | 已支持 | 官方 QQ Bot WebSocket 入站，支持私聊、群聊、媒体、语音转写、线程命令 |
| 微信 | 已支持文本通道 | 内置微信 long-poll 文本网关，当前主打文本收发 |
| 飞书 | 规划中 | 适合后续作为企业协作入口 |
| Telegram | 规划中 | 适合跨设备、跨网络的轻量远程指挥 |

Codex 侧当前以 **Codex app-server** 为默认链路，不再要求 Codex Desktop 必须通过 `9229` CDP 端口启动。只有启用旧 DOM/CDP 模式或显式转发 UI 事件时，才需要 Desktop CDP readiness。

ChatGPT Desktop 相关 adapter 与本地 CLI 代码作为历史遗留的可选 provider 保留，用于兼容已有实验链路；它不是当前项目的主定位，主线仍是通过聊天平台调度和指挥 Codex Desktop。

## 能做什么

### 在 QQ 里指挥 Codex 干活

你可以直接在 QQ 中让 Codex 审查当前项目、分析代码、运行检查、总结文档或处理文件。每个 QQ 会话会绑定到一个 Codex 线程，避免不同上下文互相污染。

### 管理 Codex Desktop 线程

私聊中可以查看、切换、新建或 fork Codex 线程：

| 用途 | 命令 | 简写 |
| --- | --- | --- |
| 查看最近 Codex 线程 | `/threads` | `/t` |
| 查看当前绑定线程 | `/thread current` | `/tc` |
| 切换线程 | `/thread use <序号>` | `/tu <序号>` |
| 新建线程 | `/thread new <标题>` | `/tn <标题>` |
| fork 线程 | `/thread fork <标题>` | `/tf <标题>` |

### 按项目别名启动任务

项目别名用于把聊天命令路由到指定本地目录：

```text
/projects
/aliases
/new <alias> <task>
```

例如：

```text
/new codex-desktop-orchestrator 使用 Code Review skill 审查当前未提交更改
```

### 查看 Codex 状态

| 用途 | 命令 | 简写 |
| --- | --- | --- |
| 查看当前模型 | `/model` | `/m` |
| 切换模型 | `/model use <名称>` | `/mu <名称>` |
| 查看额度信息 | `/quota` | `/q` |
| 查看当前运行状态 | `/status` | `/st` |
| 查看权限模式 | `/permission` | `/pm` |
| 切换权限模式 | `/permission <full|reviewed|workspace>` | `/pm <模式>` |
| 查看帮助 | `/help` | `/h` |

权限模式默认是 `full`，用于无人值守的远程控制：

- `full`：完全访问，不等待桌面人工审批。
- `reviewed`：限制在工作区内，越权操作交给 Codex 自动审核。
- `workspace`：限制在工作区内，网络、工作区外写入等越权操作直接失败。

权限切换会写入 runtime config，并从下一条 Codex 任务开始生效。
只有 `accessControl.permissionAdminSenderIds` 中显式配置的私聊用户可以切换；
群聊和其他普通授权用户只能查询当前模式。也可以通过环境变量配置：

```env
QQ_CODEX_PERMISSION_ADMIN_SENDERS=你的QQ用户OpenID
```

### 管理长任务

| 用途 | 命令 |
| --- | --- |
| 查看当前任务 | `/task current` |
| 查看最近任务 | `/tasks` |
| 取消当前或指定任务 | `/cancel [taskId]` |
| 重试失败、超时或 orphaned 任务 | `/retry <taskId>` |
| 查看失败或待重试投递 | `/deliveries` |

### 媒体、语音和文件

QQ 通道当前支持：

- 图片、语音、视频、文件下载并注入给 Codex
- QQ 内置 ASR、OpenAI 兼容 STT、火山引擎 STT、本地 whisper.cpp
- Codex 回复中的本地图片/文件引用回传到 QQ
- 文本、Markdown、代码块和表格尽量保持结构化输出

### 多账号和访问控制

当前支持：

- 多 QQ Bot / 多账号接入
- 多微信账号配置
- 私聊、群聊、群成员、mention 规则过滤
- 默认启用 `deny-by-default`；只有显式 allowlist 中的来源可以调度本机 Codex

## 快速开始

### 1. 安装依赖

```bash
pnpm install
```

### 2. 生成配置

源码开发模式下：

```bash
pnpm run build
pnpm start -- init
```

如果以后发布为 npm 包，则可以使用：

```bash
npx codex-desktop-orchestrator init
```

### 3. 填写 QQ Bot 凭据

编辑 `.env`：

```env
QQBOT_APP_ID=你的AppID
QQBOT_CLIENT_SECRET=你的ClientSecret
QQ_CODEX_ALLOWED_C2C_SENDERS=你的QQ用户OpenID
QQ_CODEX_PERMISSION_ADMIN_SENDERS=你的QQ用户OpenID
```

QQ Bot 可以在 [QQ 开放平台](https://q.qq.com/qqbot/openclaw/index.html) 创建并获取 AppID / AppSecret。
默认访问控制为 `deny-by-default`；如果不配置 allowlist，bridge 会启动，但不会接受聊天侧任务。

### 4. 构建并启动

```bash
pnpm run build
pnpm start
```

常用运行时命令：

```bash
pnpm start -- status
pnpm start -- doctor
pnpm start -- logs 200
pnpm start -- tasks 20
pnpm start -- task <taskId>
pnpm start -- deliveries 20
pnpm start -- stop
pnpm start -- restart
```

默认 turn 硬超时为 30 分钟，工具连续 5 分钟无事件会被中断。可通过
`QQ_CODEX_TURN_TIMEOUT_MS` 和 `CODEX_TOOL_SILENCE_TIMEOUT_MS` 调整。

本地 smoke 测试时可以禁用 QQ gateway：

```powershell
$env:QQ_CODEX_DISABLE_QQ_GATEWAY='1'
pnpm start
```

## 配置示例

### 多 QQ Bot

```env
QQBOTS_JSON=[{"accountId":"main","appId":"AppID1","clientSecret":"Secret1","markdownSupport":false},{"accountId":"shop","appId":"AppID2","clientSecret":"Secret2","markdownSupport":false}]
```

也可以使用 ID 列表加分账号变量：

```env
QQBOT_ACCOUNT_IDS=main,shop
QQBOT_MAIN_APP_ID=AppID1
QQBOT_MAIN_CLIENT_SECRET=Secret1
QQBOT_SHOP_APP_ID=AppID2
QQBOT_SHOP_CLIENT_SECRET=Secret2
```

### 项目别名

```env
QQ_CODEX_PROJECT_ALIASES_JSON={"codex-desktop-orchestrator":{"cwd":"D:/Project/github/codex-desktop-orchestrator","label":"Codex Desktop Orchestrator"}}
```

配置后可在 QQ 中使用：

```text
/aliases
/new codex-desktop-orchestrator 修复当前 TypeScript 类型错误
```

### 访问控制

默认使用 `deny-by-default`。至少配置一个允许的私聊发送者、群或群成员：

```env
QQ_CODEX_ALLOWED_C2C_SENDERS=OPENID1,OPENID2
QQ_CODEX_PERMISSION_ADMIN_SENDERS=OPENID1
QQ_CODEX_ALLOWED_GROUPS=GROUP_OPENID1
QQ_CODEX_GROUP_REQUIRE_MENTION=true
```

也可以显式指定：

```env
QQ_CODEX_ACCESS_CONTROL=deny-by-default
```

只有明确设置 `QQ_CODEX_ACCESS_CONTROL=allow-all` 才会放开全部来源；`doctor` 会对此给出安全警告。

### 微信文本网关

bridge 侧配置：

```env
WEIXIN_ENABLED=true
WEIXIN_ACCOUNT_ID=default
WEIXIN_WEBHOOK_PATH=/webhooks/weixin
WEIXIN_EGRESS_BASE_URL=http://127.0.0.1:3200
WEIXIN_EGRESS_TOKEN=your-token
```

首次扫码登录：

```bash
pnpm weixin:login
```

启动微信网关：

```bash
pnpm run build
pnpm start:weixin-gateway
```

更多说明见 [微信文本网关接入](./docs/weixin-text-gateway.md)。

## 架构概览

```text
QQ / WeChat / future Lark / future Telegram
        |
        v
Bridge daemon
        |
        +-- Command Router
        +-- Session Store / Transcript Store / Runtime State
        +-- Access Control
        |
        v
Codex app-server driver
        |
        v
Codex Desktop threads and tool calls
```

当前实现已经把 Codex 回合纳入任务状态、session/thread 调度、工具事件、取消、超时、重试、投递重试和重启恢复链路。

更多调度能力设计见 [可调度 Codex 的 QQ Bot 能力说明](./docs/codex-orchestrated-qq-bot.md)。

## 当前实现边界

已经可用：

- QQ 官方 Bot WebSocket 入站
- 微信文本 long-poll 网关
- Codex app-server 默认链路
- Codex 线程查看、切换、新建、fork
- 项目别名和 `/new <alias> <task>`
- QQ 媒体下载、上下文注入和媒体回传
- STT 语音转写
- ChatGPT Desktop 可选历史 provider
- runtime config、state、log、management token
- Turn Manager 状态机、session 队列和可续租 thread lock
- 工具事件记录、长任务心跳、hard timeout 和 tool silence timeout
- `/tasks`、`/task current`、`/cancel`、`/retry`、`/deliveries`
- Delivery Worker 重试和 daemon 重启恢复
- CLI `start/status/doctor/logs/tasks/task/deliveries/stop/restart/init`
- 访问控制和多账号配置

当前边界：

- 重试会创建新 turn，不会恢复旧 Codex turn 的进程状态
- daemon 重启后会将未完成任务收口为 `timed-out` 或 `orphaned`，不会自动续跑
- 工具进度采用事件记录和节流心跳，不会把完整工具日志刷到聊天窗口
- 飞书、Telegram 等更多平台入口

## 开发

```bash
git clone <你的仓库地址>
cd codex-desktop-orchestrator
pnpm install
cp .env.example .env
pnpm run build
pnpm start
```

常用检查：

```bash
pnpm run check
pnpm test
pnpm run test:offline
pnpm run test:bridge-smoke
```

## 文档

- [架构说明](./docs/architecture.md)
- [可调度 Codex 的 QQ Bot 能力说明](./docs/codex-orchestrated-qq-bot.md)
- [微信文本网关接入](./docs/weixin-text-gateway.md)
- [FAQ 与故障排查](./docs/faq.md)
- [测试说明](./docs/testing.md)

## 安全提醒

- `.env` 包含 QQ Bot、微信、STT 等敏感凭据，不要提交到仓库。
- 本项目会处理聊天消息、附件、语音和本地文件路径，联调时注意隐私边界。
- 如果把仓库公开，先检查历史提交中是否出现过真实 token 或本地路径。

## 致谢

本项目是在原项目 `qq-codex-bridge` 基础上进行的二次开发和重新定位，延续并扩展了 QQ Bot 连接 Codex Desktop 的核心思路。

特别感谢原作者 [983033995](https://github.com/983033995) 和原项目为 QQ 与 Codex Desktop 桥接、消息收发、会话管理等能力打下的基础。

## License

本项目使用 [MIT License](./LICENSE)。

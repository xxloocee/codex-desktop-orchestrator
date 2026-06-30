# Architecture

系统由聊天平台适配层、桥接编排层、Codex Desktop 驱动层和 SQLite 存储层组成。

当前默认链路通过 Codex app-server 驱动 Codex Desktop；旧 DOM/CDP 自动化模式仍作为兼容路径保留。编排层只依赖 `DesktopDriverPort`、会话存储和出站通道接口，不直接感知 Codex UI 控件细节。

核心边界：

- `apps/bridge-daemon` 负责启动、配置、HTTP webhook、访问控制和运行时管理。
- `packages/orchestrator` 负责把入站消息转换为 Codex 回合，并把回复草稿交给通道发送。
- `packages/adapters/codex-desktop` 负责 Codex app-server / legacy DOM 驱动细节。
- `packages/adapters/qq` 与 `packages/adapters/weixin` 负责平台消息格式、媒体和发送。
- `packages/store` 负责 SQLite 会话、消息和投递记录持久化。

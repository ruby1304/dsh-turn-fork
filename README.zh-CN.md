# dsh-turn-fork

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 会话提供
回合级（turn-atomic）的消息编辑、重试、重新生成与版本树导航。

[English](README.md)

- 编辑任意已落定的用户消息，并从该回合重新分支执行（后续回合 `截断` 或 `保留`）。
- 重试任意历史回合；重新生成最后一轮的回复。
- 版本树 Timeline + 跨分支撤销/重做导航。
- 分支日志**在 dsh 进程重启后仍可读取**——这正是社区插件 `dsh-message-edit`
  未通过的 P0 耐久性保证（见下文）。
- 只使用官方插槽：Timeline 标签页、会话头部操作、每条助手消息的操作区。
  无 DOM 注入、无文本猜测定位。
- 通过 `dsh-client-locale` 接入的中英双语界面。

## 安装

```bash
dsh plugin add dsh-turn-fork
```

重启 dsh 后生效。插件会注册一个 **回合分支（Turn Fork）** 标签页（位于
Trajectory 与 Prompt Studio 之间）、会话头部的撤销/重做/重新生成按钮，以及
每条已落定助手消息上的重试/重新生成按钮。

## 为什么会有这个插件

`dsh-message-edit`（v0.2.3）存在一个 P0 致命缺陷：其持久化溯源事件
`message-edit/version` **没有** `ignorable` 标记。live 写盘路径照单全收，
但 dsh 重启后持久层的冷读词汇表守卫（`assertEventsSupported`）会以
`SessionFormatUnsupportedError` 拒绝整条日志——所有分支会话集体打不开。
复现与回归见 `tests/p0-persistence.test.mjs`（live 写入 OK → 重启 → 冷读
REJECTED；补上 ignorable → 重启 → 冷读 PASS），测试直接驱动真实的
`dsh-session` + `dsh-session-persistence-jsonl`，并在全新子进程中完成"重启"。

本插件同时修复了评审发现的设计遗漏：

| 缺陷 | 本插件做法 |
| --- | --- |
| 自定义事件必须 `ignorable: true` | `turn-fork/version` 一律 ignorable，且带 schemaVersion 供未来迁移 |
| HTTP 路由无信任围栏（CSRF / DNS 重绑定、烧 token） | Origin/Host 回环围栏 + content-type 校验 + 64 KiB body 上限 |
| 用 DOM 文本猜测定位消息 | 仅官方插槽（`conversation.view`、`conversation.session.header.actions`、`conversation.chat.assistant-actions`） |
| 分支丢失 `reasoningEffort` 等配置 | `provider`/`model`/`maxTokens` 取自最后一条 `request/header`；`reasoningEffort` 与 `adapterDefaults` 随 seed 内继承的 header 原样传递 |
| 重放时 steering 插话丢失 | 回合内全部用户输入按序保留并重放 |
| 编辑助手回复伪造 `source: {kind:'model'}` 且丢工具链 | 不支持（诚实的能力边界，见下） |
| 撤销导航后旧分支仍在后台空转 | 显示运行中分支并提供显式"停止"控制 |
| `preserve` 一键重放 N 回合无确认 | 保存前展示成本提示与显式的级联选择 |
| 无测试、无 i18n | node:test 套件 + P0 回归 + dsh-testkit 生命周期门禁；中英词典 |

## 使用

- **编辑用户消息**——打开 *回合分支* 标签页，选中一条消息，改好文本，选择
  后续回合策略并保存。插件会从已落定前缀创建新分支会话并重跑该回合。
- **重试 / 重新生成**——标签页内有逐回合按钮，助手消息上有逐条按钮，头部有
  针对最后一轮的重新生成按钮。
- **版本树**——标签页列出每个分支及其操作摘要（`原文 "…" → 改为 "…"`），
  标注当前版本，支持撤销/重做导航与打开任意分支。正在运行的分支会显示
  警告和"停止"控制。
- **级联策略**——`截断` 丢弃编辑回合之后的所有内容；`保留` 重放编辑后的回合
  及其后所有回合（每个重放输入成为独立回合，原同一回合内的输入保持顺序）。
  编辑器会在确认前显示 `保留` 将重放多少个回合。

## 设计说明

- **fork 语义。** 官方 `session.fork(atSeq)` RPC 的切割**包含**锚定回合，无法
  表达"编辑第 N 回合并重跑它"。因此本插件使用官方 fork 内部所用的同一事务缝
  ——`ctx.agents.create`——在目标回合**之前**切割 seed，写入官方血缘 meta
  （`parentSession`、`seedLength`、`cwd`、`agentPreset`），重挂载源会话的
  preset，并在分支发布前完成持久化 flush。
- **工作区。** 分支继承源会话的工作区挂载，语义与官方 fork 完全一致（重新
  attach，不做文件系统快照）。重跑会改写文件的任务时，工作树会停留在新分支
  的状态；需要工作区状态回滚请配合快照类插件（如 `dsh-checkpoint-rewind`）。
- **分支删除 / GC。** 平台目前没有会话删除 API，分支尚无法回收；版本树即对
  该谱系的如实披露。
- **从 `dsh-message-edit` 迁移。** 坏格式写出的日志被持久层本身拒绝读取，
  任何读取方（包括本插件）都无法就地修复。Timeline 会检测这一拒绝并明确
  报错。升级前请先用官方导出流程留存旧会话，或等待 upstream 修复。

## HTTP 信任围栏

宿主路由 `/turn-fork` 挂在 dsh web server 上，后者本身不做任何来源检查。
每个请求都必须通过插件围栏：浏览器 `Origin` 必须是
`http(s)://localhost|127.0.0.1|[::1]` 且端口与服务器监听端口一致（仅当服务器
监听 `0.0.0.0`、即运维显式选择对外暴露时放宽）；无 `Origin` 的请求必须携带
回环 `Host`。POST 请求体必须是 `application/json` 且不超过 64 KiB。

## 开发

```bash
npm install
npm run build      # tsc 类型检查 + tsdown 宿主/客户端打包
npm test           # 构建 + node:test（core、lineage、P0 持久化回归）
```

0.1.1 以 DSH `0.1.0-rc.8` 开发并执行发布验证。三个插槽贡献现在通过 `slots.inject()` 等待 rc.8 的 slot 声明；`dsh-client-runtime/client` 使用 rc.8 隐式预加载的 client baseline，不再重复声明成插件专属 external。

### 测试

- `tests/p0-persistence.test.mjs` —— P0 回归：用本插件真实的 fork seed 构建
  路径，经真实 `dsh-session` 存储与 `dsh-session-persistence-jsonl` 后端写盘，
  再由全新子进程冷读（即"重启"）。阴性对照证明：去掉标记的同一份日志会被
  守卫拒绝。
- `tests/core.test.mjs` —— steering 保真、计划边界、seed 构造、模型配置推导、
  信任围栏矩阵、body 上限、操作解码。
- `tests/lineage.test.mjs` —— 版本投影、撤销/重做栈、运行中标记。
- `dsh-testkit.yaml` —— 真实宿主生命周期门禁（安装 → 启动 → 注册 → 卸载 →
  重启 → 残留检查），基于社区 [dsh-testkit](https://github.com/iiwish/dsh-testkit)，
  并生成 `.github/workflows/dsh-lifecycle.yml` CI 工作流。

### Testkit 说明

`dsh-test --suite full` 在 `--runner local` 下会报告 `flaky`：每次尝试的所有
阶段都以完全一致的断言通过，但重复性摘要包含按尝试隔离的绝对路径与时间戳，
它们天然互不相同（默认的 Docker runner 下运行根路径稳定，不受影响）。quick
套件是此处的权威生命周期门禁；CI 工作流在 Docker 下运行它。

## 许可证

MIT。`scripts/dsh-client-preset.ts` 中的客户端打包预设来自 DeepSeek Harness
仓库（MIT, © DeepSeek）。

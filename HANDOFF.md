# 交接文档：自研 dsh 消息编辑/回合重跑插件（开源）

> 交接时间：2026-08-17 · 交接人：上一会话的质检 Agent · 接手：创造模式 + kimi k3 max
> 一句话任务：**社区插件 dsh-message-edit 质检不合格（1 个 P0 致命 bug + 一串设计遗漏），我们自研一个正确的版本并开源。**

---

## 1. 背景

用户想在 dsh web UI 里"输入错了能改、能重新执行某回合"。社区已有插件 `dsh-message-edit`（npm，Moeblack 出品，v0.2.3，周下载 524）提供分支式消息编辑/重试/重生成。用户要求先质检其源码，不合格就自研开源。质检结论：**架构方向正确，但有致命缺陷，值得自研**。

本目录 `/Users/qudian/Local/dsh/dsh-turn-fork/` 是新插件的预定工作区（名字可改，npm 上 `dsh-message-edit` 已被占用；候选名：`dsh-turn-fork`、`dsh-rewind-edit`、`dsh-branch-replay`，发布前查 npm 占用）。

## 2. 质检材料位置

| 材料 | 路径 |
|---|---|
| dsh-message-edit 完整源码（git clone） | `/tmp/dsh-review/dsh-message-edit/`（src/index.ts 885 行 host 端 + client 4 文件） |
| 实证测试脚本（可直接重跑） | `/tmp/dsh-review/test-persist.mjs`、`/tmp/dsh-review/test2.mjs` |
| 本地 dsh 运行时（rc.5，含 lib 与类型） | `~/.dsh/profiles/node_modules/@deepseek-ai/` |
| rc.6 的 dsh-session 解包（对照） | `/tmp/dsh-review/package/` |
| 运行中的 dsh web 实例 | `http://127.0.0.1:3080`（ legacy HTTP API 可用，见 §7） |

## 3. 质检结论：dsh-message-edit 的缺陷清单（全部经源码+实证验证）

### P0 致命：分支会话重启后全部不可读（实证复现）

- 插件把版本溯源事件 `message-edit/version` 写进会话事件日志（`src/index.ts` 的 `appendLogSeedEvent`），**没有打 `ignorable: true` 标记**。
- 该事件类型**不在** dsh 的 `KNOWN_SESSION_EVENT_TYPES`（rc.5 本地运行时和 rc.6 最新版都没有；官方对第三方事件的注册面"deferred"，即现在根本没有注册途径）。
- dsh 持久化层的**所有冷读路径**（`prepareCore` / `readStoredPrefix` / `readFrom` / `adoptLivePrefix`，见 `dsh-session-persistence/lib/types/coordinator.js` 的 `assertEventsSupported`，调用点 647/664/680/1066 行）遇到"未知类型且未标 ignorable"的事件会抛 `SessionFormatUnsupportedError` 拒读整条日志。
- **失败模式最恶劣的那种**：live Session 构造不校验词汇表（只验信封）、写盘路径也无守卫——所以插件运行时一切正常，**重启 dsh 后所有分支版本会话集体打不开**，版本树/撤销链全废。
- 实证：`node /tmp/dsh-review/test-persist.mjs` → live 构造 OK；冷读守卫 REJECTED；加 `ignorable:true` 后 PASS。且 `test2.mjs` 证实 ignorable 事件 replay 后保留在 `session.events` 里（修复不会丢数据）。
- 上游修复只需一行（seed 事件加 `ignorable: true`），但旧分支已写盘的无标记事件无法自愈，需要迁移逻辑。

### P1 高危

2. **HTTP 路由无信任围栏（localhost CSRF）**：`webServer.register` 本身不带任何 Origin/Host 检查（`dsh-host-webserver/lib/index.js` register 只是路由表）；官方 `/api` 通道是手动调 `isTrustedApiRequest(req, trustedHosts)` 的。插件的 `GET/POST /message-edit` 什么都没查——任意网页可跨域读取会话全文（GET 返回所有可编辑消息文本）或触发分支重跑（POST，烧 API quota）。`requestJson` 还无 body 大小上限。
3. **消息定位靠 DOM 文本猜测**：`InlineMessageEdit.tsx` 用 `MutationObserver` 扫 `document.querySelectorAll('[class*="actions"]')`，再拿消息**前 24 个字符**做 `text.includes` 匹配。class 名随官方 UI 漂移即失效；两条前缀相同的消息会错配→**编辑错对象**。（作者自己注释承认：官方 MessageIconActions 没有插件槽位，只能注入。）
4. **模型配置保真丢失**：`agentOptions()` 只从最后一条 `request/header` 取 `provider/model/maxTokens` 三字段（AgentOptions 也只有这三个字段）；`reasoningEffort`（用户当前正是 kimi k3 + reasoningEffort max）、adapterDefaults 等不传入分支 → 分支行为悄悄漂移。

### P2 设计遗漏

5. **steering/中途插话丢失**：`closedTurns()` 每回合只收第一条 `source.kind==='user'` 的消息；用户 settings 里 `busyEnter: steer`，插话在重放时全部消失。
6. **assistant 编辑丢工具链 + 来源伪造**：编辑 assistant 回复时 filter 只剩 text/reasoning 块（工具调用块被丢弃），并伪造 `source: {kind:'model'}`——人工文本冒充模型输出，上下文完整性风险。
7. **工作区状态不回滚**：旧回合的文件改动残留，新分支对话不知情（README 声明 out-of-scope，但"重新执行任务"场景恰恰需要）。应与快照类能力联动（参考 `dsh-checkpoint-rewind` 的 session+workspace+config 三态快照）。
8. **undo/redo 只是 UI 导航**：切回旧版本不会停掉新分支上正在跑的 agent——后台继续烧 token、继续写工作区，可能两分支并发写同一目录。
9. **分支无 GC**：每次编辑产生一个永久新 session，会话列表膨胀，无清理。
10. **preserve 级联无确认**：一键重放 N 个后续回合，无成本提示/确认。
11. **无测试、无 CI**；**无 i18n**（全中文硬编码，未接 `dsh-client-locale`）。

### 做得对、值得吸收的

- 回合作为效果原子（turn-atomic fork），历史 append-only 不改写；
- 结构可逆：effect/inverse 成对落盘，`recoverOperation` 逆序组合回滚；
- 用官方 `agents.create({seed, meta})` 事务缝（seedLength/parentSession 是官方 meta 字段）；
- `runMaintenance` 序列化与 agent 主循环的并发；
- client controller 工程质量高（generation 防竞态、AbortController、inflight 去重、`openWhenListed` 等 session-list 发布再导航）。

## 4. 已验证的平台契约清单（rc.5 本地逐一核对，可直接依赖）

- `ctx.agents.create({ sessionId, seed, meta: { cwd, parentSession, seedLength, agentPreset }, agentOptions, setup })` ✓（`dsh-agent/lib/types/index.d.ts`）
- `ctx.agents.resume({ resumeSessionId, agentOptions })`、`agent.runMaintenance(task)`、`agent.followup(userMessage)` ✓
- `ctx.sessions.flush(session)`、`ctx.sessions.get(id)` ✓
- `ctx.sessionQuery.traceSession(id)` / `readSession(id)`；`SessionLineageNode`、`SessionRecord.header.{parentSession,seedLength,createdAt,cwd,agentPreset}` ✓
- `ctx.sessionPersistence.inspect(id)` / `readFrom(id, fromSeq)` ✓
- `ctx.workspaceRegistry.list()`、`workspace.attachSession/detachSession` ✓
- `ctx.webServer.register({ kind:'exact', path, handler })` ✓（**无内置信任围栏，需自己查 Origin/Host**）
- 客户端插槽：`conversation.view`（Timeline 类标签页，order 15 在 Trajectory(10) 与 Prompt Studio(20) 之间）、`conversation.session.header.actions` ✓
- **官方 `session.fork` RPC 已存在**：`POST /api/session.fork`，payload `{ sessionId, atSeq? }`（atSeq = completed-turn 锚点切割），返回 `{ sessionId }`。schema 在 `dsh-host-apiproxy/lib/index.js`（sessionForkRequestSchema, ~line 477）。**新实现应优先评估骑这个官方原语**，而不是手工拼 seed。
- 事件信封校验：live 构造只验信封（type/seq/time/data/surfaceOp/sourceEventSeqs/ignorable 六键）；自定义事件必须 `ignorable: true` 才能过冷读守卫。
- Session 构造自动投影 `session/end-seed` 标记。

## 5. 新插件需求规格（建议）

**核心能力**（对齐用户原始诉求）：
1. 编辑任意已落定用户消息 → 从该回合前分支 → 重跑（cascade: truncate/preserve）；
2. 重试任意历史回合；重生成最后一轮；
3. 版本树 Timeline + 撤销/重做导航；
4. **分支会话重启后可读**（P0 回归测试必须覆盖：create → flush → 重启进程 → resume/readFrom 成功）。

**修正项**：§3 的 P0~P2 全部。特别地：
- 溯源优先用官方 meta（parentSession/seedLength）+ 官方 fork RPC；若必须写自定义事件，一律 `ignorable: true` 并提供旧数据迁移；
- HTTP 路由加 Host/Origin 检查 + body 上限；
- 完整携带 `request/header` 的 config（至少 provider/model/maxTokens/reasoningEffort）；
- steering 消息保真（回合内所有 user 输入按序重放）；
- 分支创建时停掉/隔离源分支的写冲突（至少警告）；
- UI 优先官方 slot；DOM 注入若不可避免，用数据属性/结构定位，禁止文本猜测；
- i18n 接 dsh-client-locale（中/英）；
- 测试用社区的 `dsh-testkit`（真实宿主生命周期）。

**开源要求**：MIT、README 中英双语、npm 发布前 `npm search` 查重、GitHub repo 打 `dsh-plugin` topic（社区发现机制）。

## 6. 环境事实

- 本机 dsh 0.1.0-rc.5；profile=web 已装插件：`dsh-vision-subagent`（本地 link）、`dsh-plugin-llm-balance`。
- 插件安装：`dsh plugin --profile web add <pkg>`（pnpm 转发器，自动收编进 bundles，重启生效）；本地开发用 `add -w link:/path`。
- 默认模型已是 kimi-coding/k3 + reasoningEffort max（`~/.dsh/settings.yaml`），新 session 无需另配。
- 旧 dsh web 实例在 3080 端口跑着（用户当前会话所在），**不要重启它**；测试新插件用自己的 profile/端口。

## 7. 附：dsh web legacy HTTP API（实测可用）

```
POST http://127.0.0.1:3080/api/<method>
content-type: application/json
{"type":"client-request","rpcId":"<任意>","method":"<method>","payload":{...}}
```
实测端点：`session.list`、`session.create {cwd, agentPreset}`、`session.prompt {sessionId, mode:queue|steer, content:[{type:"text",text}]}`、`session.fork {sessionId, atSeq?}`、`session.models`、`session.selectModel`、`agentPreset.list`。响应 `{"type":"server-response","result":{"ok":true,"value":...}}`。

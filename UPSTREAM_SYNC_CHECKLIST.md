# 上游同步检查清单

这是一份仓库内使用的检查文档，用来在同步 `upstream/main` 之后，核对本地实现的功能是否仍然完整。

只要发生下面这些情况，都建议按这份清单检查一遍：

- 从上游拉取大量更新并合并到本地分支
- 把本地 `prod` 上的定制功能迁移到新同步分支
- 手工解决完上游同步冲突之后
- 准备把同步分支再合回本地稳定分支之前

## 目标

确认上游同步没有把本地定制功能静默覆盖、删掉，或者改出行为回归。

## 推荐同步流程

建议不要在日常开发分支上直接同步上游，先切到专门的同步分支处理。

### 1. 先拉取上游最新代码

先确认远端存在 `upstream`，然后只拉远端引用，不要一上来就在当前工作分支直接 `pull --rebase`：

```sh
git remote -v
git fetch upstream
git log --oneline --decorate -n 20 upstream/main
```

如果你习惯先把上游主线单独更新到一个本地跟踪分支，也可以显式执行：

```sh
git checkout upstream
git pull --ff-only
```

但不管用哪种方式，核心目标都一样：

- 先拿到最新的 `upstream/main`
- 先看清这次上游到底更新了什么
- 不要在还没评估风险前，就把上游改动直接压到本地稳定分支

### 2. 切到专门处理同步的本地分支

推荐把同步工作放在单独分支，例如：

```sh
git checkout codex/sync-upstream-main-YYYYMMDD
```

如果这个分支还不存在，就从你当前要保护的本地主线拉一个新分支出来：

```sh
git checkout -b codex/sync-upstream-main-YYYYMMDD
```

这里的基线通常应该是你当前真正要保留本地能力的分支，例如本地 `prod` 或你自己的稳定分支，而不是盲目从 `upstream/main` 起新分支。

### 3. 合并上游到同步分支

在同步分支上执行：

```sh
git merge upstream/main
```

如果你已经有一个本地 `upstream` 跟踪分支，并且它已经快进到最新上游，也可以合并那个本地分支：

```sh
git merge upstream
```

注意：

- 不要把“没有冲突”等同于“没有回归”
- 即使自动 merge 成功，也必须继续做下面的历史范围、重叠范围、语义范围和验证范围检查
- 如果出现冲突，优先保留本地定制功能语义，再吸收上游结构调整，不要机械地选 `ours` 或 `theirs`

### 4. 解决冲突后，立刻按这份清单做检查

推荐顺序：

1. 先做下面的 A / B 范围检查，确认这次真正要保护的本地提交和高风险文件
2. 再做 C 语义检查，确认关键功能标记没有被静默吃掉
3. 最后跑 D 里的测试和构建

如果检查没做完，不要急着把同步分支合回本地稳定分支。

## 本地实现功能清单

每次同步后都要检查下面这些模块。以后如果本地又新增了新的定制功能，也要及时补进这份文档。

### 0. Bundled runtime / optional plugins 一致性

涉及文件：

- `scripts/copy-bundled-plugin-metadata.mjs`
- `scripts/check-bundled-plugin-runtime-integrity.mjs`
- `scripts/runtime-postbuild.mjs`
- `scripts/lib/optional-bundled-clusters.mjs`
- `tsdown.config.ts`
- `src/plugins/bundled-compat.ts`
- `src/config/validation.ts`
- `src/plugins/copy-bundled-plugin-metadata.test.ts`
- `src/config/config.plugin-validation.test.ts`

必须确认：

- `dist/extensions` 和 `dist-runtime/extensions` 中，不能出现只带 `package.json / openclaw.plugin.json`，却没有
  `index.js / setup-entry.js` 的 metadata-only 假插件目录
- optional bundled plugins 如果本次 build 没有实际产出，就不能被 stage 进 `dist/extensions`
- runtime postbuild 之后仍然会执行 bundled plugin runtime 完整性校验，声明的入口文件缺失时必须直接 fail build
- `plugins.allow / plugins.deny` 中残留的 optional bundled plugin ids，如果当前 build 没带该插件，只能 warning，不能阻断 gateway 启动
- 测试仍然覆盖：
  - 缺失运行时入口时不 stage metadata
  - optional bundled plugin 缺失时只 warning

背景：

- 这是 2026-03-23 在 `video_workflow` 集成最新 OpenClaw 后定位出的根因修复
- 旧问题表现为：
  - `extension entry escapes package directory: ./index.js`
  - `plugins.allow: plugin not found: whatsapp/googlechat/...`
  - 打包产物 notarization 通过，但 app 启动后 gateway 直接退出

下游集成约束：

- `video_workflow` 侧不会再写死旧渠道插件清单，而是按 bundled runtime 实际扫描到的 channel plugins 生成 `plugins.allow`
- 如果以后这里的 bundled runtime 行为再次变化，同步上游后除了跑 OpenClaw 自身验证，还要回归验证：
  - `/Users/yangwanquan/Personal_projects/AIGC_dev/video_workflow/front/src-tauri/src/openclaw/server/config.rs`
  - `/Users/yangwanquan/Personal_projects/AIGC_dev/video_workflow/front/scripts/verify-runtime-resources.mjs`
  - `/Users/yangwanquan/Personal_projects/AIGC_dev/video_workflow/front/scripts/prepare-openclaw-runtime-local.mjs`

### 1. Gateway 会话事件订阅

涉及文件：

- `src/gateway/server-methods/events.ts`
- `src/gateway/server-methods/types.ts`
- `src/gateway/server.impl.ts`
- `src/gateway/server.health.test.ts`

必须确认：

- `events.subscribe` 和 `events.unsubscribe` 仍然对外暴露并可调用
- 连接关闭时仍然会清理会话事件订阅
- 健康检查测试仍然覆盖并断言这组 RPC 可用

### 2. Session files API 与历史聚合

涉及文件：

- `src/gateway/session-files.ts`
- `src/gateway/session-files.history.test.ts`
- `src/gateway/server-methods/sessions.ts`
- `src/gateway/protocol/schema/sessions.ts`
- `src/gateway/server-methods-list.ts`
- `src/gateway/method-scopes.ts`

必须确认：

- `sessions.files.list` 和 `sessions.files.track` 仍然存在
- session file 历史聚合能力仍然通过 gateway 暴露
- 协议 schema 和 method scopes 里仍然包含这组 RPC

### 3. Chat bridge 增量消息稳定性

涉及文件：

- `src/gateway/server-chat.ts`
- `src/gateway/server-chat.agent-events.test.ts`

必须确认：

- chat delta payload 仍然使用基于 `clientRunId` 的稳定 `message.id`
- 增量节流仍然可以通过 `OPENCLAW_GATEWAY_CHAT_DELTA_THROTTLE_MS` 配置
- final assistant payload 仍然保留稳定 message id 和完整文本

### 4. Heartbeat 调度与 isolated session

涉及文件：

- `src/infra/heartbeat-runner.ts`
- `src/infra/heartbeat-runner.scheduler.test.ts`
- `src/infra/heartbeat-runner.returns-default-unset.test.ts`
- `src/config/types.agent-defaults.ts`

必须确认：

- heartbeat 调度语义没有被改坏
- `isolatedSession` 仍然会创建独立的 heartbeat 会话 key
- 默认值和未设置场景的行为仍符合本地预期

### 5. Subagent wait timeout 语义

涉及文件：

- `src/agents/subagent-registry.ts`
- `src/agents/subagent-registry.wait-timeout-semantics.test.ts`

必须确认：

- `agent.wait` 返回观察者超时时，不会过早结束仍在运行的 subagent
- 防止空转的 spin guard 和 backoff 逻辑仍然在

### 6. Embedded runtime 与 ACP / session typing 修复

涉及文件：

- `src/agents/pi-embedded-runner/run/attempt.ts`
- `src/agents/pi-embedded-runner/run/attempt.test.ts`
- `src/agents/pi-embedded-subscribe.types.ts`
- `src/config/sessions/types.ts`
- `src/auto-reply/reply/inbound-meta.ts`

必须确认：

- embedded subscribe 参数在需要时仍然携带 `sessionId`
- ACP session 元数据和 runtime options 仍然能在 session entry 里表达
- inbound metadata 的格式化逻辑仍然保留

### 7. Embedded streamFn 选择与 OpenAI WebSocket fallback

涉及文件：

- `src/agents/pi-embedded-runner/run/attempt.ts`
- `src/agents/pi-embedded-runner/run/stream-selection.ts`
- `src/agents/pi-embedded-runner/run/stream-selection.test.ts`
- `src/agents/openai-ws-stream.ts`
- `src/agents/openai-ws-stream.test.ts`

必须确认：

- embedded runner 默认路径仍然优先保留当前已经带认证的 `streamFn`，不要在无必要时回退到原始 `streamSimple`
- 选择 OpenAI WebSocket 传输时，HTTP fallback 仍然会透传当前 authenticated `streamFn`
- WebSocket 缺少独立 API key 时，只 warning 并继续使用当前 authenticated `streamFn`
- `anthropic-vertex` 和 provider 自定义 stream 注册逻辑没有被静默覆盖

### 8. Web search 默认配置、legacy Serper 兼容与 provider 参数透传

涉及文件：

- `src/agents/tools/web-search.ts`
- `src/agents/tools/web-search.test.ts`
- `src/agents/tools/web-tools.enabled-defaults.test.ts`
- `src/config/types.tools.ts`
- `src/config/zod-schema.agent-runtime.ts`
- `src/legacy-serper-web-search-provider.ts`
- `src/plugins/legacy-bundled-web-search.ts`
- `src/plugins/bundled-web-search.ts`
- `src/plugins/bundled-web-search.test.ts`
- `src/commands/onboard-search.test.ts`
- `src/secrets/runtime-web-tools.test.ts`

必须确认：

- 本地默认 provider 逻辑仍然存在
- Brave mode 相关处理仍然存在
- Serper 仍然支持 `country` 和 `search_lang` 透传
- legacy `serper` provider 仍然会出现在 provider 列表里，并写入 `tools.web.search.serper.apiKey`，而不是错误生成 plugin config
- runtime metadata / warning 路径不会把已配置的 legacy `serper` 误判成 invalid autodetect
- Serper 请求路径仍然通过受信任的 web tools endpoint 包装，而不是裸 `fetch`
- runtime config 和 schema 仍然暴露本地 web-search 设置

### 9. Session rollover 历史保留

涉及文件：

- `src/auto-reply/reply/session.ts`
- `src/auto-reply/reply/session.test.ts`
- `src/config/sessions/sessions.test.ts`

必须确认：

- 创建新 session 时仍然会保留 `previousSessions`
- reset 或 freshness rollover 后，旧 session 链路仍然会正确写回

### 10. 生成协议模型漂移

涉及文件：

- `apps/macos/Sources/OpenClawProtocol/GatewayModels.swift`
- `apps/shared/OpenClawKit/Sources/OpenClawProtocol/GatewayModels.swift`
- `src/gateway/protocol/schema/*.ts`

必须确认：

- 生成给客户端使用的协议模型，仍然覆盖本地依赖的 gateway / session 字段
- 上游 schema 更新没有把下游客户端仍依赖的本地字段静默删掉

### 11. Compaction / Skill SDK 合约漂移

涉及文件：

- `src/agents/compaction.ts`
- `src/agents/pi-extensions/compaction-safeguard.ts`
- `src/agents/skills/source.ts`

必须确认：

- `generateSummary(...)` 调用仍然按当前上游签名传参，`headers` 必须在 `signal` 前
- compaction safeguard 仍然通过 `modelRegistry.getApiKeyAndHeaders(model)` 解析 request auth，并处理 `auth.ok === false` 分支
- skill source 仍然从 `skill.sourceInfo.source` 读取，而不是访问已不存在的旧字段
- 这些改动必须通过 `pnpm build`，因为只跑单测不一定能覆盖 `tsconfig.plugin-sdk.dts.json` 的编译面

### 12. 统一 Skill 广场 / agent-workspace 生命周期协议

涉及文件：

- `src/gateway/server-methods/skills.ts`
- `src/agents/skills-manage.ts`
- `src/agents/skills/config.ts`
- `src/agents/skills-status.ts`
- `src/agents/skills/env-overrides.ts`
- `src/agents/skills/workspace.ts`
- `src/agents/cli-runner/execute.ts`
- `src/agents/pi-embedded-runner/compact.ts`
- `src/agents/pi-embedded-runner/run/attempt.ts`
- `src/config/types.agents.ts`
- `src/config/types.agent-defaults.ts`
- `src/config/zod-schema.agent-runtime.ts`
- `src/config/zod-schema.agent-defaults.ts`
- `src/gateway/protocol/schema/agents-models-skills.ts`
- `src/gateway/protocol/schema/protocol-schemas.ts`
- `src/gateway/protocol/schema/types.ts`
- `src/gateway/protocol/index.ts`
- `src/secrets/runtime-config-collectors-core.ts`
- `src/secrets/target-registry-data.ts`
- `src/gateway/server-methods/skills.clawhub.test.ts`
- `src/gateway/server-methods/skills.update.normalizes-api-key.test.ts`
- `src/gateway/server-methods/skills.lifecycle.test.ts`
- `src/agents/skills-status.test.ts`
- `src/secrets/runtime.coverage.test.ts`
- `src/secrets/exec-secret-ref-id-parity.test.ts`

必须确认：

- `skills.status / skills.install / skills.update / skills.uninstall` 仍然全部支持可选 `agentId`，并且语义仍然是“目标 agent 对应的 workspace”
- `skills.install` 的本地 installer 模式和 ClawHub 模式都仍然支持 `agentId`，不能退回成只写默认 agent workspace
- `skills.update` 仍然按三层 merge 生效：
  - `skills.entries`
  - `agents.defaults.skillSettings`
  - `agents.list[].skillSettings`
- `resolveSkillConfig(..., { agentId })` 仍然是运行时唯一权威入口；执行链和 env override 不能绕过它
- `skills.status(agentId)` 返回的结果里，仍然包含本地下游 UI 依赖的 `managedInstall` 和 `installOrigin`
- `skills.uninstall({ skillKey, agentId })` 仍然只允许删除目标 workspace 下的 managed install；项目自带 skill、共享 skill、未托管目录都必须拒绝卸载
- secret collector 仍然覆盖：
  - `agents.defaults.skillSettings.*.apiKey`
  - `agents.list[].skillSettings.*.apiKey`
- 下游桌面端当前产品约束仍然成立：
  - 统一 Skill 广场只有一套
  - 目标安装单位是 `agent`
  - 对桌面端受管理 agent，`agent = 独立 workspace`
- `skills.import` 当前不是下游产品核心路径；上游同步时如果这里被改动，必须额外判断：
  - 是否影响 `status / install / update / uninstall` 主链
  - 是否会让下游“关闭远程导入入口”这件事变得不安全
  - 是否把远程导入重新耦合回默认 agent / 全局配置

背景：

- 这是 2026-04-19 为 `video_workflow` 桌面端统一 Skill 广场落地的本地协议增强
- 下游产品要求不是“每个 agent 一套独立广场”，而是“同一个广场里可以把 skill 安装到任意目标 agent”
- 在当前产品语义里，目标 `agent` 就等价于独立 workspace；如果未来上游重新引入多 agent 共用 workspace 的强语义，下游集成必须重新评估 UI 和生命周期边界，不能默认兼容

## 每次同步必须检查的范围

每次同步都至少检查下面四层，不要只看 merge 有没有冲突。

### A. 历史范围

先确认同步前本地独有提交有哪些：

```sh
base=$(git merge-base prod upstream/main)
git log --oneline "$base"..prod
git diff --name-only "$base"..prod
```

这一步的目的是先列出“本地功能边界”，明确这次到底要保护什么。

### B. 重叠范围

在同步分支上合入上游之后，找出“本地改过，同时上游也改过”的文件：

```sh
base=$(git merge-base prod upstream/main)
git diff --name-only prod..HEAD -- $(git diff --name-only "$base"..prod)
```

这些文件就是高风险文件，优先人工核查。

### C. 语义范围

不要只看 merge 成功，还要 grep 本地功能的关键标记，确认功能语义还在。

示例命令：

```sh
rg -n "events\\.subscribe|eventsSubscribe|eventsUnsubscribe" src/gateway
rg -n "sessions\\.files|listSessionFilesForGateway|trackSessionFilesForGateway" src/gateway
rg -n "OPENCLAW_GATEWAY_CHAT_DELTA_THROTTLE_MS|chat-assistant:" src/gateway/server-chat.ts
rg -n "isolatedSession|SUBAGENT_WAIT_TIMEOUT_SPIN_GUARD_MS" src/infra src/agents
rg -n "fallbackStreamFn|resolveEmbeddedRunStreamFn|shouldUseOpenAIWebSocketTransport" src/agents
rg -n "SERPER_API_KEY|serperBaseUrl|braveMode|withTrustedWebToolsEndpoint|legacy-bundled-web-search" src/agents src/plugins src/flows
rg -n "getApiKeyAndHeaders|sourceInfo\\.source|generateSummary\\(" src/agents
rg -n "skillSettings|managedInstall|installOrigin|skills\\.uninstall|skills\\.import|resolveSkillConfig\\(" src/agents src/config src/gateway src/secrets
```

### D. 验证范围

至少跑本地功能相关测试，再跑一次构建。

核心同步回归测试：

```sh
pnpm test -- \
  src/gateway/server.health.test.ts \
  src/gateway/server.sessions.gateway-server-sessions-a.test.ts \
  src/gateway/server.chat.gateway-server-chat-b.test.ts \
  src/gateway/server-methods/events.test.ts \
  src/infra/heartbeat-runner.scheduler.test.ts \
  src/infra/heartbeat-runner.returns-default-unset.test.ts \
  src/agents/pi-embedded-runner/run/attempt.test.ts \
  src/agents/pi-embedded-runner/run/stream-selection.test.ts \
  src/agents/openai-ws-stream.test.ts \
  src/agents/tools/web-search.test.ts \
  src/agents/tools/web-tools.enabled-defaults.test.ts \
  src/plugins/bundled-web-search.test.ts \
  src/commands/onboard-search.test.ts \
  src/secrets/runtime-web-tools.test.ts \
  src/gateway/server-methods/skills.clawhub.test.ts \
  src/gateway/server-methods/skills.update.normalizes-api-key.test.ts \
  src/gateway/server-methods/skills.lifecycle.test.ts \
  src/agents/skills-status.test.ts \
  src/secrets/runtime.coverage.test.ts \
  src/secrets/exec-secret-ref-id-parity.test.ts
```

本地功能保留测试：

```sh
pnpm test -- \
  src/gateway/server-chat.agent-events.test.ts \
  src/gateway/session-files.history.test.ts \
  src/agents/subagent-registry.wait-timeout-semantics.test.ts \
  src/auto-reply/reply/inbound-meta.test.ts \
  src/auto-reply/reply/session.test.ts \
  src/config/sessions/sessions.test.ts \
  src/agents/session-tool-result-guard-wrapper.test.ts \
  src/agents/tools/sessions-spawn-tool.test.ts
```

构建检查：

```sh
pnpm build
```

## 每次同步后的输出模板

每次检查完成后，至少要明确回答下面 6 个问题：

1. 这次检查覆盖了哪些本地独有提交？
2. 哪些本地修改文件和上游更新发生了重叠？
3. 哪些本地功能已经确认保留？
4. 哪些文件虽然自动合并成功，但仍然需要人工复核语义？
5. 哪些测试通过、失败、跳过？
6. 有没有生成模型或协议字段漂移，需要额外补丁？

## 维护规则

只要 `prod` 上又新增了新的本地定制功能，就要在同一批改动或紧接着下一批改动里，把这份文档同步更新。

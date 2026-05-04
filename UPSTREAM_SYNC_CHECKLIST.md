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
- `src/config/zod-schema.agent-defaults.ts`
- `src/config/zod-schema.agent-defaults.test.ts`

必须确认：

- `generateSummary(...)` 调用仍然按当前上游签名传参，`headers` 必须在 `signal` 前
- compaction safeguard 仍然通过 `modelRegistry.getApiKeyAndHeaders(model)` 解析 request auth，并处理 `auth.ok === false` 分支
- skill source 仍然从 `skill.sourceInfo.source` 读取，而不是访问已不存在的旧字段
- `agents.defaults.compaction.truncateAfterCompaction` 仍然在 agent defaults schema 中可配置，不能在同步上游 schema 时被静默删掉
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

### 13. Chat history 分页游标与 session history HTTP 认证语义

涉及文件：

- `src/gateway/server-methods/chat.ts`
- `src/gateway/protocol/schema/logs-chat.ts`
- `src/gateway/server.chat.gateway-server-chat-b.test.ts`
- `src/gateway/sessions-history-http.ts`
- `src/gateway/sessions-history-http.test.ts`

必须确认：

- `chat.history` 协议 schema 仍然保留可选 `before` 游标字段
- `chat.history` RPC 返回结果里，仍然会在需要翻页时返回：
  - `hasMore`
  - `nextBefore`
- 历史分页仍然基于 transcript 中稳定的消息顺序游标向更旧消息翻页，不能退回成只能取最后 N 条
- oversized / sanitized history placeholder 仍然会保留原始 `__openclaw.seq` 元数据，避免分页后游标漂移
- session history HTTP 路径仍然把 shared-secret bearer auth 视为受信任 operator 访问，不能错误要求显式 `operator.read` scope 才能读历史
- session history HTTP 路径仍然会给允许的 loopback browser origin 返回 CORS headers 和 `OPTIONS` preflight，且会拒绝非法 origin
- HTTP 与 WS 两条历史读取链路的分页和认证语义不能静默分叉

背景：

- 这是 2026-04-21 为 gateway chat history 向前翻页、session history HTTP 鉴权语义和 browser CORS 支持补充的本地检查点
- 下游当前依赖的是：
  - 可以按游标连续读取更旧的 transcript 页面
  - 使用 shared secret 的 HTTP 调用方可以直接读取 session history，而不是被 scope gate 误拦
  - 本地桌面 browser origin 可以直接通过 HTTP 读取 session history
- 如果上游后续再改 `chat.history` 返回模型、消息清洗顺序、trusted HTTP auth 或 browser origin 策略，同步后必须先人工复核这里

### 14. Computer Use 工具、client-host 调用协议与桌面能力绑定

涉及文件：

- `src/computer-use/types.ts`
- `src/computer-use/schema.ts`
- `src/computer-use/observation-continuation.ts`
- `src/agents/tools/computer-use-tool.ts`
- `src/agents/tools/computer-use/approval-policy.ts`
- `src/agents/tools/computer-use/gateway-normalizers.ts`
- `src/agents/tools/computer-use/gateway-payloads.ts`
- `src/agents/tools/computer-use/perception.ts`
- `src/agents/tools/computer-use/target-discovery.ts`
- `src/agents/pi-embedded-runner/computer-use-observation-context.ts`
- `src/agents/pi-embedded-runner/run.ts`
- `src/agents/pi-embedded-runner/run/attempt.ts`
- `src/agents/pi-embedded-runner/run/params.ts`
- `src/agents/openai-ws-message-conversion.ts`
- `src/agents/openai-ws-stream.ts`
- `src/agents/openclaw-tools.ts`
- `src/agents/pi-tools.ts`
- `src/agents/tool-catalog.ts`
- `src/gateway/client-host-registry.ts`
- `src/gateway/client-capability-bindings.ts`
- `src/gateway/server-methods/client-host.ts`
- `src/gateway/server-methods/chat.ts`
- `src/gateway/server-methods/sessions.ts`
- `src/gateway/protocol/schema/client-host.ts`
- `src/gateway/protocol/schema/logs-chat.ts`
- `src/gateway/protocol/schema/sessions.ts`
- `src/gateway/protocol/index.ts`
- `src/config/sessions/types.ts`
- `src/config/sessions/store-load.ts`

必须确认：

- `computer_use` 工具仍然通过 gateway `client.invoke` 调用本地桌面 host，不能退回成服务端直接假定有本地 GUI 能力
- `client.invoke` / `client.invoke.result` 协议 schema、method scope、handler 和 `client.invoke.request` event 仍然成套注册
- `chat.send.extensions.computerUse` 和 `sessions.patch.computerUse` 仍然会写入 session 的 `computerUse` 配置，并在本地客户端有能力时写入 `clientCapabilityBindings.computer_use`
- session load / patch 仍然会规范化并保留 `computerUse` 与 `clientCapabilityBindings`，不能被 store migration 或 patch sanitizer 丢掉
- OpenAI WebSocket incremental replay 仍然会把 `computer_use` observation continuation user input 和 tool result 一起发送，不能只发送 tool result
- computer-use observe 结果里的截图、AX snapshot、OCR / CDP 信息和候选目标仍然会被归一化成 `computer_use/v1` structured payload
- observe 后的大图仍然通过 observation continuation 放回上下文，避免把截图长期留在旧 tool result 里膨胀上下文
- click / type / key / scroll / drag / focus / navigate 等控制类动作仍然走 approval policy，不能绕过 `openclaw.computer_use` 审批插件语义
- abort 持久化仍然不会重复写入已经落盘的 assistant partial，特别是包含 `computer_use` tool call / tool result 的 transcript
- canvas A2UI copy 脚本仍然保留执行位和目标复制语义，避免打包后桌面端缺失 client-host UI bundle

背景：

- 这是 2026-04-26 为桌面端 Computer Use 集成补充的本地协议增强
- 下游当前依赖的是：
  - gateway 只负责路由和协议，不直接执行本机 GUI 操作
  - 桌面 host 通过连接能力暴露 `computer_use`，agent session 通过 capability binding 定向调用
  - OpenAI WebSocket 会话可以在多轮 observe / act 中稳定携带 observation continuation
- 如果上游后续改 gateway client 连接模型、session patch、OpenAI WS incremental input 或工具审批逻辑，同步后必须先人工复核这里

### 15. Runtime model fast path、外部认证同步与 provider auth 选择

涉及文件：

- `src/agents/pi-embedded-runner/runtime-model-fastpath.ts`
- `src/agents/pi-embedded-runner/run.runtime-model-fastpath.test.ts`
- `src/agents/pi-embedded-runner/model.ts`
- `src/agents/pi-embedded-runner/model.test.ts`
- `src/agents/pi-embedded-runner/run.ts`
- `src/agents/pi-embedded-runner/run/attempt.ts`
- `src/agents/model-auth.ts`
- `src/agents/model-auth-label.ts`
- `src/agents/model-fallback.ts`
- `src/agents/model-fallback.test.ts`
- `src/agents/auth-profiles/external-auth.ts`
- `src/agents/auth-profiles/external-cli-sync.ts`
- `src/agents/auth-profiles.external-cli-sync.test.ts`
- `src/agents/auth-profiles/store.ts`
- `src/agents/cli-credentials.ts`
- `src/plugins/provider-external-auth.types.ts`
- `src/plugins/provider-runtime.ts`
- `src/plugins/provider-runtime.test.ts`
- `src/plugins/provider-hook-runtime.ts`
- `src/plugins/providers.ts`
- `src/utils/provider-utils.ts`
- `src/utils/provider-utils.test.ts`

必须确认：

- `video-workflow` 这类 host runtime 原生 provider 仍然走 runtime model fast path，不能被 PI `models.json` catalog 冷启动生成拖慢首轮。
- `pluginHarnessOwnsTransport` 为 true 时仍然保持已有的 PI discovery skip 路径，不能错误走 runtime fast path。
- 外部 CLI auth profile 同步仍然能写入、更新、标注和加载 provider-owned 凭据，不能把外部凭据误归类成普通手填 key。
- model fallback 保留 provider/auth profile 选择语义，不能在 fallback 后丢失 auth source、label 或 provider-owned external auth。
- provider hook runtime 和 provider registry 仍然把外部认证能力暴露给运行时，不要只更新类型而忘记 runtime 分发。

背景：

- 这是 2026-05-02 为 `video_workflow` 原生 provider 首轮响应和外部 CLI 凭据同步补充的本地能力。
- 下游当前依赖的是：
  - 原生 runtime provider 不被 OpenClaw/PI catalog 生成阻塞。
  - provider-owned external auth 能在配置、fallback、运行时和 UI label 中保持一致。
  - 模型切换和 fallback 不会静默切到没有凭据的 provider。

### 16. Chat recall、session create/patch 字段与 memory flush 等待语义

涉及文件：

- `src/gateway/server-methods/chat.ts`
- `src/gateway/server-methods/chat.directive-tags.test.ts`
- `src/gateway/server-methods/sessions.ts`
- `src/gateway/server.sessions.gateway-server-sessions-a.test.ts`
- `src/gateway/sessions-patch.ts`
- `src/gateway/sessions-patch.test.ts`
- `src/gateway/sessions-history-http.ts`
- `src/gateway/protocol/schema/logs-chat.ts`
- `src/gateway/protocol/schema/sessions.ts`
- `src/gateway/protocol/schema/protocol-schemas.ts`
- `src/gateway/protocol/schema/types.ts`
- `src/gateway/protocol/index.ts`
- `src/gateway/method-scopes.ts`
- `src/gateway/server-methods-list.ts`
- `apps/macos/Sources/OpenClawProtocol/GatewayModels.swift`
- `apps/shared/OpenClawKit/Sources/OpenClawProtocol/GatewayModels.swift`

必须确认：

- `chat.recallLatest` 仍然注册在 schema、method list、method scopes 和 protocol index 中，并且只移除最新 user turn 以及其后的 transcript entries。
- recall 写 transcript 时必须使用 session write lock/原子写入，不能在 active run 未 settle 时截断正在写入的 transcript。
- `sessions.create` 仍然支持 `reasoningLevel`、`verboseLevel` 和 `computerUse`，生成的 Swift GatewayModels 也必须同步包含这些字段。
- `sessions.memoryFlush` 的 `wait` 参数仍然存在，调用方可选择等待 memory flush 完成。
- `sessions.patch` 仍然保留 computer use config 和 client capability binding 的规范化/差异判断，不能把桌面能力绑定误清空。
- session history HTTP 改动后仍然维持本地历史读取认证和 CORS 语义，不能与 `chat.history` 分叉。

背景：

- 这是 2026-05-02 为下游桌面 chat 编辑/撤回、session 创建参数透传、memory flush 等待和生成协议模型补充的本地协议增强。
- 这类改动同时影响 gateway RPC、HTTP history、客户端生成模型和桌面 UI；同步上游 schema 时必须成套复核。

### 17. OpenClaw-managed tool 注册、工具创建耗时与媒体工具模型配置

涉及文件：

- `src/agents/tool-create-timing.ts`
- `src/agents/openclaw-tools.ts`
- `src/agents/pi-tools.ts`
- `src/agents/pi-embedded-runner/run/attempt.tool-registration.test.ts`
- `src/agents/pi-embedded-runner/run/attempt.spawn-workspace.test-support.ts`
- `src/agents/tools/model-config.helpers.ts`
- `src/agents/tools/image-generate-tool.ts`
- `src/agents/tools/image-generate-tool.test.ts`
- `src/agents/tools/image-tool.ts`
- `src/agents/tools/music-generate-tool.ts`
- `src/agents/tools/music-generate-tool.test.ts`
- `src/agents/tools/pdf-tool.ts`
- `src/agents/tools/video-generate-tool.ts`
- `src/agents/tools/video-generate-tool.test.ts`
- `src/plugins/tools.ts`
- `src/plugins/capability-provider-runtime.ts`
- `src/plugins/capability-provider-runtime.test.ts`

必须确认：

- OpenClaw-managed custom tools 仍然作为 Pi session 的 tool allowlist 传入，不能因为上游 tool catalog 改动导致 `sessions_spawn` 等本地工具未注册。
- tool create timing 只记录慢路径并保持低开销，不能把日志记录放到每次工具执行热路径。
- image/music/video/pdf 相关工具仍然能读取 model config helper 和 provider capability runtime，不能退回到硬编码 provider/model。
- capability provider runtime 仍然能支持插件暴露的媒体能力，不能只保留核心 provider。

背景：

- 这是 2026-05-02 为多媒体工具、session 工具注册和首轮工具创建性能排查补充的本地能力。
- 下游当前依赖 Pi session 明确知道 OpenClaw-managed tools；否则 agent 可见工具和实际 OpenClaw tool catalog 会分叉。

### 18. Session memory hook、标题 slug 与 transcript event 兼容

涉及文件：

- `src/hooks/bundled/session-memory/handler.ts`
- `src/hooks/bundled/session-memory/handler.test.ts`
- `src/hooks/llm-slug-generator.ts`
- `src/hooks/llm-slug-generator.test.ts`
- `src/sessions/transcript-events.ts`
- `src/sessions/transcript-events.test.ts`
- `src/gateway/server-session-events.ts`
- `src/gateway/server-startup-post-attach.ts`
- `src/gateway/server-startup.test.ts`
- `src/infra/heartbeat-runner.ts`
- `src/infra/heartbeat-runner.ghost-reminder.test.ts`

必须确认：

- session-memory hook 仍然能处理当前 transcript event 结构，不能因为上游 transcript event schema 调整丢失 memory 写入。
- LLM slug generator 仍然对标题/会话名生成保持稳定和可回退，不能把非法字符或空结果写入用户可见 session title。
- `server-session-events` 和 startup post-attach 改动后，订阅事件仍然在 gateway 启动后正确挂载。
- heartbeat ghost reminder 仍然按当前 session/event 状态触发，不能因为 startup 或 session event refactor 静默失效。

背景：

- 这是 2026-05-02 为 session memory、session title/slug 和 gateway session event 生命周期补充的本地检查点。
- 这些路径通常不会被单个端到端测试完整覆盖，同步上游时必须至少跑相关单测并人工核查事件字段。

### 19. Browser Use 工具、session 配置与桌面浏览器能力绑定

涉及文件：

- `src/browser-use/types.ts`
- `src/browser-use/schema.ts`
- `src/agents/tools/browser-use-tool.ts`
- `src/agents/openclaw-tools.ts`
- `src/agents/pi-tools.ts`
- `src/agents/tool-catalog.ts`
- `src/agents/command/attempt-execution.ts`
- `src/agents/pi-embedded-runner/run.ts`
- `src/agents/pi-embedded-runner/run/attempt.ts`
- `src/agents/pi-embedded-runner/run/params.ts`
- `src/agents/pi-embedded-runner/run.attempt-param-forwarding.test.ts`
- `src/auto-reply/reply/agent-runner-utils.ts`
- `src/auto-reply/reply/commands-system-prompt.ts`
- `src/auto-reply/reply/followup-runner.ts`
- `src/auto-reply/reply/get-reply-run.ts`
- `src/auto-reply/reply/queue/types.ts`
- `src/config/sessions/types.ts`
- `src/gateway/protocol/schema/logs-chat.ts`
- `src/gateway/protocol/schema/sessions.ts`
- `src/gateway/server-methods/chat.ts`
- `src/gateway/server-methods/sessions.ts`
- `src/gateway/session-utils.ts`
- `src/gateway/session-utils.types.ts`
- `src/gateway/sessions-patch.ts`

必须确认：

- `browser_use` 工具仍然通过 gateway `client.invoke` 调用桌面端 Browser Use host，不能退回成服务端直接执行浏览器自动化。
- `BrowserUseSessionConfig` 仍然在 session entry、`RunEmbeddedPiAgentParams`、chat send extension、`sessions.create` 和 `sessions.patch` 中端到端透传。
- `chat.send.extensions.browserUse` 和 `sessions.patch.browserUse` 仍然会写入 session 的 `browserUse` 配置，并在本地客户端有能力时写入 `clientCapabilityBindings.browser_use`。
- `browser_use` 工具只在 session 配置启用时注册到 OpenClaw tool catalog / Pi tools，不能默认暴露给所有会话。
- `browser_use` structured result 必须保持 `browser_use/v1`，并区分 `status/sessions/navigate/observe/click/double_click/type/scroll/wait/close` 动作。
- element 操作必须要求 `ref` 或 `selector`，`type` 必须要求 `text`，不能把不完整动作透传给桌面 host。
- `activation: required` 仍然能改变工具描述中的使用指令，保障用户显式选择 Browser Use 后 agent 优先使用该工具。
- `followup`、queue 和 command execution 路径必须继续传递 `browserUse`，不能只覆盖普通 chat send 首轮。

背景：

- 这是 2026-05-02 为桌面端 Browser Use 集成补充的本地协议增强。
- 下游当前依赖的是：
  - gateway 只做能力路由和 session 绑定，不直接拥有浏览器执行环境。
  - 桌面端 Browser Use host 通过 `client.invoke` 暴露浏览器状态、DOM observation 和动作执行。
  - agent session 通过 `browserUse` 配置和 `clientCapabilityBindings.browser_use` 定向调用当前桌面客户端。
- 如果上游后续改 tool catalog、session patch sanitizer、chat send extensions 或 client capability binding，同步后必须先人工复核这里。

### 20. Interactive capability 结果分类、Computer Use 目标策略与 interrupted tool tail 修复

涉及文件：

- `src/interactive-capability/types.ts`
- `src/browser-use/types.ts`
- `src/browser-use/schema.ts`
- `src/agents/tools/browser-use-tool.ts`
- `src/agents/tools/browser-use-tool.test.ts`
- `src/computer-use/types.ts`
- `src/computer-use/schema.ts`
- `src/agents/tools/computer-use-tool.ts`
- `src/agents/tools/computer-use-tool.test.ts`
- `src/agents/tools/computer-use/action-target-policy.ts`
- `src/agents/tools/computer-use/schema.ts`
- `src/agents/tools/computer-use/perception.ts`
- `src/gateway/node-command-policy.ts`
- `src/agents/interrupted-tool-tail-repair.ts`
- `src/agents/main-session-restart-recovery.ts`
- `src/agents/main-session-restart-recovery.test.ts`
- `src/gateway/server-methods/chat.ts`
- `src/gateway/server-methods/chat.abort-persistence.test.ts`
- `src/agents/openclaw-tools.ts`
- `src/agents/pi-embedded-runner/run/attempt.ts`
- `src/agents/pi-embedded-runner/run.attempt-param-forwarding.test.ts`
- `src/auto-reply/reply/commands-system-prompt.test.ts`
- `src/auto-reply/reply/followup-runner.test.ts`

必须确认：

- Browser Use 和 Computer Use 仍然共享 interactive capability 的调用元数据语义，structured result 必须保留 `activation` 和 `source`，不能在工具执行后丢失桌面端能力来源。
- Browser Use 对 gateway payload 的 `success / failed / approval_required / error` 分类仍然会映射成模型可读文本和结构化错误结果，不能把 host 返回的 observation、action payload 或审批状态吞掉。
- Browser Use observation 文本仍然包含 title、URL、readable text 和 visible element refs；没有显式 `browserSessionId` 时仍然以当前 OpenClaw session key 作为 owner fallback。
- Computer Use action target policy 仍然区分读取类命令和控制类动作；`computer.targets`、`computer.ocr`、`computer.cdp` 必须保持 read policy，`computer.action` 必须继续走 action policy 和审批语义。
- Computer Use schema、types 和 agent tool 内部 schema 必须与 public session config 对齐，不能让 `activation`、`source` 或 target policy 字段在协议层和工具层分叉。
- `chat.abort` 和 main session restart recovery 都必须在发现 transcript 尾部是未闭合 assistant tool call 时，追加 synthetic error tool result，避免会话因为缺失 tool result 无法继续。
- interrupted tool tail 修复必须使用 session write lock，并且只修复 SessionManager transcript；非 SessionManager 或不可安全定位的 transcript 只能 warning 后跳过。
- restart recovery 必须先把 transcript 修成 resumable tail 再恢复运行；如果 tail 仍不可恢复，不能强行继续。
- abort partial 持久化仍然不能重复写入已经落盘的 assistant partial；即使没有 partial text，也要能补齐缺失的 tool result。

背景：

- 这是 2026-05-04 为桌面 interactive capability、Browser/Computer Use host 返回语义和 abort/restart 后 transcript 可恢复性补充的本地检查点。
- 下游当前依赖的是：
  - Browser Use 和 Computer Use 都由桌面 host 执行，agent 只通过 gateway capability binding 调用。
  - host 返回的失败、审批和 observation 信息能稳定进入模型上下文，便于下一步纠错。
  - 用户 abort 或 gateway restart 后，不会留下以 assistant tool call 结尾的坏 transcript。
- 如果上游后续改 client.invoke payload、Computer Use command policy、Pi transcript replay、chat.abort 或 restart recovery，同步后必须先人工复核这里。

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
rg -n "chat\\.history|before|nextBefore|hasMore|__openclaw\\.seq" src/gateway
rg -n "isolatedSession|SUBAGENT_WAIT_TIMEOUT_SPIN_GUARD_MS" src/infra src/agents
rg -n "fallbackStreamFn|resolveEmbeddedRunStreamFn|shouldUseOpenAIWebSocketTransport" src/agents
rg -n "computer_use|client\\.invoke|clientCapabilityBindings|observation continuation|ComputerUseSessionConfig" src/agents src/computer-use src/gateway src/config
rg -n "SERPER_API_KEY|serperBaseUrl|braveMode|withTrustedWebToolsEndpoint|legacy-bundled-web-search" src/agents src/plugins src/flows
rg -n "getApiKeyAndHeaders|sourceInfo\\.source|generateSummary\\(" src/agents
rg -n "skillSettings|managedInstall|installOrigin|skills\\.uninstall|skills\\.import|resolveSkillConfig\\(" src/agents src/config src/gateway src/secrets
rg -n "video-workflow|shouldResolveRuntimeModelBeforePiCatalog|externalAuth|external-cli" src/agents src/plugins src/utils
rg -n "chat\\.recallLatest|validateChatRecallLatestParams|wait: Type\\.Optional|reasoningLevel|verboseLevel|computerUse" src/gateway apps/macos apps/shared
rg -n "recordToolCreateTiming|logToolCreateTiming|customTools|sessions_spawn|capabilityProvider" src/agents src/plugins
rg -n "session-memory|generateSlug|transcript event|ghost reminder" src/hooks src/sessions src/gateway src/infra
rg -n "browser_use|BrowserUseSessionConfig|browserUse|clientCapabilityBindings\\.browser_use|browser.action|browser.observe" src/browser-use src/agents src/auto-reply src/config src/gateway
rg -n "InteractiveCapability|activation|approval_required|action-target-policy|computer\\.targets|computer\\.ocr|computer\\.cdp|appendSyntheticInterruptedToolResults|isSessionTranscriptResumable" src/interactive-capability src/browser-use src/computer-use src/agents src/gateway
```

### D. 验证范围

至少跑本地功能相关测试，再跑一次构建。

核心同步回归测试：

```sh
pnpm test -- \
  src/gateway/server.health.test.ts \
  src/gateway/server.sessions.gateway-server-sessions-a.test.ts \
  src/gateway/server.chat.gateway-server-chat-b.test.ts \
  src/gateway/sessions-history-http.test.ts \
  src/gateway/server-methods/events.test.ts \
  src/infra/heartbeat-runner.scheduler.test.ts \
  src/infra/heartbeat-runner.returns-default-unset.test.ts \
  src/agents/pi-embedded-runner/run/attempt.test.ts \
  src/agents/pi-embedded-runner/run/stream-selection.test.ts \
  src/agents/openai-ws-stream.test.ts \
  src/agents/main-session-restart-recovery.test.ts \
  src/agents/tools/browser-use-tool.test.ts \
  src/agents/tools/computer-use-tool.test.ts \
  src/agents/pi-embedded-runner/computer-use-observation-context.test.ts \
  src/agents/pi-embedded-runner/run.attempt-param-forwarding.test.ts \
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
  src/secrets/exec-secret-ref-id-parity.test.ts \
  src/config/zod-schema.agent-defaults.test.ts \
  src/gateway/server-methods/chat.directive-tags.test.ts \
  src/gateway/server-methods/chat.abort-persistence.test.ts \
  src/gateway/server-plugin-approval.e2e.test.ts \
  src/scripts/canvas-a2ui-copy.test.ts \
  src/agents/pi-embedded-runner/run.runtime-model-fastpath.test.ts \
  src/agents/pi-embedded-runner/run/attempt.tool-registration.test.ts \
  src/agents/pi-embedded-runner/model.test.ts \
  src/agents/auth-profiles.external-cli-sync.test.ts \
  src/agents/model-fallback.test.ts \
  src/agents/tools/image-generate-tool.test.ts \
  src/agents/tools/music-generate-tool.test.ts \
  src/agents/tools/video-generate-tool.test.ts \
  src/gateway/sessions-patch.test.ts \
  src/gateway/server-startup.test.ts \
  src/hooks/bundled/session-memory/handler.test.ts \
  src/hooks/llm-slug-generator.test.ts \
  src/infra/heartbeat-runner.ghost-reminder.test.ts \
  src/plugins/capability-provider-runtime.test.ts \
  src/plugins/provider-runtime.test.ts \
  src/sessions/transcript-events.test.ts \
  src/utils/provider-utils.test.ts
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

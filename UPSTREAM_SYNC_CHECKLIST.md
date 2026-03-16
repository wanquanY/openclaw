# 上游同步检查清单

这是一份仓库内使用的检查文档，用来在同步 `upstream/main` 之后，核对本地实现的功能是否仍然完整。

只要发生下面这些情况，都建议按这份清单检查一遍：

- 从上游拉取大量更新并合并到本地分支
- 把本地 `prod` 上的定制功能迁移到新同步分支
- 手工解决完上游同步冲突之后
- 准备把同步分支再合回本地稳定分支之前

## 目标

确认上游同步没有把本地定制功能静默覆盖、删掉，或者改出行为回归。

## 本地实现功能清单

每次同步后都要检查下面这些模块。以后如果本地又新增了新的定制功能，也要及时补进这份文档。

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

### 7. Web search 默认配置与 provider 参数透传

涉及文件：

- `src/agents/tools/web-search.ts`
- `src/agents/tools/web-search.test.ts`
- `src/agents/tools/web-tools.enabled-defaults.test.ts`
- `src/config/types.tools.ts`
- `src/config/zod-schema.agent-runtime.ts`

必须确认：

- 本地默认 provider 逻辑仍然存在
- Brave mode 相关处理仍然存在
- Serper 仍然支持 `country` 和 `search_lang` 透传
- runtime config 和 schema 仍然暴露本地 web-search 设置

### 8. Session rollover 历史保留

涉及文件：

- `src/auto-reply/reply/session.ts`
- `src/auto-reply/reply/session.test.ts`
- `src/config/sessions/sessions.test.ts`

必须确认：

- 创建新 session 时仍然会保留 `previousSessions`
- reset 或 freshness rollover 后，旧 session 链路仍然会正确写回

### 9. 生成协议模型漂移

涉及文件：

- `apps/macos/Sources/OpenClawProtocol/GatewayModels.swift`
- `apps/shared/OpenClawKit/Sources/OpenClawProtocol/GatewayModels.swift`
- `src/gateway/protocol/schema/*.ts`

必须确认：

- 生成给客户端使用的协议模型，仍然覆盖本地依赖的 gateway / session 字段
- 上游 schema 更新没有把下游客户端仍依赖的本地字段静默删掉

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
rg -n "SERPER_API_KEY|serperBaseUrl|braveMode" src/agents/tools/web-search.ts
```

### D. 验证范围

至少跑本地功能相关测试，再跑一次构建。

核心同步回归测试：

```sh
pnpm exec vitest run \
  src/gateway/server.health.test.ts \
  src/gateway/server.sessions.gateway-server-sessions-a.test.ts \
  src/gateway/server.chat.gateway-server-chat-b.test.ts \
  src/gateway/server-methods/events.test.ts \
  src/infra/heartbeat-runner.scheduler.test.ts \
  src/infra/heartbeat-runner.returns-default-unset.test.ts \
  src/agents/pi-embedded-runner/run/attempt.test.ts \
  src/agents/tools/web-search.test.ts \
  src/agents/tools/web-tools.enabled-defaults.test.ts
```

本地功能保留测试：

```sh
pnpm exec vitest run \
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

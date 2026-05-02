import crypto from "node:crypto";
import { resolveSessionAuthProfileOverride } from "../../agents/auth-profiles/session-override.js";
import type { ExecToolDefaults } from "../../agents/bash-tools.js";
import { resolveFastModeState } from "../../agents/fast-mode.js";
import { resolveEmbeddedFullAccessState } from "../../agents/pi-embedded-runner/sandbox-info.js";
import type { EmbeddedFullAccessBlockedReason } from "../../agents/pi-embedded-runner/types.js";
import { buildCompressedSessionMemoryPrompt } from "../../config/sessions/compressed-memory.js";
import { resolveGroupSessionKey } from "../../config/sessions/group.js";
import {
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
} from "../../config/sessions/paths.js";
import { resolveSessionStoreEntry } from "../../config/sessions/store.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { clearCommandLane, getQueueSize } from "../../process/command-queue.js";
import { normalizeMainKey } from "../../routing/session-key.js";
import { defaultRuntime } from "../../runtime.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { isReasoningTagProvider } from "../../utils/provider-utils.js";
import { hasControlCommand } from "../command-detection.js";
import { resolveEnvelopeFormatOptions } from "../envelope.js";
import type { MsgContext, TemplateContext } from "../templating.js";
import {
  type ElevatedLevel,
  formatXHighModelHint,
  normalizeThinkLevel,
  type ReasoningLevel,
  supportsXHighThinking,
  type ThinkLevel,
  type VerboseLevel,
} from "../thinking.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { applySessionHints } from "./body.js";
import type { buildCommandContext } from "./commands.js";
import type { InlineDirectives } from "./directive-handling.js";
import { shouldUseReplyFastTestRuntime } from "./get-reply-fast-path.js";
import { resolvePreparedReplyQueueState } from "./get-reply-run-queue.js";
import { buildGroupChatContext, buildGroupIntro } from "./groups.js";
import { buildInboundMetaSystemPrompt, buildInboundUserContextPrefix } from "./inbound-meta.js";
import type { createModelSelectionState } from "./model-selection.js";
import { resolveOriginMessageProvider } from "./origin-routing.js";
import { buildReplyPromptBodies } from "./prompt-prelude.js";
import { resolveActiveRunQueueAction } from "./queue-policy.js";
import { resolveQueueSettings } from "./queue/settings-runtime.js";
import { buildBareSessionResetPrompt } from "./session-reset-prompt.js";
import { drainFormattedSystemEvents } from "./session-system-events.js";
import { buildSessionStartupContextPrelude, shouldApplyStartupContext } from "./startup-context.js";
import { resolveTypingMode } from "./typing-mode.js";
import { resolveRunTypingPolicy } from "./typing-policy.js";
import type { TypingController } from "./typing.js";

type AgentDefaults = NonNullable<OpenClawConfig["agents"]>["defaults"];
type ExecOverrides = Pick<ExecToolDefaults, "host" | "security" | "ask" | "node">;

export function buildExecOverridePromptHint(params: {
  execOverrides?: ExecOverrides;
  elevatedLevel: ElevatedLevel;
  fullAccessAvailable?: boolean;
  fullAccessBlockedReason?: EmbeddedFullAccessBlockedReason;
}): string | undefined {
  const exec = params.execOverrides;
  if (!exec && params.elevatedLevel === "off") {
    return undefined;
  }
  const parts = [
    exec?.host ? `host=${exec.host}` : undefined,
    exec?.security ? `security=${exec.security}` : undefined,
    exec?.ask ? `ask=${exec.ask}` : undefined,
    exec?.node ? `node=${exec.node}` : undefined,
  ].filter(Boolean);
  const execLine =
    parts.length > 0
      ? `Current session exec defaults: ${parts.join(" ")}.`
      : "Current session exec defaults: inherited from configured agent/global defaults.";
  const elevatedLine = `Current elevated level: ${params.elevatedLevel}.`;
  const fullAccessLine =
    params.fullAccessAvailable === false
      ? `Auto-approved /elevated full is unavailable here (${params.fullAccessBlockedReason ?? "runtime"}). Do not ask the user to switch to /elevated full.`
      : undefined;
  return [
    "## Current Exec Session State",
    execLine,
    elevatedLine,
    fullAccessLine,
    "If the user asks to run a command, use the current exec state above. Do not assume a prior denial still applies after `/exec` or `/elevated` changed.",
  ]
    .filter(Boolean)
    .join("\n");
}

let piEmbeddedRuntimePromise: Promise<typeof import("../../agents/pi-embedded.runtime.js")> | null =
  null;
let agentRunnerRuntimePromise: Promise<typeof import("./agent-runner.runtime.js")> | null = null;
let sessionUpdatesRuntimePromise: Promise<typeof import("./session-updates.runtime.js")> | null =
  null;
let sessionStoreRuntimePromise: Promise<
  typeof import("../../config/sessions/store.runtime.js")
> | null = null;
const UNTRUSTED_SYSTEM_EVENT_LINE_RE = /^System \(untrusted\):/m;

function loadPiEmbeddedRuntime() {
  piEmbeddedRuntimePromise ??= import("../../agents/pi-embedded.runtime.js");
  return piEmbeddedRuntimePromise;
}

function loadAgentRunnerRuntime() {
  agentRunnerRuntimePromise ??= import("./agent-runner.runtime.js");
  return agentRunnerRuntimePromise;
}

function loadSessionUpdatesRuntime() {
  sessionUpdatesRuntimePromise ??= import("./session-updates.runtime.js");
  return sessionUpdatesRuntimePromise;
}

function loadSessionStoreRuntime() {
  sessionStoreRuntimePromise ??= import("../../config/sessions/store.runtime.js");
  return sessionStoreRuntimePromise;
}

export async function prewarmGetReplyRunRuntime(): Promise<void> {
  await Promise.all([
    loadPiEmbeddedRuntime(),
    loadAgentRunnerRuntime(),
    loadSessionUpdatesRuntime(),
    loadSessionStoreRuntime(),
  ]);
}

function stripPromptThinkingDirectives(body: string): string {
  return body
    .split("\n")
    .map((line) =>
      line
        .replace(/(^|\s)\/(?:thinking|think|t)(?=$|\s|:)(?:\s*:\s*|\s+)?[A-Za-z-]*/gi, "$1")
        .replace(/[ \t]{2,}/g, " ")
        .trimEnd(),
    )
    .join("\n");
}

type RunPreparedReplyParams = {
  ctx: MsgContext;
  sessionCtx: TemplateContext;
  cfg: OpenClawConfig;
  agentId: string;
  agentDir: string;
  agentCfg: AgentDefaults;
  sessionCfg: OpenClawConfig["session"];
  commandAuthorized: boolean;
  command: ReturnType<typeof buildCommandContext>;
  commandSource?: string;
  allowTextCommands: boolean;
  directives: InlineDirectives;
  defaultActivation: Parameters<typeof buildGroupIntro>[0]["defaultActivation"];
  resolvedThinkLevel: ThinkLevel | undefined;
  resolvedVerboseLevel: VerboseLevel | undefined;
  resolvedReasoningLevel: ReasoningLevel;
  resolvedElevatedLevel: ElevatedLevel;
  execOverrides?: ExecOverrides;
  elevatedEnabled: boolean;
  elevatedAllowed: boolean;
  blockStreamingEnabled: boolean;
  blockReplyChunking?: {
    minChars: number;
    maxChars: number;
    breakPreference: "paragraph" | "newline" | "sentence";
    flushOnParagraph?: boolean;
  };
  resolvedBlockStreamingBreak: "text_end" | "message_end";
  modelState: Awaited<ReturnType<typeof createModelSelectionState>>;
  provider: string;
  model: string;
  perMessageQueueMode?: InlineDirectives["queueMode"];
  perMessageQueueOptions?: {
    debounceMs?: number;
    cap?: number;
    dropPolicy?: InlineDirectives["dropPolicy"];
  };
  typing: TypingController;
  opts?: GetReplyOptions;
  defaultProvider: string;
  defaultModel: string;
  timeoutMs: number;
  isNewSession: boolean;
  resetTriggered: boolean;
  systemSent: boolean;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey: string;
  sessionId?: string;
  storePath?: string;
  workspaceDir: string;
  abortedLastRun: boolean;
};

export async function runPreparedReply(
  params: RunPreparedReplyParams,
): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  const {
    ctx,
    sessionCtx,
    cfg,
    agentId,
    agentDir,
    agentCfg,
    sessionCfg,
    commandAuthorized,
    command,
    allowTextCommands,
    directives,
    defaultActivation,
    elevatedEnabled,
    elevatedAllowed,
    blockStreamingEnabled,
    blockReplyChunking,
    resolvedBlockStreamingBreak,
    modelState,
    provider,
    model,
    perMessageQueueMode,
    perMessageQueueOptions,
    typing,
    opts,
    defaultModel,
    timeoutMs,
    isNewSession,
    resetTriggered,
    systemSent,
    sessionKey,
    sessionId,
    storePath,
    workspaceDir,
    sessionStore,
  } = params;
  let {
    sessionEntry,
    resolvedThinkLevel,
    resolvedVerboseLevel,
    resolvedReasoningLevel,
    resolvedElevatedLevel,
    execOverrides,
    abortedLastRun,
  } = params;
  const timingStartedAt = Date.now();
  let timingLastAt = timingStartedAt;
  const emitTiming = (stage: string, data?: Record<string, unknown>) => {
    if (!opts?.onTiming) {
      return;
    }
    const now = Date.now();
    opts.onTiming({
      stage: `get_reply_run.${stage}`,
      elapsedMs: now - timingStartedAt,
      deltaMs: now - timingLastAt,
      ...(data ? { data } : {}),
    });
    timingLastAt = now;
  };
  emitTiming("start", {
    sessionKey,
    provider,
    model,
    isNewSession,
    resetTriggered,
  });
  const useFastReplyRuntime = shouldUseReplyFastTestRuntime({
    cfg,
    isFastTestEnv: process.env.OPENCLAW_TEST_FAST === "1",
  });
  const fullAccessState = resolveEmbeddedFullAccessState({
    execElevated: {
      enabled: elevatedEnabled,
      allowed: elevatedAllowed,
      defaultLevel: resolvedElevatedLevel ?? "off",
    },
  });
  let currentSystemSent = systemSent;

  const isFirstTurnInSession = isNewSession || !currentSystemSent;
  const isGroupChat = sessionCtx.ChatType === "group";
  const wasMentioned = ctx.WasMentioned === true;
  const isHeartbeat = opts?.isHeartbeat === true;
  const { typingPolicy, suppressTyping } = resolveRunTypingPolicy({
    requestedPolicy: opts?.typingPolicy,
    suppressTyping: opts?.suppressTyping === true,
    isHeartbeat,
    originatingChannel: ctx.OriginatingChannel,
  });
  const typingMode = resolveTypingMode({
    configured: sessionCfg?.typingMode ?? agentCfg?.typingMode,
    isGroupChat,
    wasMentioned,
    isHeartbeat,
    typingPolicy,
    suppressTyping,
  });
  const shouldInjectGroupIntro = Boolean(
    isGroupChat && (isFirstTurnInSession || sessionEntry?.groupActivationNeedsSystemIntro),
  );
  // Always include persistent group chat context (name, participants, reply guidance)
  const groupChatContext = isGroupChat ? buildGroupChatContext({ sessionCtx }) : "";
  // Behavioral intro (activation mode, lurking, etc.) only on first turn / activation needed
  const groupIntro = shouldInjectGroupIntro
    ? buildGroupIntro({
        cfg,
        sessionCtx,
        sessionEntry,
        defaultActivation,
        silentToken: SILENT_REPLY_TOKEN,
      })
    : "";
  const groupSystemPrompt = normalizeOptionalString(sessionCtx.GroupSystemPrompt) ?? "";
  const inboundMetaPrompt = buildInboundMetaSystemPrompt(
    isNewSession ? sessionCtx : { ...sessionCtx, ThreadStarterBody: undefined },
    { includeFormattingHints: !useFastReplyRuntime },
  );
  const extraSystemPromptParts = [
    inboundMetaPrompt,
    groupChatContext,
    groupIntro,
    groupSystemPrompt,
    buildCompressedSessionMemoryPrompt(sessionEntry),
    buildExecOverridePromptHint({
      execOverrides,
      elevatedLevel: resolvedElevatedLevel,
      fullAccessAvailable: fullAccessState.available,
      fullAccessBlockedReason: fullAccessState.blockedReason,
    }),
  ].filter(Boolean);
  const baseBody = sessionCtx.BodyStripped ?? sessionCtx.Body ?? "";
  // Use CommandBody/RawBody for bare reset detection (clean message without structural context).
  const rawBodyTrimmed = (ctx.CommandBody ?? ctx.RawBody ?? ctx.Body ?? "").trim();
  const baseBodyTrimmedRaw = baseBody.trim();
  const normalizedCommandBody = command.commandBodyNormalized.trim();
  const isWholeMessageCommand =
    normalizedCommandBody === rawBodyTrimmed ||
    normalizedCommandBody === rawBodyTrimmed.toLowerCase();
  const isResetOrNewCommand = /^\/(new|reset)(?:\s|$)/.test(normalizedCommandBody);
  if (
    allowTextCommands &&
    (!commandAuthorized || !command.isAuthorizedSender) &&
    isWholeMessageCommand &&
    (hasControlCommand(rawBodyTrimmed, cfg) || isResetOrNewCommand)
  ) {
    typing.cleanup();
    return undefined;
  }
  const isBareNewOrReset = /^\/(new|reset)$/.test(normalizedCommandBody);
  const isBareSessionReset =
    isNewSession &&
    ((baseBodyTrimmedRaw.length === 0 && rawBodyTrimmed.length > 0) || isBareNewOrReset);
  const startupAction = /^\/reset(?:\s|$)/.test(normalizedCommandBody) ? "reset" : "new";
  const startupContextPrelude =
    isBareSessionReset && shouldApplyStartupContext({ cfg, action: startupAction })
      ? await buildSessionStartupContextPrelude({
          workspaceDir,
          cfg,
        })
      : null;
  emitTiming("prompt_context_ready", {
    isFirstTurnInSession,
    isBareSessionReset,
    hasStartupContextPrelude: Boolean(startupContextPrelude),
  });
  const baseBodyFinal = isBareSessionReset
    ? buildBareSessionResetPrompt(cfg)
    : stripPromptThinkingDirectives(baseBody);
  const envelopeOptions = resolveEnvelopeFormatOptions(cfg);
  const inboundUserContext = buildInboundUserContextPrefix(
    isNewSession
      ? {
          ...sessionCtx,
          ...(normalizeOptionalString(sessionCtx.ThreadHistoryBody)
            ? { InboundHistory: undefined, ThreadStarterBody: undefined }
            : {}),
        }
      : { ...sessionCtx, ThreadStarterBody: undefined },
    envelopeOptions,
  );
  const baseBodyForPrompt = isBareSessionReset
    ? [startupContextPrelude, baseBodyFinal].filter(Boolean).join("\n\n")
    : [inboundUserContext, baseBodyFinal].filter(Boolean).join("\n\n");
  const baseBodyTrimmed = baseBodyForPrompt.trim();
  const hasMediaAttachment = Boolean(
    sessionCtx.MediaPath || (sessionCtx.MediaPaths && sessionCtx.MediaPaths.length > 0),
  );
  if (!baseBodyTrimmed && !hasMediaAttachment) {
    // Skip onReplyStart when typing is suppressed (e.g. sendPolicy deny) —
    // otherwise channels that wire onReplyStart to typing indicators leak
    // visible signals even though outbound delivery is suppressed.
    if (!suppressTyping) {
      await typing.onReplyStart();
    }
    logVerbose("Inbound body empty after normalization; skipping agent run");
    typing.cleanup();
    return {
      text: "I didn't receive any text in your message. Please resend or add a caption.",
    };
  }
  // When the user sends media without text, provide a minimal body so the agent
  // run proceeds and the image/document is injected by the embedded runner.
  const effectiveBaseBody = baseBodyTrimmed
    ? baseBodyForPrompt
    : "[User sent media without caption]";
  let prefixedBodyBase = await applySessionHints({
    baseBody: effectiveBaseBody,
    abortedLastRun,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    abortKey: command.abortKey,
  });
  emitTiming("session_hints_ready", {
    hasMediaAttachment,
    baseBodyChars: baseBodyForPrompt.length,
  });
  const isGroupSession = sessionEntry?.chatType === "group" || sessionEntry?.chatType === "channel";
  const isMainSession = !isGroupSession && sessionKey === normalizeMainKey(sessionCfg?.mainKey);
  // Extract first-token think hint from the user body BEFORE prepending system events.
  // If done after, the System: prefix becomes parts[0] and silently shadows any
  // low|medium|high shorthand the user typed.
  if (!resolvedThinkLevel && prefixedBodyBase) {
    const parts = prefixedBodyBase.split(/\s+/);
    const maybeLevel = normalizeThinkLevel(parts[0]);
    if (maybeLevel && (maybeLevel !== "xhigh" || supportsXHighThinking(provider, model))) {
      resolvedThinkLevel = maybeLevel;
      prefixedBodyBase = parts.slice(1).join(" ").trim();
    }
  }
  const prefixedBodyCore = prefixedBodyBase;
  const threadStarterBody = normalizeOptionalString(ctx.ThreadStarterBody);
  const threadHistoryBody = normalizeOptionalString(ctx.ThreadHistoryBody);
  const threadContextNote = threadHistoryBody
    ? `[Thread history - for context]\n${threadHistoryBody}`
    : threadStarterBody
      ? `[Thread starter - for context]\n${threadStarterBody}`
      : undefined;
  const drainedSystemEventBlocks: string[] = [];
  let forceSenderIsOwnerFalseFromSystemEvents = false;
  const rebuildPromptBodies = async (): Promise<{
    prefixedCommandBody: string;
    queuedBody: string;
  }> => {
    if (!useFastReplyRuntime) {
      const eventsBlock = await drainFormattedSystemEvents({
        cfg,
        sessionKey,
        isMainSession,
        isNewSession,
      });
      if (eventsBlock) {
        drainedSystemEventBlocks.push(eventsBlock);
        if (UNTRUSTED_SYSTEM_EVENT_LINE_RE.test(eventsBlock)) {
          forceSenderIsOwnerFalseFromSystemEvents = true;
        }
      }
    }
    return buildReplyPromptBodies({
      ctx,
      sessionCtx,
      effectiveBaseBody,
      prefixedBody: prefixedBodyCore,
      threadContextNote,
      systemEventBlocks: drainedSystemEventBlocks,
    });
  };
  const skillResult =
    process.env.OPENCLAW_TEST_FAST === "1"
      ? {
          sessionEntry,
          skillsSnapshot: sessionEntry?.skillsSnapshot,
          systemSent: currentSystemSent,
        }
      : await (async () => {
          const { ensureSkillSnapshot } = await loadSessionUpdatesRuntime();
          return ensureSkillSnapshot({
            sessionEntry,
            sessionStore,
            sessionKey,
            storePath,
            sessionId,
            isFirstTurnInSession,
            workspaceDir,
            cfg,
            skillFilter: opts?.skillFilter,
          });
        })();
  emitTiming("skills_snapshot_ready", {
    hasSkillsSnapshot: Boolean(skillResult.skillsSnapshot),
  });
  sessionEntry = skillResult.sessionEntry ?? sessionEntry;
  currentSystemSent = skillResult.systemSent;
  const skillsSnapshot = skillResult.skillsSnapshot;
  let { prefixedCommandBody, queuedBody } = await rebuildPromptBodies();
  if (!resolvedThinkLevel) {
    resolvedThinkLevel = await modelState.resolveDefaultThinkingLevel();
  }
  emitTiming("thinking_level_ready", { resolvedThinkLevel });
  if (resolvedThinkLevel === "xhigh" && !supportsXHighThinking(provider, model)) {
    const explicitThink = directives.hasThinkDirective && directives.thinkLevel !== undefined;
    if (explicitThink) {
      typing.cleanup();
      return {
        text: `Thinking level "xhigh" is only supported for ${formatXHighModelHint()}. Use /think high or switch to one of those models.`,
      };
    }
    resolvedThinkLevel = "high";
    if (sessionEntry && sessionStore && sessionKey && sessionEntry.thinkingLevel === "xhigh") {
      sessionEntry.thinkingLevel = "high";
      sessionEntry.updatedAt = Date.now();
      sessionStore[sessionKey] = sessionEntry;
      if (storePath) {
        const { updateSessionStore } = await loadSessionStoreRuntime();
        await updateSessionStore(storePath, (store) => {
          store[sessionKey] = sessionEntry;
        });
      }
    }
  }
  const sessionIdFinal = sessionId ?? crypto.randomUUID();
  const sessionFilePathOptions = resolveSessionFilePathOptions({ agentId, storePath });
  const resolvePreparedSessionState = (): {
    sessionEntry: SessionEntry | undefined;
    sessionId: string;
    sessionFile: string;
  } => {
    const latestSessionEntry =
      sessionStore && sessionKey
        ? (resolveSessionStoreEntry({
            store: sessionStore,
            sessionKey,
          }).existing ?? sessionEntry)
        : sessionEntry;
    const latestSessionId = latestSessionEntry?.sessionId ?? sessionIdFinal;
    return {
      sessionEntry: latestSessionEntry,
      sessionId: latestSessionId,
      sessionFile: resolveSessionFilePath(
        latestSessionId,
        latestSessionEntry,
        sessionFilePathOptions,
      ),
    };
  };
  let preparedSessionState = resolvePreparedSessionState();
  const resolvedQueue = useFastReplyRuntime
    ? {
        mode: "collect" as const,
        debounceMs: 0,
        cap: 1,
        dropPolicy: "summarize" as const,
      }
    : resolveQueueSettings({
        cfg,
        channel: sessionCtx.Provider,
        sessionEntry,
        inlineMode: perMessageQueueMode,
        inlineOptions: perMessageQueueOptions,
      });
  const piRuntime = useFastReplyRuntime ? null : await loadPiEmbeddedRuntime();
  emitTiming("pi_runtime_ready", {
    useFastReplyRuntime,
    hasPiRuntime: Boolean(piRuntime),
  });
  const sessionLaneKey = piRuntime
    ? piRuntime.resolveEmbeddedSessionLane(sessionKey ?? sessionIdFinal)
    : undefined;
  const laneSize = sessionLaneKey ? getQueueSize(sessionLaneKey) : 0;
  if (resolvedQueue.mode === "interrupt" && sessionLaneKey && laneSize > 0) {
    const cleared = clearCommandLane(sessionLaneKey);
    const activeSessionId = piRuntime?.resolveActiveEmbeddedRunSessionId(sessionKey);
    const aborted = piRuntime?.abortEmbeddedPiRun(
      activeSessionId ?? preparedSessionState.sessionId,
    );
    logVerbose(`Interrupting ${sessionLaneKey} (cleared ${cleared}, aborted=${aborted})`);
  }
  let authProfileId = useFastReplyRuntime
    ? undefined
    : await resolveSessionAuthProfileOverride({
        cfg,
        provider,
        agentDir,
        sessionEntry: preparedSessionState.sessionEntry,
        sessionStore,
        sessionKey,
        storePath,
        isNewSession,
      });
  emitTiming("auth_profile_ready", {
    hasAuthProfile: Boolean(authProfileId),
  });
  const { runReplyAgent } = await loadAgentRunnerRuntime();
  emitTiming("agent_runner_runtime_ready");
  const queueKey = sessionKey ?? sessionIdFinal;
  preparedSessionState = resolvePreparedSessionState();
  const resolveActiveQueueSessionId = () =>
    piRuntime?.resolveActiveEmbeddedRunSessionId(sessionKey) ?? preparedSessionState.sessionId;
  const resolveQueueBusyState = () => {
    const activeSessionId = resolveActiveQueueSessionId();
    if (!activeSessionId || !piRuntime) {
      return { activeSessionId: undefined, isActive: false, isStreaming: false };
    }
    return {
      activeSessionId,
      isActive: piRuntime.isEmbeddedPiRunActive(activeSessionId),
      isStreaming: piRuntime.isEmbeddedPiRunStreaming(activeSessionId),
    };
  };
  let { activeSessionId, isActive, isStreaming } = resolveQueueBusyState();
  const shouldSteer = resolvedQueue.mode === "steer" || resolvedQueue.mode === "steer-backlog";
  const shouldFollowup =
    resolvedQueue.mode === "followup" ||
    resolvedQueue.mode === "collect" ||
    resolvedQueue.mode === "steer-backlog";
  const activeRunQueueAction = resolveActiveRunQueueAction({
    isActive,
    isHeartbeat: opts?.isHeartbeat === true,
    shouldFollowup,
    queueMode: resolvedQueue.mode,
  });
  emitTiming("queue_state_ready", {
    queueMode: resolvedQueue.mode,
    activeRunQueueAction,
    laneSize,
    isActive,
    isStreaming,
  });
  if (isActive && activeRunQueueAction === "run-now") {
    const queueState = await resolvePreparedReplyQueueState({
      activeRunQueueAction,
      activeSessionId: activeSessionId ?? resolveActiveQueueSessionId(),
      queueMode: resolvedQueue.mode,
      sessionKey,
      sessionId: sessionIdFinal,
      abortActiveRun: (activeRunSessionId) =>
        piRuntime?.abortEmbeddedPiRun(activeRunSessionId) ?? false,
      waitForActiveRunEnd: (activeRunSessionId) =>
        piRuntime?.waitForEmbeddedPiRunEnd(activeRunSessionId) ?? Promise.resolve(undefined),
      refreshPreparedState: async () => {
        preparedSessionState = resolvePreparedSessionState();
        authProfileId = useFastReplyRuntime
          ? undefined
          : await resolveSessionAuthProfileOverride({
              cfg,
              provider,
              agentDir,
              sessionEntry: preparedSessionState.sessionEntry,
              sessionStore,
              sessionKey,
              storePath,
              isNewSession,
            });
        preparedSessionState = resolvePreparedSessionState();
        ({ prefixedCommandBody, queuedBody } = await rebuildPromptBodies());
      },
      resolveBusyState: resolveQueueBusyState,
    });
    if (queueState.kind === "reply") {
      typing.cleanup();
      return queueState.reply;
    }
    ({ activeSessionId, isActive, isStreaming } = queueState.busyState);
  }
  const authProfileIdSource = preparedSessionState.sessionEntry?.authProfileOverrideSource;
  const preparedComputerUse = preparedSessionState.sessionEntry?.computerUse;
  const preparedBrowserUse = preparedSessionState.sessionEntry?.browserUse;
  emitTiming("computer_use_state_ready", {
    enabled: preparedComputerUse?.enabled === true,
    scope: preparedComputerUse?.scope?.type,
    modelPolicy: preparedComputerUse?.modelPolicy?.mode,
  });
  logVerbose(
    `computer_use run session=${sessionKey ?? preparedSessionState.sessionId} enabled=${preparedComputerUse?.enabled === true} scope=${preparedComputerUse?.scope?.type ?? "n/a"} modelPolicy=${preparedComputerUse?.modelPolicy?.mode ?? "n/a"} approvals=${preparedComputerUse?.approvals?.highRiskActionsRequireConfirm === true ? "confirm" : "full"}`,
  );
  defaultRuntime.log?.(
    `[computer_use_trace] stage=get_reply_run session=${sessionKey ?? preparedSessionState.sessionId} enabled=${preparedComputerUse?.enabled === true} scope=${preparedComputerUse?.scope?.type ?? "n/a"} modelPolicy=${preparedComputerUse?.modelPolicy?.mode ?? "n/a"} approvals=${preparedComputerUse?.approvals?.highRiskActionsRequireConfirm === true ? "confirm" : "full"}`,
  );
  const fastModeState = useFastReplyRuntime
    ? { enabled: false }
    : resolveFastModeState({
        cfg,
        provider,
        model,
        agentId,
        sessionEntry: preparedSessionState.sessionEntry,
      });
  emitTiming("fast_mode_ready", {
    enabled: fastModeState.enabled,
  });
  const enforceFinalTag =
    !useFastReplyRuntime &&
    isReasoningTagProvider(provider, {
      config: cfg,
      workspaceDir,
      modelId: model,
    });
  emitTiming("reasoning_tag_policy_ready", {
    enforceFinalTag,
  });
  const followupRun = {
    prompt: queuedBody,
    messageId: sessionCtx.MessageSidFull ?? sessionCtx.MessageSid,
    summaryLine: baseBodyTrimmedRaw,
    enqueuedAt: Date.now(),
    // Originating channel for reply routing.
    originatingChannel: ctx.OriginatingChannel,
    originatingTo: ctx.OriginatingTo,
    originatingAccountId: sessionCtx.AccountId,
    originatingThreadId: ctx.MessageThreadId,
    originatingChatType: ctx.ChatType,
    run: {
      agentId,
      agentDir,
      sessionId: preparedSessionState.sessionId,
      sessionKey,
      messageProvider: resolveOriginMessageProvider({
        originatingChannel: ctx.OriginatingChannel ?? sessionCtx.OriginatingChannel,
        // Prefer Provider over Surface for fallback channel identity.
        // Surface can carry relayed metadata (for example "webchat") while Provider
        // still reflects the active channel that should own tool routing.
        provider: ctx.Provider ?? ctx.Surface ?? sessionCtx.Provider,
      }),
      agentAccountId: sessionCtx.AccountId,
      groupId: resolveGroupSessionKey(sessionCtx)?.id ?? undefined,
      groupChannel:
        normalizeOptionalString(sessionCtx.GroupChannel) ??
        normalizeOptionalString(sessionCtx.GroupSubject),
      groupSpace: normalizeOptionalString(sessionCtx.GroupSpace),
      senderId: normalizeOptionalString(sessionCtx.SenderId),
      senderName: normalizeOptionalString(sessionCtx.SenderName),
      senderUsername: normalizeOptionalString(sessionCtx.SenderUsername),
      senderE164: normalizeOptionalString(sessionCtx.SenderE164),
      senderIsOwner: forceSenderIsOwnerFalseFromSystemEvents ? false : command.senderIsOwner,
      traceAuthorized:
        (forceSenderIsOwnerFalseFromSystemEvents ? false : command.senderIsOwner) ||
        (ctx.GatewayClientScopes ?? []).includes("operator.admin"),
      sessionFile: preparedSessionState.sessionFile,
      workspaceDir,
      config: cfg,
      skillsSnapshot,
      provider,
      model,
      authProfileId,
      authProfileIdSource,
      thinkLevel: resolvedThinkLevel,
      fastMode: fastModeState.enabled,
      verboseLevel: resolvedVerboseLevel,
      reasoningLevel: resolvedReasoningLevel,
      elevatedLevel: resolvedElevatedLevel,
      execOverrides,
      computerUse: preparedComputerUse,
      browserUse: preparedBrowserUse,
      bashElevated: {
        enabled: elevatedEnabled,
        allowed: elevatedAllowed,
        defaultLevel: resolvedElevatedLevel ?? "off",
        fullAccessAvailable: fullAccessState.available,
        ...(fullAccessState.blockedReason
          ? { fullAccessBlockedReason: fullAccessState.blockedReason }
          : {}),
      },
      timeoutMs,
      blockReplyBreak: resolvedBlockStreamingBreak,
      ownerNumbers: command.ownerList.length > 0 ? command.ownerList : undefined,
      inputProvenance: ctx.InputProvenance ?? sessionCtx.InputProvenance,
      extraSystemPrompt: extraSystemPromptParts.join("\n\n") || undefined,
      skipProviderRuntimeHints: useFastReplyRuntime,
      ...(enforceFinalTag ? { enforceFinalTag: true } : {}),
    },
  };
  emitTiming("followup_run_ready", {
    promptChars: followupRun.prompt.length,
    extraSystemPromptChars: followupRun.run.extraSystemPrompt?.length ?? 0,
    fastMode: followupRun.run.fastMode,
    enforceFinalTag: followupRun.run.enforceFinalTag === true,
  });

  emitTiming("agent_run_start", {
    queueMode: resolvedQueue.mode,
    shouldSteer,
    shouldFollowup,
    isActive,
    isStreaming,
  });
  const reply = await runReplyAgent({
    commandBody: prefixedCommandBody,
    followupRun,
    queueKey,
    resolvedQueue,
    shouldSteer,
    shouldFollowup,
    isActive,
    isRunActive: () => {
      const latestSessionState = resolvePreparedSessionState();
      const latestActiveSessionId =
        piRuntime?.resolveActiveEmbeddedRunSessionId(sessionKey) ?? latestSessionState.sessionId;
      return piRuntime?.isEmbeddedPiRunActive(latestActiveSessionId) ?? false;
    },
    isStreaming,
    opts,
    typing,
    sessionEntry: preparedSessionState.sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    defaultModel,
    agentCfgContextTokens: agentCfg?.contextTokens,
    resolvedVerboseLevel: resolvedVerboseLevel ?? "off",
    isNewSession,
    blockStreamingEnabled,
    blockReplyChunking,
    resolvedBlockStreamingBreak,
    sessionCtx,
    shouldInjectGroupIntro,
    typingMode,
    resetTriggered,
  });
  emitTiming("agent_run_done", {
    replyCount: reply ? (Array.isArray(reply) ? reply.length : 1) : 0,
  });
  return reply;
}

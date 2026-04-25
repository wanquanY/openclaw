import crypto from "node:crypto";
import path from "node:path";
import {
  buildTelegramTopicConversationId,
  normalizeConversationText,
  parseTelegramChatIdFromTarget,
} from "../../acp/conversation-id.js";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { clearBootstrapSnapshotOnSessionRollover } from "../../agents/bootstrap-cache.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveGroupSessionKey } from "../../config/sessions/group.js";
import { deriveSessionMetaPatch } from "../../config/sessions/metadata.js";
import { resolveSessionTranscriptPath, resolveStorePath } from "../../config/sessions/paths.js";
import {
  evaluateSessionFreshness,
  resolveChannelResetConfig,
  resolveSessionResetPolicy,
  resolveSessionResetType,
  resolveThreadFlag,
} from "../../config/sessions/reset.js";
import { resolveAndPersistSessionFile } from "../../config/sessions/session-file.js";
import { resolveSessionKey } from "../../config/sessions/session-key.js";
import { loadSessionStore, updateSessionStore } from "../../config/sessions/store.js";
import { parseSessionThreadInfoFast } from "../../config/sessions/thread-info.js";
import {
  DEFAULT_RESET_TRIGGERS,
  appendSessionPreviousSession,
  type GroupKeyResolution,
  type SessionEntry,
  type SessionScope,
} from "../../config/sessions/types.js";
import type { TtsAutoMode } from "../../config/types.tts.js";
import { resolveConversationIdFromTargets } from "../../infra/outbound/conversation-id.js";
import { getSessionBindingService } from "../../infra/outbound/session-binding-service.js";
import { deliverSessionMaintenanceWarning } from "../../infra/session-maintenance-warning.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { closeTrackedBrowserTabsForSessions } from "../../plugin-sdk/browser-maintenance.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { isAcpSessionKey, normalizeMainKey } from "../../routing/session-key.js";
import { normalizeSessionDeliveryFields } from "../../utils/delivery-context.js";
import { isInternalMessageChannel, normalizeMessageChannel } from "../../utils/message-channel.js";
import { resolveCommandAuthorization } from "../command-auth.js";
import type { MsgContext, TemplateContext } from "../templating.js";
import { resolveEffectiveResetTargetSessionKey } from "./acp-reset-target.js";
import { resolveConversationBindingContextFromMessage } from "./conversation-binding-input.js";
import { parseDiscordParentChannelFromSessionKey } from "./discord-parent-channel.js";
import { normalizeInboundTextNewlines } from "./inbound-text.js";
import { stripMentions, stripStructuralPrefixes } from "./mentions.js";
import {
  maybeRetireLegacyMainDeliveryRoute,
  resolveLastChannelRaw,
  resolveLastToRaw,
} from "./session-delivery.js";
import {
  forkSessionFromParent,
  resolveParentForkMaxTokens,
  resolveParentForkTokenCount,
} from "./session-fork.js";
import { buildSessionEndHookPayload, buildSessionStartHookPayload } from "./session-hooks.js";

const log = createSubsystemLogger("session-init");
let sessionArchiveRuntimePromise: Promise<
  typeof import("../../gateway/session-archive.runtime.js")
> | null = null;
let sessionMcpToolsRuntimePromise: Promise<
  typeof import("../../agents/pi-bundle-mcp-tools.js")
> | null = null;

const SYSTEM_EVENT_PROVIDERS = new Set(["heartbeat", "cron-event", "exec-event"]);

function loadSessionArchiveRuntime() {
  sessionArchiveRuntimePromise ??= import("../../gateway/session-archive.runtime.js");
  return sessionArchiveRuntimePromise;
}

function loadSessionMcpToolsRuntime() {
  sessionMcpToolsRuntimePromise ??= import("../../agents/pi-bundle-mcp-tools.js");
  return sessionMcpToolsRuntimePromise;
}

function isSystemEventProvider(provider?: string | null): boolean {
  const normalized = normalizeMessageChannel(provider);
  return Boolean(normalized && SYSTEM_EVENT_PROVIDERS.has(normalized));
}

function resolveConfiguredDefaultAccountId(
  cfg: OpenClawConfig,
  channel?: string | null,
): string | undefined {
  const normalizedChannel = normalizeMessageChannel(channel);
  if (!normalizedChannel) {
    return undefined;
  }
  const channels = cfg.channels as
    | Record<string, { defaultAccount?: unknown } | undefined>
    | undefined;
  const configured = channels?.[normalizedChannel]?.defaultAccount;
  return typeof configured === "string" && configured.trim() ? configured.trim() : undefined;
}

export type SessionInitResult = {
  sessionCtx: TemplateContext;
  sessionEntry: SessionEntry;
  previousSessionEntry?: SessionEntry;
  sessionStore: Record<string, SessionEntry>;
  sessionKey: string;
  sessionId: string;
  isNewSession: boolean;
  resetTriggered: boolean;
  systemSent: boolean;
  abortedLastRun: boolean;
  storePath: string;
  sessionScope: SessionScope;
  groupResolution?: GroupKeyResolution;
  isGroup: boolean;
  bodyStripped?: string;
  triggerBodyNormalized: string;
};

function resolveAcpResetBindingContext(ctx: MsgContext): {
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
} | null {
  const channelRaw = normalizeConversationText(
    ctx.OriginatingChannel ?? ctx.Surface ?? ctx.Provider ?? "",
  ).toLowerCase();
  if (!channelRaw) {
    return null;
  }
  const accountId = normalizeConversationText(ctx.AccountId) || "default";
  const normalizedThreadId =
    ctx.MessageThreadId != null ? normalizeConversationText(String(ctx.MessageThreadId)) : "";

  if (channelRaw === "telegram") {
    const parentConversationId =
      parseTelegramChatIdFromTarget(ctx.OriginatingTo) ?? parseTelegramChatIdFromTarget(ctx.To);
    let conversationId =
      resolveConversationIdFromTargets({
        threadId: normalizedThreadId || undefined,
        targets: [ctx.OriginatingTo, ctx.To],
      }) ?? "";
    if (normalizedThreadId && parentConversationId) {
      conversationId =
        buildTelegramTopicConversationId({
          chatId: parentConversationId,
          topicId: normalizedThreadId,
        }) ?? conversationId;
    }
    if (!conversationId) {
      return null;
    }
    return {
      channel: channelRaw,
      accountId,
      conversationId,
      ...(parentConversationId ? { parentConversationId } : {}),
    };
  }

  const conversationId = resolveConversationIdFromTargets({
    threadId: normalizedThreadId || undefined,
    targets: [ctx.OriginatingTo, ctx.To],
  });
  if (!conversationId) {
    return null;
  }
  let parentConversationId: string | undefined;
  if (channelRaw === "discord" && normalizedThreadId) {
    const fromContext = normalizeConversationText(ctx.ThreadParentId);
    if (fromContext && fromContext !== conversationId) {
      parentConversationId = fromContext;
    } else {
      const fromParentSession = parseDiscordParentChannelFromSessionKey(ctx.ParentSessionKey);
      if (fromParentSession && fromParentSession !== conversationId) {
        parentConversationId = fromParentSession;
      } else {
        const fromTargets = resolveConversationIdFromTargets({
          targets: [ctx.OriginatingTo, ctx.To],
        });
        if (fromTargets && fromTargets !== conversationId) {
          parentConversationId = fromTargets;
        }
      }
    }
  }
  return {
    channel: channelRaw,
    accountId,
    conversationId,
    ...(parentConversationId ? { parentConversationId } : {}),
  };
}

function resolveBoundAcpSessionForReset(params: {
  cfg: OpenClawConfig;
  ctx: MsgContext;
}): string | undefined {
  const activeSessionKey = normalizeConversationText(params.ctx.SessionKey);
  const bindingContext = resolveAcpResetBindingContext(params.ctx);
  return resolveEffectiveResetTargetSessionKey({
    cfg: params.cfg,
    channel: bindingContext?.channel,
    accountId: bindingContext?.accountId,
    conversationId: bindingContext?.conversationId,
    parentConversationId: bindingContext?.parentConversationId,
    activeSessionKey,
    allowNonAcpBindingSessionKey: false,
    skipConfiguredFallbackWhenActiveSessionNonAcp: true,
    fallbackToActiveAcpWhenUnbound: false,
  });
}

export async function initSessionState(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  commandAuthorized: boolean;
}): Promise<SessionInitResult> {
  const { ctx, cfg, commandAuthorized } = params;
  const currentConversationBinding =
    ctx.CommandSource === "native"
      ? null
      : resolveConversationBindingContextFromMessage({
          cfg,
          ctx,
        });
  const currentConversationSessionBinding = currentConversationBinding
    ? getSessionBindingService().resolveByConversation(currentConversationBinding)
    : null;
  const boundConversationSessionKey =
    currentConversationSessionBinding?.targetKind === "session"
      ? currentConversationSessionBinding.targetSessionKey.trim() || undefined
      : undefined;
  // Native slash commands (Telegram/Discord/Slack) are delivered on a separate
  // "slash session" key, but should mutate the target chat session.
  const targetSessionKey =
    ctx.CommandSource === "native" ? ctx.CommandTargetSessionKey?.trim() : undefined;
  const effectiveSessionKeyOverride = targetSessionKey || boundConversationSessionKey;
  const sessionCtxForState =
    effectiveSessionKeyOverride && effectiveSessionKeyOverride !== ctx.SessionKey
      ? { ...ctx, SessionKey: effectiveSessionKeyOverride }
      : ctx;
  const sessionCfg = cfg.session;
  const mainKey = normalizeMainKey(sessionCfg?.mainKey);
  const agentId = resolveSessionAgentId({
    sessionKey: sessionCtxForState.SessionKey,
    config: cfg,
  });
  const groupResolution = resolveGroupSessionKey(sessionCtxForState) ?? undefined;
  const resetTriggers = sessionCfg?.resetTriggers?.length
    ? sessionCfg.resetTriggers
    : DEFAULT_RESET_TRIGGERS;
  const parentForkMaxTokens = resolveParentForkMaxTokens(cfg);
  const sessionScope = sessionCfg?.scope ?? "per-sender";
  const storePath = resolveStorePath(sessionCfg?.store, { agentId });
  const ingressTimingEnabled = process.env.OPENCLAW_DEBUG_INGRESS_TIMING === "1";

  // CRITICAL: Skip cache to ensure fresh data when resolving session identity.
  // Stale cache (especially with multiple gateway processes or on Windows where
  // mtime granularity may miss rapid writes) can cause incorrect sessionId
  // generation, leading to orphaned transcript files. See #17971.
  const sessionStoreLoadStartMs = ingressTimingEnabled ? Date.now() : 0;
  const sessionStore: Record<string, SessionEntry> = loadSessionStore(storePath, {
    skipCache: true,
  });
  if (ingressTimingEnabled) {
    log.info(
      `session-init store-load agent=${agentId} session=${sessionCtxForState.SessionKey ?? "(no-session)"} ` +
        `elapsedMs=${Date.now() - sessionStoreLoadStartMs} path=${storePath}`,
    );
  }
  let sessionKey: string | undefined;
  let sessionEntry: SessionEntry;

  let sessionId: string | undefined;
  let isNewSession = false;
  let bodyStripped: string | undefined;
  let systemSent = false;
  let abortedLastRun = false;
  let resetTriggered = false;

  let persistedThinking: string | undefined;
  let persistedVerbose: string | undefined;
  let persistedReasoning: string | undefined;
  let persistedTtsAuto: TtsAutoMode | undefined;
  let persistedModelOverride: string | undefined;
  let persistedProviderOverride: string | undefined;
  let persistedAuthProfileOverride: string | undefined;
  let persistedAuthProfileOverrideSource: SessionEntry["authProfileOverrideSource"];
  let persistedAuthProfileOverrideCompactionCount: number | undefined;
  let persistedLabel: string | undefined;
  let preservedEntryFields: Partial<SessionEntry> | undefined;

  const normalizedChatType = normalizeChatType(ctx.ChatType);
  const isGroup =
    normalizedChatType != null && normalizedChatType !== "direct" ? true : Boolean(groupResolution);
  // Prefer CommandBody/RawBody (clean message) for command detection; fall back
  // to Body which may contain structural context (history, sender labels).
  const commandSource = ctx.BodyForCommands ?? ctx.CommandBody ?? ctx.RawBody ?? ctx.Body ?? "";
  // IMPORTANT: do NOT lowercase the entire command body.
  // Users often pass case-sensitive arguments (e.g. filesystem paths on Linux).
  // Command parsing downstream lowercases only the command token for matching.
  const triggerBodyNormalized = stripStructuralPrefixes(commandSource).trim();

  // Use CommandBody/RawBody for reset trigger matching (clean message without structural context).
  const rawBody = commandSource;
  const trimmedBody = rawBody.trim();
  const commandAuthorization = resolveCommandAuthorization({
    ctx,
    cfg,
    commandAuthorized,
  });
  const resetAuthorized =
    commandAuthorization.isAuthorizedSender &&
    (!isInternalMessageChannel(ctx.Provider) ||
      (Array.isArray(ctx.GatewayClientScopes) &&
        ctx.GatewayClientScopes.includes("operator.admin")));
  // Timestamp/message prefixes (e.g. "[Dec 4 17:35] ") are added by the
  // web inbox before we get here. They prevented reset triggers like "/new"
  // from matching, so strip structural wrappers when checking for resets.
  const strippedForReset = isGroup
    ? stripMentions(triggerBodyNormalized, ctx, cfg, agentId)
    : triggerBodyNormalized;
  const boundAcpResetSessionKey = resolveBoundAcpSessionForReset({
    cfg,
    ctx: sessionCtxForState,
  });
  const shouldUseAcpInPlaceReset = Boolean(
    !targetSessionKey &&
    !isAcpSessionKey(sessionCtxForState.SessionKey) &&
    boundAcpResetSessionKey &&
    boundAcpResetSessionKey !== sessionCtxForState.SessionKey?.trim(),
  );
  const shouldBypassAcpResetForTrigger = (triggerLower: string): boolean =>
    shouldUseAcpInPlaceReset &&
    DEFAULT_RESET_TRIGGERS.some((defaultTrigger) => defaultTrigger.toLowerCase() === triggerLower);

  // Reset triggers are configured as lowercased commands (e.g. "/new"), but users may type
  // "/NEW" etc. Match case-insensitively while keeping the original casing for any stripped body.
  const trimmedBodyLower = trimmedBody.toLowerCase();
  const strippedForResetLower = strippedForReset.toLowerCase();
  const isSoftResetRequest = /^\/reset\s*:?\s*soft\b/u.test(strippedForResetLower);
  const isAuthorizedSoftResetRequest = resetAuthorized && isSoftResetRequest;

  for (const trigger of isAuthorizedSoftResetRequest ? [] : resetTriggers) {
    if (!trigger) {
      continue;
    }
    if (!resetAuthorized) {
      break;
    }
    const triggerLower = trigger.toLowerCase();
    if (trimmedBodyLower === triggerLower || strippedForResetLower === triggerLower) {
      if (shouldBypassAcpResetForTrigger(triggerLower)) {
        // ACP-bound conversations handle /new and /reset in command handling
        // so the bound ACP runtime can be reset in place without rotating the
        // normal OpenClaw session/transcript.
        break;
      }
      isNewSession = true;
      bodyStripped = "";
      resetTriggered = true;
      break;
    }
    const triggerPrefixLower = `${triggerLower} `;
    if (
      trimmedBodyLower.startsWith(triggerPrefixLower) ||
      strippedForResetLower.startsWith(triggerPrefixLower)
    ) {
      if (shouldBypassAcpResetForTrigger(triggerLower)) {
        break;
      }
      isNewSession = true;
      bodyStripped = strippedForReset.slice(trigger.length).trimStart();
      resetTriggered = true;
      break;
    }
  }

  sessionKey = resolveSessionKey(sessionScope, sessionCtxForState, mainKey);
  const retiredLegacyMainDelivery = maybeRetireLegacyMainDeliveryRoute({
    sessionCfg,
    sessionKey,
    sessionStore,
    agentId,
    mainKey,
    isGroup,
    ctx,
  });
  if (retiredLegacyMainDelivery) {
    sessionStore[retiredLegacyMainDelivery.key] = retiredLegacyMainDelivery.entry;
  }
  const entry = sessionStore[sessionKey];
  const now = Date.now();
  const isThread = resolveThreadFlag({
    sessionKey,
    messageThreadId: ctx.MessageThreadId,
    threadLabel: ctx.ThreadLabel,
    threadStarterBody: ctx.ThreadStarterBody,
    parentSessionKey: ctx.ParentSessionKey,
  });
  const resetType = resolveSessionResetType({ sessionKey, isGroup, isThread });
  const channelReset = resolveChannelResetConfig({
    sessionCfg,
    channel:
      groupResolution?.channel ??
      (ctx.OriginatingChannel as string | undefined) ??
      ctx.Surface ??
      ctx.Provider,
  });
  const resetPolicy = resolveSessionResetPolicy({
    sessionCfg,
    resetType,
    resetOverride: channelReset,
  });
  const entryHasSessionId =
    typeof entry?.sessionId === "string" && entry.sessionId.trim().length > 0;
  const hasProviderOwnedCliSession =
    Boolean(entry?.cliSessionBindings && Object.keys(entry.cliSessionBindings).length > 0) ||
    Boolean(entry?.claudeCliSessionId);
  const hasExplicitResetPolicy = Boolean(sessionCfg?.reset || channelReset);
  const freshEntry =
    entry && entryHasSessionId
      ? isAuthorizedSoftResetRequest ||
        (!resetTriggered && hasProviderOwnedCliSession && !hasExplicitResetPolicy)
        ? true
        : evaluateSessionFreshness({ updatedAt: entry.updatedAt, now, policy: resetPolicy }).fresh
      : false;
  // Capture the current session entry before any reset so its transcript can be
  // archived afterward.  We need to do this for both explicit resets (/new, /reset)
  // and for scheduled/daily resets where the session has become stale (!freshEntry).
  // Without this, daily-reset transcripts are left as orphaned files on disk (#35481).
  let previousSessionEntry = (resetTriggered || !freshEntry) && entry ? { ...entry } : undefined;
  clearBootstrapSnapshotOnSessionRollover({
    sessionKey,
    previousSessionId: previousSessionEntry?.sessionId,
  });

  if (!isNewSession && freshEntry) {
    sessionId = entry.sessionId;
    systemSent = entry.systemSent ?? false;
    abortedLastRun = entry.abortedLastRun ?? false;
    persistedThinking = entry.thinkingLevel;
    persistedVerbose = entry.verboseLevel;
    persistedReasoning = entry.reasoningLevel;
    persistedTtsAuto = entry.ttsAuto;
    persistedModelOverride = entry.modelOverride;
    persistedProviderOverride = entry.providerOverride;
    persistedAuthProfileOverride = entry.authProfileOverride;
    persistedAuthProfileOverrideSource = entry.authProfileOverrideSource;
    persistedAuthProfileOverrideCompactionCount = entry.authProfileOverrideCompactionCount;
    persistedLabel = entry.label;
  } else {
    sessionId = crypto.randomUUID();
    isNewSession = true;
    systemSent = false;
    abortedLastRun = false;
    // When a reset trigger (/new, /reset) starts a new session, carry over
    // user-set behavior overrides (verbose, thinking, reasoning, ttsAuto)
    // so the user doesn't have to re-enable them every time.
    if (resetTriggered && entry) {
      persistedThinking = entry.thinkingLevel;
      persistedVerbose = entry.verboseLevel;
      persistedReasoning = entry.reasoningLevel;
      persistedTtsAuto = entry.ttsAuto;
      if (entry.modelOverrideSource !== "auto") {
        persistedModelOverride = entry.modelOverride;
        persistedProviderOverride = entry.providerOverride;
      }
      persistedAuthProfileOverride = entry.authProfileOverride;
      persistedAuthProfileOverrideSource = entry.authProfileOverrideSource;
      persistedAuthProfileOverrideCompactionCount = entry.authProfileOverrideCompactionCount;
      if (entry.authProfileOverrideSource === "auto") {
        persistedAuthProfileOverride = undefined;
        persistedAuthProfileOverrideSource = undefined;
        persistedAuthProfileOverrideCompactionCount = undefined;
      }
      persistedLabel = entry.label;
      preservedEntryFields = {
        spawnedBy: entry.spawnedBy,
        spawnedWorkspaceDir: entry.spawnedWorkspaceDir,
        parentSessionKey: entry.parentSessionKey,
        forkedFromParent: entry.forkedFromParent,
        spawnDepth: entry.spawnDepth,
        subagentRole: entry.subagentRole,
        subagentControlScope: entry.subagentControlScope,
        displayName: entry.displayName,
      };
    } else if (entry && !entryHasSessionId) {
      preservedEntryFields = {
        groupActivation: entry.groupActivation,
        displayName: entry.displayName,
        chatType: entry.chatType,
        channel: entry.channel,
        groupId: entry.groupId,
        subject: entry.subject,
        groupChannel: entry.groupChannel,
        space: entry.space,
      };
    }
  }

  if (isNewSession && entry?.sessionId && entry.sessionId !== sessionId) {
    previousSessionEntry = { ...entry };
  }

  const baseEntry = !isNewSession && freshEntry ? entry : undefined;
  const isSystemEventTurn = isSystemEventProvider(ctx.Provider);
  // Track the originating channel/to for announce routing (subagent announce-back).
  const originatingChannelRaw = isSystemEventTurn
    ? undefined
    : ((ctx.OriginatingChannel as string | undefined) ?? ctx.Provider);
  const lastChannelRaw = isSystemEventTurn
    ? baseEntry?.lastChannel
    : resolveLastChannelRaw({
        originatingChannelRaw,
        persistedLastChannel: baseEntry?.lastChannel,
        sessionKey,
      });
  const lastToRaw = isSystemEventTurn
    ? baseEntry?.lastTo
    : resolveLastToRaw({
        originatingChannelRaw,
        originatingToRaw: ctx.OriginatingTo,
        toRaw: ctx.To,
        persistedLastTo: baseEntry?.lastTo,
        persistedLastChannel: baseEntry?.lastChannel,
        sessionKey,
      });
  const lastAccountIdRaw = isSystemEventTurn
    ? baseEntry?.lastAccountId
    : ctx.AccountId ||
      baseEntry?.lastAccountId ||
      resolveConfiguredDefaultAccountId(
        cfg,
        currentConversationBinding?.channel ?? originatingChannelRaw ?? ctx.Surface ?? ctx.Provider,
      ) ||
      currentConversationBinding?.accountId;
  // Only fall back to persisted threadId for thread sessions.  Non-thread
  // sessions (e.g. DM without topics) must not inherit a stale threadId from a
  // previous interaction that happened inside a topic/thread.
  const lastThreadIdRaw = ctx.MessageThreadId || (isThread ? baseEntry?.lastThreadId : undefined);
  const deliveryFields = normalizeSessionDeliveryFields({
    deliveryContext: {
      channel: lastChannelRaw,
      to: lastToRaw,
      accountId: lastAccountIdRaw,
      threadId: lastThreadIdRaw,
    },
  });
  const lastChannel = deliveryFields.lastChannel ?? lastChannelRaw;
  const lastTo = deliveryFields.lastTo ?? lastToRaw;
  const lastAccountId = deliveryFields.lastAccountId ?? lastAccountIdRaw;
  const lastThreadId = deliveryFields.lastThreadId ?? lastThreadIdRaw;
  sessionEntry = {
    ...baseEntry,
    ...preservedEntryFields,
    sessionId,
    updatedAt: Date.now(),
    systemSent,
    abortedLastRun,
    // Persist previously stored thinking/verbose levels when present.
    thinkingLevel: persistedThinking ?? baseEntry?.thinkingLevel,
    verboseLevel: persistedVerbose ?? baseEntry?.verboseLevel,
    reasoningLevel: persistedReasoning ?? baseEntry?.reasoningLevel,
    ttsAuto: persistedTtsAuto ?? baseEntry?.ttsAuto,
    responseUsage: baseEntry?.responseUsage,
    modelOverride: persistedModelOverride ?? baseEntry?.modelOverride,
    providerOverride: persistedProviderOverride ?? baseEntry?.providerOverride,
    authProfileOverride: persistedAuthProfileOverride ?? baseEntry?.authProfileOverride,
    authProfileOverrideSource:
      persistedAuthProfileOverrideSource ?? baseEntry?.authProfileOverrideSource,
    authProfileOverrideCompactionCount:
      persistedAuthProfileOverrideCompactionCount ?? baseEntry?.authProfileOverrideCompactionCount,
    label: persistedLabel ?? baseEntry?.label,
    sendPolicy: baseEntry?.sendPolicy,
    queueMode: baseEntry?.queueMode,
    queueDebounceMs: baseEntry?.queueDebounceMs,
    queueCap: baseEntry?.queueCap,
    queueDrop: baseEntry?.queueDrop,
    displayName: preservedEntryFields?.displayName ?? baseEntry?.displayName,
    chatType: baseEntry?.chatType,
    channel: baseEntry?.channel,
    groupId: baseEntry?.groupId,
    subject: baseEntry?.subject,
    groupChannel: baseEntry?.groupChannel,
    space: baseEntry?.space,
    deliveryContext: deliveryFields.deliveryContext,
    // Track originating channel for subagent announce routing.
    lastChannel,
    lastTo,
    lastAccountId,
    lastThreadId,
  };
  const metaPatch = deriveSessionMetaPatch({
    ctx: sessionCtxForState,
    sessionKey,
    existing: sessionEntry,
    groupResolution,
    skipSystemEventOrigin: isSystemEventTurn,
  });
  if (metaPatch) {
    sessionEntry = { ...sessionEntry, ...metaPatch };
  }
  if (isSystemEventTurn && !isThread && sessionEntry.origin?.threadId != null) {
    const { threadId: _threadId, ...originWithoutThread } = sessionEntry.origin;
    sessionEntry.origin =
      Object.keys(originWithoutThread).length > 0 ? originWithoutThread : undefined;
  }
  if (!sessionEntry.chatType) {
    sessionEntry.chatType = "direct";
  }
  const threadLabel = ctx.ThreadLabel?.trim();
  if (threadLabel) {
    sessionEntry.displayName = threadLabel;
  }
  const parentSessionKey = ctx.ParentSessionKey?.trim();
  const alreadyForked = sessionEntry.forkedFromParent === true;
  if (
    parentSessionKey &&
    parentSessionKey !== sessionKey &&
    sessionStore[parentSessionKey] &&
    !alreadyForked
  ) {
    const parentTokens =
      (await resolveParentForkTokenCount({
        parentEntry: sessionStore[parentSessionKey],
        storePath,
      })) ??
      sessionStore[parentSessionKey].totalTokens ??
      0;
    if (parentForkMaxTokens > 0 && parentTokens > parentForkMaxTokens) {
      // Parent context is too large — forking would create a thread session
      // that immediately overflows the model's context window. Start fresh
      // instead and mark as forked to prevent re-attempts. See #26905.
      log.warn(
        `skipping parent fork (parent too large): parentKey=${parentSessionKey} → sessionKey=${sessionKey} ` +
          `parentTokens=${parentTokens} maxTokens=${parentForkMaxTokens}`,
      );
      sessionEntry.forkedFromParent = true;
    } else {
      log.warn(
        `forking from parent session: parentKey=${parentSessionKey} → sessionKey=${sessionKey} ` +
          `parentTokens=${parentTokens}`,
      );
      const forked = await forkSessionFromParent({
        parentEntry: sessionStore[parentSessionKey],
        agentId,
        sessionsDir: path.dirname(storePath),
      });
      if (forked) {
        sessionId = forked.sessionId;
        sessionEntry.sessionId = forked.sessionId;
        sessionEntry.sessionFile = forked.sessionFile;
        sessionEntry.forkedFromParent = true;
        log.warn(`forked session created: file=${forked.sessionFile}`);
      }
    }
  }
  const inferredSessionThreadId =
    ctx.MessageThreadId ?? parseSessionThreadInfoFast(sessionKey).threadId;
  const fallbackSessionFile = !sessionEntry.sessionFile
    ? resolveSessionTranscriptPath(sessionEntry.sessionId, agentId, inferredSessionThreadId)
    : undefined;
  const resolvedSessionFile = await resolveAndPersistSessionFile({
    sessionId: sessionEntry.sessionId,
    sessionKey,
    sessionStore,
    storePath,
    sessionEntry,
    agentId,
    sessionsDir: path.dirname(storePath),
    fallbackSessionFile,
    activeSessionKey: sessionKey,
  });
  sessionEntry = resolvedSessionFile.sessionEntry;
  if (isNewSession) {
    sessionEntry.compactionCount = 0;
    sessionEntry.memoryFlushCompactionCount = undefined;
    sessionEntry.memoryFlushAt = undefined;
    // Clear stale context hash so the first flush in the new session is not
    // incorrectly skipped due to a hash match with the old transcript (#30115).
    sessionEntry.memoryFlushContextHash = undefined;
    // Clear stale token metrics from previous session so /status doesn't
    // display the old session's context usage after /new or /reset.
    sessionEntry.totalTokens = undefined;
    sessionEntry.inputTokens = undefined;
    sessionEntry.outputTokens = undefined;
    sessionEntry.estimatedCostUsd = undefined;
    sessionEntry.contextTokens = undefined;
    delete sessionEntry.cliSessionIds;
    delete sessionEntry.cliSessionBindings;
    delete sessionEntry.claudeCliSessionId;
  }
  if (previousSessionEntry) {
    const previousSessions = appendSessionPreviousSession({
      previousEntry: previousSessionEntry,
      existing: previousSessionEntry.previousSessions,
    });
    if (previousSessions) {
      sessionEntry.previousSessions = previousSessions;
    } else {
      delete sessionEntry.previousSessions;
    }
  }
  // Preserve per-session overrides while resetting compaction state on /new.
  sessionStore[sessionKey] = sessionEntry;
  await updateSessionStore(
    storePath,
    (store) => {
      // Preserve per-session overrides while resetting compaction state on /new.
      store[sessionKey] = sessionEntry;
      if (retiredLegacyMainDelivery) {
        store[retiredLegacyMainDelivery.key] = retiredLegacyMainDelivery.entry;
      }
    },
    {
      activeSessionKey: sessionKey,
      onWarn: (warning) =>
        deliverSessionMaintenanceWarning({
          cfg,
          sessionKey,
          entry: sessionEntry,
          warning,
        }),
    },
  );

  // Archive old transcript so it doesn't accumulate on disk (#14869).
  if (previousSessionEntry?.sessionId) {
    const { disposeSessionMcpRuntime } = await loadSessionMcpToolsRuntime();
    await disposeSessionMcpRuntime(previousSessionEntry.sessionId).catch(() => {});
    const { archiveSessionTranscripts } = await loadSessionArchiveRuntime();
    archiveSessionTranscripts({
      sessionId: previousSessionEntry.sessionId,
      storePath,
      sessionFile: previousSessionEntry.sessionFile,
      agentId,
      reason: "reset",
    });
    await closeTrackedBrowserTabsForSessions({
      sessionKeys: [previousSessionEntry.sessionId, sessionKey],
    }).catch(() => {});
  }

  const sessionCtx: TemplateContext = {
    ...ctx,
    SessionKey: sessionKey,
    // Keep BodyStripped aligned with Body (best default for agent prompts).
    // RawBody is reserved for command/directive parsing and may omit context.
    BodyStripped: normalizeInboundTextNewlines(
      bodyStripped ??
        ctx.BodyForAgent ??
        ctx.Body ??
        ctx.CommandBody ??
        ctx.RawBody ??
        ctx.BodyForCommands ??
        "",
    ),
    SessionId: sessionId,
    IsNewSession: isNewSession ? "true" : "false",
  };

  // Run session plugin hooks (fire-and-forget)
  const hookRunner = getGlobalHookRunner();
  if (hookRunner && isNewSession) {
    const effectiveSessionId = sessionId ?? "";

    // If replacing an existing session, fire session_end for the old one
    if (previousSessionEntry?.sessionId && previousSessionEntry.sessionId !== effectiveSessionId) {
      if (hookRunner.hasHooks("session_end")) {
        const payload = buildSessionEndHookPayload({
          sessionId: previousSessionEntry.sessionId,
          sessionKey,
          cfg,
        });
        void hookRunner.runSessionEnd(payload.event, payload.context).catch(() => {});
      }
    }

    // Fire session_start for the new session
    if (hookRunner.hasHooks("session_start")) {
      const payload = buildSessionStartHookPayload({
        sessionId: effectiveSessionId,
        sessionKey,
        cfg,
        resumedFrom: previousSessionEntry?.sessionId,
      });
      void hookRunner.runSessionStart(payload.event, payload.context).catch(() => {});
    }
  }

  return {
    sessionCtx,
    sessionEntry,
    previousSessionEntry,
    sessionStore,
    sessionKey,
    sessionId: sessionId ?? crypto.randomUUID(),
    isNewSession,
    resetTriggered,
    systemSent,
    abortedLastRun,
    storePath,
    sessionScope,
    groupResolution,
    isGroup,
    bodyStripped,
    triggerBodyNormalized,
  };
}

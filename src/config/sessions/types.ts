import type { Skill } from "@mariozechner/pi-coding-agent";
import crypto from "node:crypto";
import type { ChatType } from "../../channels/chat-type.js";
import type { ChannelId } from "../../channels/plugins/types.js";
import type { DeliveryContext } from "../../utils/delivery-context.js";
import type { TtsAutoMode } from "../types.tts.js";

export type SessionScope = "per-sender" | "global";

export type SessionChannelId = ChannelId | "webchat";

export type SessionChatType = ChatType;

export type SessionOrigin = {
  label?: string;
  provider?: string;
  surface?: string;
  chatType?: SessionChatType;
  from?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
};

export type SessionHistorySegment = {
  sessionId: string;
  sessionFile?: string;
  archivedFiles?: string[];
  endedAt: number;
};

const MAX_SESSION_HISTORY_SEGMENTS = 64;

export type SessionEntry = {
  /**
   * Last delivered heartbeat payload (used to suppress duplicate heartbeat notifications).
   * Stored on the main session entry.
   */
  lastHeartbeatText?: string;
  /** Timestamp (ms) when lastHeartbeatText was delivered. */
  lastHeartbeatSentAt?: number;
  sessionId: string;
  updatedAt: number;
  sessionFile?: string;
  historySegments?: SessionHistorySegment[];
  /** Parent session key that spawned this session (used for sandbox session-tool scoping). */
  spawnedBy?: string;
  /** Subagent spawn depth (0 = main, 1 = sub-agent, 2 = sub-sub-agent). */
  spawnDepth?: number;
  systemSent?: boolean;
  abortedLastRun?: boolean;
  chatType?: SessionChatType;
  thinkingLevel?: string;
  verboseLevel?: string;
  reasoningLevel?: string;
  elevatedLevel?: string;
  ttsAuto?: TtsAutoMode;
  execHost?: string;
  execSecurity?: string;
  execAsk?: string;
  execNode?: string;
  responseUsage?: "on" | "off" | "tokens" | "full";
  providerOverride?: string;
  modelOverride?: string;
  authProfileOverride?: string;
  authProfileOverrideSource?: "auto" | "user";
  authProfileOverrideCompactionCount?: number;
  groupActivation?: "mention" | "always";
  groupActivationNeedsSystemIntro?: boolean;
  sendPolicy?: "allow" | "deny";
  queueMode?:
    | "steer"
    | "followup"
    | "collect"
    | "steer-backlog"
    | "steer+backlog"
    | "queue"
    | "interrupt";
  queueDebounceMs?: number;
  queueCap?: number;
  queueDrop?: "old" | "new" | "summarize";
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /**
   * Whether totalTokens reflects a fresh context snapshot for the latest run.
   * Undefined means legacy/unknown freshness; false forces consumers to treat
   * totalTokens as stale/unknown for context-utilization displays.
   */
  totalTokensFresh?: boolean;
  modelProvider?: string;
  model?: string;
  contextTokens?: number;
  compactionCount?: number;
  memoryFlushAt?: number;
  memoryFlushCompactionCount?: number;
  cliSessionIds?: Record<string, string>;
  claudeCliSessionId?: string;
  label?: string;
  displayName?: string;
  channel?: string;
  groupId?: string;
  subject?: string;
  groupChannel?: string;
  space?: string;
  origin?: SessionOrigin;
  deliveryContext?: DeliveryContext;
  lastChannel?: SessionChannelId;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
  skillsSnapshot?: SessionSkillSnapshot;
  systemPromptReport?: SessionSystemPromptReport;
};

export function mergeSessionEntry(
  existing: SessionEntry | undefined,
  patch: Partial<SessionEntry>,
): SessionEntry {
  const sessionId = patch.sessionId ?? existing?.sessionId ?? crypto.randomUUID();
  const updatedAt = Math.max(existing?.updatedAt ?? 0, patch.updatedAt ?? 0, Date.now());
  if (!existing) {
    return { ...patch, sessionId, updatedAt };
  }
  return { ...existing, ...patch, sessionId, updatedAt };
}

function normalizeHistoryFilePath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeHistoryFileList(values: string[] | undefined): string[] | undefined {
  if (!Array.isArray(values) || values.length === 0) {
    return undefined;
  }
  const deduped = Array.from(
    new Set(
      values
        .map((value) => normalizeHistoryFilePath(value))
        .filter((value): value is string => Boolean(value)),
    ),
  );
  return deduped.length > 0 ? deduped : undefined;
}

export function appendSessionHistorySegment(params: {
  entry: SessionEntry;
  sessionId?: string;
  sessionFile?: string;
  archivedFiles?: string[];
  endedAt?: number;
}): SessionEntry {
  const sessionId = params.sessionId?.trim();
  if (!sessionId) {
    return params.entry;
  }

  const sessionFile = normalizeHistoryFilePath(params.sessionFile);
  const archivedFiles = normalizeHistoryFileList(params.archivedFiles);
  const endedAtRaw = params.endedAt;
  const endedAt =
    typeof endedAtRaw === "number" && Number.isFinite(endedAtRaw)
      ? Math.floor(endedAtRaw)
      : Date.now();

  const nextSegment: SessionHistorySegment = {
    sessionId,
    sessionFile,
    archivedFiles,
    endedAt,
  };

  const segments = [...(params.entry.historySegments ?? [])];
  const existingIndex = segments.findIndex(
    (segment) =>
      segment.sessionId === nextSegment.sessionId &&
      (segment.sessionFile ?? "") === (nextSegment.sessionFile ?? ""),
  );

  if (existingIndex >= 0) {
    const existing = segments[existingIndex];
    const mergedArchived = normalizeHistoryFileList([
      ...(existing.archivedFiles ?? []),
      ...(nextSegment.archivedFiles ?? []),
    ]);
    const existingEndedAt =
      typeof existing.endedAt === "number" && Number.isFinite(existing.endedAt)
        ? existing.endedAt
        : 0;
    segments[existingIndex] = {
      ...existing,
      sessionFile: nextSegment.sessionFile ?? existing.sessionFile,
      archivedFiles: mergedArchived,
      endedAt: Math.max(existingEndedAt, nextSegment.endedAt),
    };
  } else {
    segments.push(nextSegment);
  }

  return {
    ...params.entry,
    historySegments: segments.slice(-MAX_SESSION_HISTORY_SEGMENTS),
  };
}

export function resolveFreshSessionTotalTokens(
  entry?: Pick<SessionEntry, "totalTokens" | "totalTokensFresh"> | null,
): number | undefined {
  const total = entry?.totalTokens;
  if (typeof total !== "number" || !Number.isFinite(total) || total < 0) {
    return undefined;
  }
  if (entry?.totalTokensFresh === false) {
    return undefined;
  }
  return total;
}

export function isSessionTotalTokensFresh(
  entry?: Pick<SessionEntry, "totalTokens" | "totalTokensFresh"> | null,
): boolean {
  return resolveFreshSessionTotalTokens(entry) !== undefined;
}

export type GroupKeyResolution = {
  key: string;
  channel?: string;
  id?: string;
  chatType?: SessionChatType;
};

export type SessionSkillSnapshot = {
  prompt: string;
  skills: Array<{ name: string; primaryEnv?: string }>;
  resolvedSkills?: Skill[];
  version?: number;
};

export type SessionSystemPromptReport = {
  source: "run" | "estimate";
  generatedAt: number;
  sessionId?: string;
  sessionKey?: string;
  provider?: string;
  model?: string;
  workspaceDir?: string;
  bootstrapMaxChars?: number;
  sandbox?: {
    mode?: string;
    sandboxed?: boolean;
  };
  systemPrompt: {
    chars: number;
    projectContextChars: number;
    nonProjectContextChars: number;
  };
  injectedWorkspaceFiles: Array<{
    name: string;
    path: string;
    missing: boolean;
    rawChars: number;
    injectedChars: number;
    truncated: boolean;
  }>;
  skills: {
    promptChars: number;
    entries: Array<{ name: string; blockChars: number }>;
  };
  tools: {
    listChars: number;
    schemaChars: number;
    entries: Array<{
      name: string;
      summaryChars: number;
      schemaChars: number;
      propertiesCount?: number | null;
    }>;
  };
};

export const DEFAULT_RESET_TRIGGER = "/new";
export const DEFAULT_RESET_TRIGGERS = ["/new", "/reset"];
export const DEFAULT_IDLE_MINUTES = 60;

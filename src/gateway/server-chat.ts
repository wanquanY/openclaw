import { DEFAULT_HEARTBEAT_ACK_MAX_CHARS, stripHeartbeatToken } from "../auto-reply/heartbeat.js";
import { normalizeVerboseLevel } from "../auto-reply/thinking.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { loadConfig } from "../config/config.js";
import { type AgentEventPayload, getAgentRunContext } from "../infra/agent-events.js";
import { resolveHeartbeatVisibility } from "../infra/heartbeat-visibility.js";
import { stripInlineDirectiveTagsForDisplay } from "../utils/directive-tags.js";
import { loadSessionEntry } from "./session-utils.js";
import { formatForLog } from "./ws-log.js";

function resolveHeartbeatAckMaxChars(): number {
  try {
    const cfg = loadConfig();
    return Math.max(
      0,
      cfg.agents?.defaults?.heartbeat?.ackMaxChars ?? DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
    );
  } catch {
    return DEFAULT_HEARTBEAT_ACK_MAX_CHARS;
  }
}

function resolveHeartbeatContext(runId: string, sourceRunId?: string) {
  const primary = getAgentRunContext(runId);
  if (primary?.isHeartbeat) {
    return primary;
  }
  if (sourceRunId && sourceRunId !== runId) {
    const source = getAgentRunContext(sourceRunId);
    if (source?.isHeartbeat) {
      return source;
    }
  }
  return primary;
}

/**
 * Check if heartbeat ACK/noise should be hidden from interactive chat surfaces.
 */
function shouldHideHeartbeatChatOutput(runId: string, sourceRunId?: string): boolean {
  const runContext = resolveHeartbeatContext(runId, sourceRunId);
  if (!runContext?.isHeartbeat) {
    return false;
  }

  try {
    const cfg = loadConfig();
    const visibility = resolveHeartbeatVisibility({ cfg, channel: "webchat" });
    return !visibility.showOk;
  } catch {
    // Default to suppressing if we can't load config
    return true;
  }
}

function normalizeHeartbeatChatFinalText(params: {
  runId: string;
  sourceRunId?: string;
  text: string;
}): { suppress: boolean; text: string } {
  if (!shouldHideHeartbeatChatOutput(params.runId, params.sourceRunId)) {
    return { suppress: false, text: params.text };
  }

  const stripped = stripHeartbeatToken(params.text, {
    mode: "heartbeat",
    maxAckChars: resolveHeartbeatAckMaxChars(),
  });
  if (!stripped.didStrip) {
    return { suppress: false, text: params.text };
  }
  if (stripped.shouldSkip) {
    return { suppress: true, text: "" };
  }
  return { suppress: false, text: stripped.text };
}

export type ChatRunEntry = {
  sessionKey: string;
  clientRunId: string;
};

export type ChatRunRegistry = {
  add: (sessionId: string, entry: ChatRunEntry) => void;
  peek: (sessionId: string) => ChatRunEntry | undefined;
  shift: (sessionId: string) => ChatRunEntry | undefined;
  remove: (sessionId: string, clientRunId: string, sessionKey?: string) => ChatRunEntry | undefined;
  clear: () => void;
};

export function createChatRunRegistry(): ChatRunRegistry {
  const chatRunSessions = new Map<string, ChatRunEntry[]>();

  const add = (sessionId: string, entry: ChatRunEntry) => {
    const queue = chatRunSessions.get(sessionId);
    if (queue) {
      queue.push(entry);
    } else {
      chatRunSessions.set(sessionId, [entry]);
    }
  };

  const peek = (sessionId: string) => chatRunSessions.get(sessionId)?.[0];

  const shift = (sessionId: string) => {
    const queue = chatRunSessions.get(sessionId);
    if (!queue || queue.length === 0) {
      return undefined;
    }
    const entry = queue.shift();
    if (!queue.length) {
      chatRunSessions.delete(sessionId);
    }
    return entry;
  };

  const remove = (sessionId: string, clientRunId: string, sessionKey?: string) => {
    const queue = chatRunSessions.get(sessionId);
    if (!queue || queue.length === 0) {
      return undefined;
    }
    const idx = queue.findIndex(
      (entry) =>
        entry.clientRunId === clientRunId && (sessionKey ? entry.sessionKey === sessionKey : true),
    );
    if (idx < 0) {
      return undefined;
    }
    const [entry] = queue.splice(idx, 1);
    if (!queue.length) {
      chatRunSessions.delete(sessionId);
    }
    return entry;
  };

  const clear = () => {
    chatRunSessions.clear();
  };

  return { add, peek, shift, remove, clear };
}

export type ChatRunState = {
  registry: ChatRunRegistry;
  buffers: Map<string, string>;
  deltaSentAt: Map<string, number>;
  abortedRuns: Map<string, number>;
  clear: () => void;
};

export function createChatRunState(): ChatRunState {
  const registry = createChatRunRegistry();
  const buffers = new Map<string, string>();
  const deltaSentAt = new Map<string, number>();
  const abortedRuns = new Map<string, number>();

  const clear = () => {
    registry.clear();
    buffers.clear();
    deltaSentAt.clear();
    abortedRuns.clear();
  };

  return {
    registry,
    buffers,
    deltaSentAt,
    abortedRuns,
    clear,
  };
}

export type ToolEventRecipientRegistry = {
  add: (runId: string, connId: string) => void;
  get: (runId: string) => ReadonlySet<string> | undefined;
  markFinal: (runId: string) => void;
};

export type SessionEventSubscriptionRegistry = {
  subscribe: (connId: string, sessionKey: string, streams?: readonly string[]) => void;
  unsubscribe: (connId: string, sessionKey: string, streams?: readonly string[]) => void;
  getRecipients: (sessionKey: string, stream: string) => ReadonlySet<string> | undefined;
  removeConn: (connId: string) => void;
};

type ToolRecipientEntry = {
  connIds: Set<string>;
  updatedAt: number;
  finalizedAt?: number;
};

const TOOL_EVENT_RECIPIENT_TTL_MS = 10 * 60 * 1000;
const TOOL_EVENT_RECIPIENT_FINAL_GRACE_MS = 30 * 1000;

export function createToolEventRecipientRegistry(): ToolEventRecipientRegistry {
  const recipients = new Map<string, ToolRecipientEntry>();

  const prune = () => {
    if (recipients.size === 0) {
      return;
    }
    const now = Date.now();
    for (const [runId, entry] of recipients) {
      const cutoff = entry.finalizedAt
        ? entry.finalizedAt + TOOL_EVENT_RECIPIENT_FINAL_GRACE_MS
        : entry.updatedAt + TOOL_EVENT_RECIPIENT_TTL_MS;
      if (now >= cutoff) {
        recipients.delete(runId);
      }
    }
  };

  const add = (runId: string, connId: string) => {
    if (!runId || !connId) {
      return;
    }
    const now = Date.now();
    const existing = recipients.get(runId);
    if (existing) {
      existing.connIds.add(connId);
      existing.updatedAt = now;
    } else {
      recipients.set(runId, {
        connIds: new Set([connId]),
        updatedAt: now,
      });
    }
    prune();
  };

  const get = (runId: string) => {
    const entry = recipients.get(runId);
    if (!entry) {
      return undefined;
    }
    entry.updatedAt = Date.now();
    prune();
    return entry.connIds;
  };

  const markFinal = (runId: string) => {
    const entry = recipients.get(runId);
    if (!entry) {
      return;
    }
    entry.finalizedAt = Date.now();
    prune();
  };

  return { add, get, markFinal };
}

const SESSION_EVENT_WILDCARD_STREAM = "*";

function normalizeSessionEventStreams(streams?: readonly string[]): string[] {
  if (!Array.isArray(streams) || streams.length === 0) {
    return [SESSION_EVENT_WILDCARD_STREAM];
  }
  const normalized = streams
    .map((stream) => String(stream ?? "").trim())
    .filter((stream) => stream.length > 0);
  if (normalized.length === 0 || normalized.includes(SESSION_EVENT_WILDCARD_STREAM)) {
    return [SESSION_EVENT_WILDCARD_STREAM];
  }
  return Array.from(new Set(normalized));
}

export function createSessionEventSubscriptionRegistry(): SessionEventSubscriptionRegistry {
  const bySession = new Map<string, Map<string, Set<string>>>();
  const byConn = new Map<string, Map<string, Set<string>>>();

  const addSessionStreamBinding = (sessionKey: string, stream: string, connId: string) => {
    let streams = bySession.get(sessionKey);
    if (!streams) {
      streams = new Map<string, Set<string>>();
      bySession.set(sessionKey, streams);
    }
    let connIds = streams.get(stream);
    if (!connIds) {
      connIds = new Set<string>();
      streams.set(stream, connIds);
    }
    connIds.add(connId);
  };

  const addConnSessionBinding = (connId: string, sessionKey: string, stream: string) => {
    let sessions = byConn.get(connId);
    if (!sessions) {
      sessions = new Map<string, Set<string>>();
      byConn.set(connId, sessions);
    }
    let streams = sessions.get(sessionKey);
    if (!streams) {
      streams = new Set<string>();
      sessions.set(sessionKey, streams);
    }
    streams.add(stream);
  };

  const removeBinding = (connId: string, sessionKey: string, stream: string) => {
    const sessionStreams = bySession.get(sessionKey);
    const streamConnIds = sessionStreams?.get(stream);
    streamConnIds?.delete(connId);
    if (streamConnIds && streamConnIds.size === 0) {
      sessionStreams?.delete(stream);
    }
    if (sessionStreams && sessionStreams.size === 0) {
      bySession.delete(sessionKey);
    }

    const connSessions = byConn.get(connId);
    const connStreams = connSessions?.get(sessionKey);
    connStreams?.delete(stream);
    if (connStreams && connStreams.size === 0) {
      connSessions?.delete(sessionKey);
    }
    if (connSessions && connSessions.size === 0) {
      byConn.delete(connId);
    }
  };

  const subscribe = (connId: string, sessionKey: string, streams?: readonly string[]) => {
    if (!connId || !sessionKey) {
      return;
    }
    for (const stream of normalizeSessionEventStreams(streams)) {
      addSessionStreamBinding(sessionKey, stream, connId);
      addConnSessionBinding(connId, sessionKey, stream);
    }
  };

  const unsubscribe = (connId: string, sessionKey: string, streams?: readonly string[]) => {
    if (!connId || !sessionKey) {
      return;
    }
    const connSessions = byConn.get(connId);
    const boundStreams = connSessions?.get(sessionKey);
    if (!boundStreams || boundStreams.size === 0) {
      return;
    }
    const normalizedStreams = normalizeSessionEventStreams(streams);
    const removeAll = normalizedStreams.includes(SESSION_EVENT_WILDCARD_STREAM);
    const targets = removeAll ? Array.from(boundStreams) : normalizedStreams;
    for (const stream of targets) {
      removeBinding(connId, sessionKey, stream);
    }
  };

  const getRecipients = (sessionKey: string, stream: string) => {
    const sessionStreams = bySession.get(sessionKey);
    if (!sessionStreams) {
      return undefined;
    }
    const wildcardRecipients = sessionStreams.get(SESSION_EVENT_WILDCARD_STREAM);
    const streamRecipients = sessionStreams.get(stream);
    if (!wildcardRecipients && !streamRecipients) {
      return undefined;
    }
    if (!wildcardRecipients) {
      return streamRecipients;
    }
    if (!streamRecipients || wildcardRecipients === streamRecipients) {
      return wildcardRecipients;
    }
    return new Set<string>([...wildcardRecipients, ...streamRecipients]);
  };

  const removeConn = (connId: string) => {
    const sessions = byConn.get(connId);
    if (!sessions) {
      return;
    }
    for (const [sessionKey, streams] of sessions) {
      for (const stream of streams) {
        removeBinding(connId, sessionKey, stream);
      }
    }
  };

  return {
    subscribe,
    unsubscribe,
    getRecipients,
    removeConn,
  };
}

export type ChatEventBroadcast = (
  event: string,
  payload: unknown,
  opts?: { dropIfSlow?: boolean },
) => void;

export type NodeSendToSession = (sessionKey: string, event: string, payload: unknown) => void;

export type AgentEventHandlerOptions = {
  broadcast: ChatEventBroadcast;
  broadcastToConnIds: (
    event: string,
    payload: unknown,
    connIds: ReadonlySet<string>,
    opts?: { dropIfSlow?: boolean },
  ) => void;
  nodeSendToSession: NodeSendToSession;
  agentRunSeq: Map<string, number>;
  chatRunState: ChatRunState;
  resolveSessionKeyForRun: (runId: string) => string | undefined;
  clearAgentRunContext: (runId: string) => void;
  toolEventRecipients: ToolEventRecipientRegistry;
  sessionEventSubscriptions?: SessionEventSubscriptionRegistry;
};

const DEFAULT_CHAT_BRIDGE_DELTA_THROTTLE_MS = 150;

function resolveChatBridgeDeltaThrottleMs(): number {
  const raw =
    process.env.OPENCLAW_GATEWAY_CHAT_DELTA_THROTTLE_MS ??
    process.env.OPENCLAW_CHAT_DELTA_THROTTLE_MS;
  if (!raw || !raw.trim()) {
    return DEFAULT_CHAT_BRIDGE_DELTA_THROTTLE_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_CHAT_BRIDGE_DELTA_THROTTLE_MS;
  }
  return Math.max(0, Math.floor(parsed));
}

function buildChatAssistantMessageId(clientRunId: string): string {
  return `chat-assistant:${clientRunId}`;
}

export function createAgentEventHandler({
  broadcast,
  broadcastToConnIds,
  nodeSendToSession,
  agentRunSeq,
  chatRunState,
  resolveSessionKeyForRun,
  clearAgentRunContext,
  toolEventRecipients,
  sessionEventSubscriptions,
}: AgentEventHandlerOptions) {
  const sessionSubscriptions = sessionEventSubscriptions;
  const chatBridgeDeltaThrottleMs = resolveChatBridgeDeltaThrottleMs();
  const emitChatDelta = (
    sessionKey: string,
    clientRunId: string,
    sourceRunId: string,
    seq: number,
    text: string,
  ) => {
    const cleaned = stripInlineDirectiveTagsForDisplay(text).text;
    if (!cleaned) {
      return;
    }
    if (isSilentReplyText(cleaned, SILENT_REPLY_TOKEN)) {
      return;
    }
    const previousCleaned = chatRunState.buffers.get(clientRunId) ?? "";
    chatRunState.buffers.set(clientRunId, cleaned);
    if (shouldHideHeartbeatChatOutput(clientRunId, sourceRunId)) {
      return;
    }

    let deltaText = cleaned;
    if (previousCleaned) {
      if (cleaned.startsWith(previousCleaned)) {
        deltaText = cleaned.slice(previousCleaned.length);
      } else if (previousCleaned.startsWith(cleaned)) {
        deltaText = "";
      }
    }
    if (!deltaText && cleaned === previousCleaned) {
      return;
    }

    const now = Date.now();
    const last = chatRunState.deltaSentAt.get(clientRunId) ?? 0;
    if (chatBridgeDeltaThrottleMs > 0 && now - last < chatBridgeDeltaThrottleMs) {
      return;
    }
    chatRunState.deltaSentAt.set(clientRunId, now);
    const payload = {
      runId: clientRunId,
      sessionKey,
      seq,
      state: "delta" as const,
      delta: deltaText,
      message: {
        id: buildChatAssistantMessageId(clientRunId),
        role: "assistant",
        content: [{ type: "text", text: cleaned }],
        timestamp: now,
      },
    };
    broadcast("chat", payload, { dropIfSlow: true });
    nodeSendToSession(sessionKey, "chat", payload);
  };

  const emitChatFinal = (
    sessionKey: string,
    clientRunId: string,
    sourceRunId: string,
    seq: number,
    jobState: "done" | "error",
    error?: unknown,
  ) => {
    const bufferedText = stripInlineDirectiveTagsForDisplay(
      chatRunState.buffers.get(clientRunId) ?? "",
    ).text.trim();
    const normalizedHeartbeatText = normalizeHeartbeatChatFinalText({
      runId: clientRunId,
      sourceRunId,
      text: bufferedText,
    });
    const text = normalizedHeartbeatText.text.trim();
    const shouldSuppressSilent =
      normalizedHeartbeatText.suppress || isSilentReplyText(text, SILENT_REPLY_TOKEN);
    chatRunState.buffers.delete(clientRunId);
    chatRunState.deltaSentAt.delete(clientRunId);
    if (jobState === "done") {
      const payload = {
        runId: clientRunId,
        sessionKey,
        seq,
        state: "final" as const,
        message:
          text && !shouldSuppressSilent
            ? {
                id: buildChatAssistantMessageId(clientRunId),
                role: "assistant",
                content: [{ type: "text", text }],
                timestamp: Date.now(),
              }
            : undefined,
      };
      broadcast("chat", payload);
      nodeSendToSession(sessionKey, "chat", payload);
      return;
    }
    const payload = {
      runId: clientRunId,
      sessionKey,
      seq,
      state: "error" as const,
      errorMessage: error ? formatForLog(error) : undefined,
    };
    broadcast("chat", payload);
    nodeSendToSession(sessionKey, "chat", payload);
  };

  const resolveToolVerboseLevel = (runId: string, sessionKey?: string) => {
    const runContext = getAgentRunContext(runId);
    const runVerbose = normalizeVerboseLevel(runContext?.verboseLevel);
    if (runVerbose) {
      return runVerbose;
    }
    if (!sessionKey) {
      return "off";
    }
    try {
      const { cfg, entry } = loadSessionEntry(sessionKey);
      const sessionVerbose = normalizeVerboseLevel(entry?.verboseLevel);
      if (sessionVerbose) {
        return sessionVerbose;
      }
      const defaultVerbose = normalizeVerboseLevel(cfg.agents?.defaults?.verboseDefault);
      return defaultVerbose ?? "off";
    } catch {
      return "off";
    }
  };

  return (evt: AgentEventPayload) => {
    const chatLink = chatRunState.registry.peek(evt.runId);
    const eventSessionKey =
      typeof evt.sessionKey === "string" && evt.sessionKey.trim() ? evt.sessionKey : undefined;
    const sessionKey =
      chatLink?.sessionKey ?? eventSessionKey ?? resolveSessionKeyForRun(evt.runId);
    const clientRunId = chatLink?.clientRunId ?? evt.runId;
    const eventRunId = chatLink?.clientRunId ?? evt.runId;
    const eventForClients = chatLink ? { ...evt, runId: eventRunId } : evt;
    const isAborted =
      chatRunState.abortedRuns.has(clientRunId) || chatRunState.abortedRuns.has(evt.runId);
    // Include sessionKey so Control UI can filter tool streams per session.
    const agentPayload = sessionKey ? { ...eventForClients, sessionKey } : eventForClients;
    const last = agentRunSeq.get(evt.runId) ?? 0;
    const isToolEvent = evt.stream === "tool";
    const toolVerbose = isToolEvent ? resolveToolVerboseLevel(evt.runId, sessionKey) : "off";
    // Build tool payload: strip result/partialResult unless verbose=full
    const toolPayload =
      isToolEvent && toolVerbose !== "full"
        ? (() => {
            const data = evt.data ? { ...evt.data } : {};
            delete data.result;
            delete data.partialResult;
            return sessionKey
              ? { ...eventForClients, sessionKey, data }
              : { ...eventForClients, data };
          })()
        : agentPayload;
    if (evt.seq !== last + 1) {
      broadcast(
        "agent",
        {
          runId: eventRunId,
          stream: "error",
          ts: Date.now(),
          sessionKey,
          data: {
            reason: "seq gap",
            expected: last + 1,
            received: evt.seq,
          },
        },
        { dropIfSlow: true },
      );
    }
    agentRunSeq.set(evt.runId, evt.seq);
    if (isToolEvent) {
      // Always broadcast tool events to registered WS recipients with
      // tool-events capability, regardless of verboseLevel. The verbose
      // setting only controls whether tool details are sent as channel
      // messages to messaging surfaces (Telegram, Discord, etc.).
      const recipients = new Set<string>();
      const runRecipients = toolEventRecipients.get(evt.runId);
      if (runRecipients && runRecipients.size > 0) {
        for (const connId of runRecipients) {
          recipients.add(connId);
        }
      }
      if (sessionKey && sessionSubscriptions) {
        const sessionRecipients = sessionSubscriptions.getRecipients(sessionKey, "tool");
        if (sessionRecipients && sessionRecipients.size > 0) {
          for (const connId of sessionRecipients) {
            recipients.add(connId);
          }
        }
      }
      if (recipients.size > 0) {
        broadcastToConnIds("agent", toolPayload, recipients, { dropIfSlow: true });
      }
    } else {
      broadcast("agent", agentPayload, { dropIfSlow: true });
    }

    const lifecyclePhase =
      evt.stream === "lifecycle" && typeof evt.data?.phase === "string" ? evt.data.phase : null;

    if (sessionKey) {
      // Send tool events to node/channel subscribers only when verbose is enabled;
      // WS clients already received the event above via broadcastToConnIds.
      if (!isToolEvent || toolVerbose !== "off") {
        nodeSendToSession(sessionKey, "agent", isToolEvent ? toolPayload : agentPayload);
      }
      if (!isAborted && evt.stream === "assistant" && typeof evt.data?.text === "string") {
        emitChatDelta(sessionKey, clientRunId, evt.runId, evt.seq, evt.data.text);
      } else if (!isAborted && (lifecyclePhase === "end" || lifecyclePhase === "error")) {
        if (chatLink) {
          const finished = chatRunState.registry.shift(evt.runId);
          if (!finished) {
            clearAgentRunContext(evt.runId);
            return;
          }
          emitChatFinal(
            finished.sessionKey,
            finished.clientRunId,
            evt.runId,
            evt.seq,
            lifecyclePhase === "error" ? "error" : "done",
            evt.data?.error,
          );
        } else {
          emitChatFinal(
            sessionKey,
            eventRunId,
            evt.runId,
            evt.seq,
            lifecyclePhase === "error" ? "error" : "done",
            evt.data?.error,
          );
        }
      } else if (isAborted && (lifecyclePhase === "end" || lifecyclePhase === "error")) {
        chatRunState.abortedRuns.delete(clientRunId);
        chatRunState.abortedRuns.delete(evt.runId);
        chatRunState.buffers.delete(clientRunId);
        chatRunState.deltaSentAt.delete(clientRunId);
        if (chatLink) {
          chatRunState.registry.remove(evt.runId, clientRunId, sessionKey);
        }
      }
    }

    if (lifecyclePhase === "end" || lifecyclePhase === "error") {
      toolEventRecipients.markFinal(evt.runId);
      clearAgentRunContext(evt.runId);
      agentRunSeq.delete(evt.runId);
      agentRunSeq.delete(clientRunId);
    }
  };
}

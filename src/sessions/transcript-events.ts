import { normalizeOptionalString } from "../shared/string-coerce.js";

export type SessionTranscriptUpdate = {
  sessionFile: string;
  sessionKey?: string;
  operation?: "append" | "recall";
  message?: unknown;
  messageId?: string;
  recalledMessageId?: string;
  removedEntries?: number;
  removedMessages?: number;
  abortedRunIds?: string[];
};

type SessionTranscriptListener = (update: SessionTranscriptUpdate) => void;

const SESSION_TRANSCRIPT_LISTENERS = new Set<SessionTranscriptListener>();

export function onSessionTranscriptUpdate(listener: SessionTranscriptListener): () => void {
  SESSION_TRANSCRIPT_LISTENERS.add(listener);
  return () => {
    SESSION_TRANSCRIPT_LISTENERS.delete(listener);
  };
}

export function emitSessionTranscriptUpdate(update: string | SessionTranscriptUpdate): void {
  const normalized =
    typeof update === "string"
      ? { sessionFile: update }
      : {
          sessionFile: update.sessionFile,
          sessionKey: update.sessionKey,
          operation: update.operation,
          message: update.message,
          messageId: update.messageId,
          recalledMessageId: update.recalledMessageId,
          removedEntries: update.removedEntries,
          removedMessages: update.removedMessages,
          abortedRunIds: update.abortedRunIds,
        };
  const trimmed = normalizeOptionalString(normalized.sessionFile);
  if (!trimmed) {
    return;
  }
  const nextUpdate: SessionTranscriptUpdate = {
    sessionFile: trimmed,
    ...(normalizeOptionalString(normalized.sessionKey)
      ? { sessionKey: normalizeOptionalString(normalized.sessionKey) }
      : {}),
    ...(normalized.operation === "recall" ? { operation: "recall" as const } : {}),
    ...(normalized.message !== undefined ? { message: normalized.message } : {}),
    ...(normalizeOptionalString(normalized.messageId)
      ? { messageId: normalizeOptionalString(normalized.messageId) }
      : {}),
    ...(normalizeOptionalString(normalized.recalledMessageId)
      ? { recalledMessageId: normalizeOptionalString(normalized.recalledMessageId) }
      : {}),
    ...(typeof normalized.removedEntries === "number" && Number.isFinite(normalized.removedEntries)
      ? { removedEntries: Math.max(0, Math.floor(normalized.removedEntries)) }
      : {}),
    ...(typeof normalized.removedMessages === "number" &&
    Number.isFinite(normalized.removedMessages)
      ? { removedMessages: Math.max(0, Math.floor(normalized.removedMessages)) }
      : {}),
    ...(Array.isArray(normalized.abortedRunIds)
      ? {
          abortedRunIds: normalized.abortedRunIds
            .map((id) => normalizeOptionalString(id))
            .filter((id): id is string => Boolean(id)),
        }
      : {}),
  };
  for (const listener of SESSION_TRANSCRIPT_LISTENERS) {
    try {
      listener(nextUpdate);
    } catch {
      /* ignore */
    }
  }
}

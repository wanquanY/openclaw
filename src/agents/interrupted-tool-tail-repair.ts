import fs from "node:fs";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import type { SessionEntry } from "../config/sessions.js";
import {
  readSessionMessages,
  resolveSessionTranscriptCandidates,
} from "../gateway/session-utils.fs.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { makeMissingToolResult } from "./session-transcript-repair.js";
import { acquireSessionWriteLock } from "./session-write-lock.js";
import { extractToolCallsFromAssistant } from "./tool-call-id.js";

type RepairLog = {
  warn: (message: string) => void;
};

function getMessageRole(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const role = (message as { role?: unknown }).role;
  return typeof role === "string" ? role : undefined;
}

function isMeaningfulTailMessage(message: unknown): boolean {
  const role = getMessageRole(message);
  return Boolean(role && role !== "system");
}

export function getLastMeaningfulTailMessage(messages: unknown[]): unknown | undefined {
  return messages.toReversed().find(isMeaningfulTailMessage);
}

export function isResumableTailMessage(message: unknown): boolean {
  const role = getMessageRole(message);
  return role === "user" || role === "tool" || role === "toolResult";
}

export function isSessionTranscriptResumable(messages: unknown[]): boolean {
  const lastMeaningful = getLastMeaningfulTailMessage(messages);
  return lastMeaningful ? isResumableTailMessage(lastMeaningful) : false;
}

function resolveExistingTranscriptPath(entry: SessionEntry, storePath: string): string | null {
  const candidates = resolveSessionTranscriptCandidates(
    entry.sessionId,
    storePath,
    entry.sessionFile,
  );
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function isSessionManagerTranscript(transcriptPath: string): boolean {
  try {
    const fd = fs.openSync(transcriptPath, "r");
    try {
      const buffer = Buffer.alloc(8192);
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      const firstLine = buffer.toString("utf8", 0, bytesRead).split(/\r?\n/, 1)[0]?.trim();
      if (!firstLine) {
        return false;
      }
      const parsed = JSON.parse(firstLine) as { type?: unknown; version?: unknown };
      return parsed.type === "session" && typeof parsed.version === "number";
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function getInterruptedTailToolCalls(
  message: unknown,
): ReturnType<typeof extractToolCallsFromAssistant> {
  if (!message || typeof message !== "object") {
    return [];
  }
  if ((message as { role?: unknown }).role !== "assistant") {
    return [];
  }
  return extractToolCallsFromAssistant(message as Extract<AgentMessage, { role: "assistant" }>);
}

export async function appendSyntheticInterruptedToolResults(params: {
  storePath: string;
  sessionKey: string;
  entry: SessionEntry;
  missingToolResultText: string;
  log?: RepairLog;
}): Promise<{ messages: unknown[]; inserted: number }> {
  const initialMessages = readSessionMessages(
    params.entry.sessionId,
    params.storePath,
    params.entry.sessionFile,
  );
  const initialToolCalls = getInterruptedTailToolCalls(
    getLastMeaningfulTailMessage(initialMessages),
  );
  if (initialToolCalls.length === 0) {
    return { messages: initialMessages, inserted: 0 };
  }

  const transcriptPath = resolveExistingTranscriptPath(params.entry, params.storePath);
  if (!transcriptPath) {
    return { messages: initialMessages, inserted: 0 };
  }
  if (!isSessionManagerTranscript(transcriptPath)) {
    params.log?.warn(
      `cannot repair interrupted assistant tool tail for ${params.sessionKey}: ` +
        "transcript is not a SessionManager transcript",
    );
    return { messages: initialMessages, inserted: 0 };
  }

  const lock = await acquireSessionWriteLock({
    sessionFile: transcriptPath,
    timeoutMs: 5_000,
    maxHoldMs: 30_000,
  });
  try {
    const freshMessages = readSessionMessages(
      params.entry.sessionId,
      params.storePath,
      params.entry.sessionFile,
    );
    const freshToolCalls = getInterruptedTailToolCalls(getLastMeaningfulTailMessage(freshMessages));
    if (freshToolCalls.length === 0 || isSessionTranscriptResumable(freshMessages)) {
      return { messages: freshMessages, inserted: 0 };
    }

    const sessionManager = SessionManager.open(transcriptPath);
    const repairedMessages: AgentMessage[] = [];
    for (const toolCall of freshToolCalls) {
      const repaired = makeMissingToolResult({
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        text: params.missingToolResultText,
      });
      const messageId = sessionManager.appendMessage(repaired);
      emitSessionTranscriptUpdate({
        sessionFile: transcriptPath,
        sessionKey: params.sessionKey,
        message: repaired,
        messageId,
      });
      repairedMessages.push(repaired);
    }

    params.log?.warn(
      `repaired interrupted assistant tool tail for ${params.sessionKey}: ` +
        `inserted ${repairedMessages.length} synthetic tool result(s)`,
    );
    return {
      messages: [...freshMessages, ...repairedMessages],
      inserted: repairedMessages.length,
    };
  } finally {
    await lock.release();
  }
}

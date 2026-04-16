import { updateSessionStore } from "./store.js";
import type { SessionEntry, SessionCompressedMemory } from "./types.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { resolveStorePath } from "./paths.js";
import { resolveSessionStoreAgentId, resolveSessionStoreKey } from "../../gateway/session-store-key.js";

const MAX_COMPRESSED_SESSION_MEMORY_CHARS = 12_000;
const MAX_COMPRESSED_SESSION_PROMPT_CHARS = 8_000;

function trimSummary(summary: string, maxChars: number): string {
  const normalized = summary.trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars)}\n...[truncated]...`;
}

export function normalizeCompressedSessionMemorySummary(summary: unknown): string | undefined {
  const normalized = normalizeOptionalString(summary);
  if (!normalized) {
    return undefined;
  }
  return trimSummary(normalized, MAX_COMPRESSED_SESSION_MEMORY_CHARS);
}

export function buildCompressedSessionMemoryRecord(params: {
  summary: string;
  updatedAt?: number;
  compactionCount?: number;
  tokensBefore?: number;
  tokensAfter?: number;
}): SessionCompressedMemory {
  return {
    summary: trimSummary(params.summary, MAX_COMPRESSED_SESSION_MEMORY_CHARS),
    updatedAt: params.updatedAt ?? Date.now(),
    ...(typeof params.compactionCount === "number"
      ? { compactionCount: Math.max(0, Math.trunc(params.compactionCount)) }
      : {}),
    ...(typeof params.tokensBefore === "number" ? { tokensBefore: params.tokensBefore } : {}),
    ...(typeof params.tokensAfter === "number" ? { tokensAfter: params.tokensAfter } : {}),
  };
}

export async function persistCompressedSessionMemory(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  summary: string;
  updatedAt?: number;
  compactionCount?: number;
  tokensBefore?: number;
  tokensAfter?: number;
}): Promise<SessionCompressedMemory | null> {
  const canonicalKey = resolveSessionStoreKey({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
  });
  const agentId = resolveSessionStoreAgentId(params.cfg, canonicalKey);
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId });
  const normalizedSummary = normalizeCompressedSessionMemorySummary(params.summary);
  if (!normalizedSummary) {
    return null;
  }
  const memory = buildCompressedSessionMemoryRecord({
    summary: normalizedSummary,
    updatedAt: params.updatedAt,
    compactionCount: params.compactionCount,
    tokensBefore: params.tokensBefore,
    tokensAfter: params.tokensAfter,
  });
  let stored = false;
  await updateSessionStore(storePath, (store) => {
    const existing = store[canonicalKey];
    if (!existing?.sessionId) {
      return;
    }
    store[canonicalKey] = {
      ...existing,
      updatedAt: Math.max(existing.updatedAt ?? 0, memory.updatedAt),
      compressedSessionMemory: memory,
    };
    stored = true;
  });
  return stored ? memory : null;
}

export function buildCompressedSessionMemoryPrompt(
  entry: Pick<SessionEntry, "compressedSessionMemory"> | undefined,
): string | null {
  const summary = normalizeCompressedSessionMemorySummary(entry?.compressedSessionMemory?.summary);
  if (!summary) {
    return null;
  }
  const memory = entry?.compressedSessionMemory;
  const promptBody = trimSummary(summary, MAX_COMPRESSED_SESSION_PROMPT_CHARS);
  const metadataLines = [
    typeof memory?.compactionCount === "number"
      ? `Compaction count: ${memory.compactionCount}`
      : undefined,
    typeof memory?.tokensBefore === "number" ? `Tokens before compaction: ${memory.tokensBefore}` : undefined,
    typeof memory?.tokensAfter === "number" ? `Tokens after compaction: ${memory.tokensAfter}` : undefined,
    typeof memory?.updatedAt === "number"
      ? `Compressed memory updated at: ${new Date(memory.updatedAt).toISOString()}`
      : undefined,
  ].filter(Boolean);
  return [
    "[Session compressed memory]",
    "The active session transcript was compacted earlier. Use the compressed memory below to preserve continuity for prior goals, decisions, files, constraints, and unfinished work.",
    "Treat newer transcript turns as higher priority if they conflict with this memory.",
    metadataLines.length > 0 ? metadataLines.join("\n") : undefined,
    promptBody,
  ]
    .filter(Boolean)
    .join("\n\n");
}

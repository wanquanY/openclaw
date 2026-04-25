import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent } from "@mariozechner/pi-ai";
import {
  COMPUTER_USE_OBSERVATION_CONTINUATION_PREFIX,
  markComputerUseObservationContinuationMessage,
} from "../../computer-use/observation-continuation.js";
import type {
  ComputerUseAxSnapshot,
  ComputerUseCandidate,
  ComputerUseStructuredPayload,
} from "../../computer-use/types.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";

type GuardableTransformContext = (
  messages: AgentMessage[],
  signal: AbortSignal,
) => AgentMessage[] | Promise<AgentMessage[]>;

type GuardableAgentRecord = {
  transformContext?: GuardableTransformContext;
};

type UserAgentMessage = Extract<AgentMessage, { role: "user" }>;

type ComputerUseToolResultMessage = Extract<AgentMessage, { role: "toolResult" }> & {
  toolName?: string;
  details?: unknown;
};

type CandidateImageBlock = ImageContent & {
  fileName?: string;
  previewData?: string;
  previewMimeType?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isComputerUseStructuredPayload(value: unknown): value is ComputerUseStructuredPayload {
  return isRecord(value) && value.kind === "computer_use/v1";
}

function isComputerUseToolResult(
  message: AgentMessage | undefined,
): message is ComputerUseToolResultMessage {
  if (!message || message.role !== "toolResult") {
    return false;
  }
  const toolName = normalizeOptionalString((message as { toolName?: unknown }).toolName);
  if (toolName === "computer_use") {
    return true;
  }
  return isComputerUseStructuredPayload((message as { details?: unknown }).details);
}

function extractLatestComputerUseToolResult(
  messages: AgentMessage[],
): { index: number; message: ComputerUseToolResultMessage } | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) {
      continue;
    }
    if (message.role === "toolResult") {
      return isComputerUseToolResult(message) ? { index, message } : undefined;
    }
    return undefined;
  }
  return undefined;
}

function extractImageBlocks(message: ComputerUseToolResultMessage): CandidateImageBlock[] {
  if (!Array.isArray(message.content)) {
    return [];
  }
  return message.content.filter(
    (block): block is CandidateImageBlock =>
      Boolean(block) &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "image" &&
      typeof (block as { data?: unknown }).data === "string" &&
      typeof (block as { mimeType?: unknown }).mimeType === "string",
  );
}

function stripToolResultImages(
  message: ComputerUseToolResultMessage,
): ComputerUseToolResultMessage {
  if (!Array.isArray(message.content)) {
    return message;
  }
  const contentWithoutImages = message.content.filter(
    (block) =>
      !block || typeof block !== "object" || (block as { type?: unknown }).type !== "image",
  );
  if (contentWithoutImages.length > 0) {
    return {
      ...message,
      content: contentWithoutImages,
    };
  }
  return {
    ...message,
    content: [
      {
        type: "text",
        text: "Computer Use observation image attached via continuation input.",
      },
    ],
  } as ComputerUseToolResultMessage;
}

function formatObservationTarget(
  payload: ComputerUseStructuredPayload | undefined,
): string | undefined {
  const targetKind = normalizeOptionalString(payload?.observation?.targetKind);
  const appName = normalizeOptionalString(payload?.observation?.appName);
  const windowTitle = normalizeOptionalString(payload?.observation?.windowTitle);
  const windowId = normalizeOptionalString(payload?.observation?.windowId);
  const displayId = normalizeOptionalString(payload?.observation?.displayId);
  const parts = [
    targetKind ? `target=${targetKind}` : "",
    appName ? `app=${appName}` : "",
    windowTitle ? `window=${windowTitle}` : windowId ? `window=${windowId}` : "",
    displayId ? `display=${displayId}` : "",
  ].filter(Boolean);
  return parts.length > 0 ? `Observation target: ${parts.join(" | ")}` : undefined;
}

function formatAxSummary(axSnapshot: ComputerUseAxSnapshot | undefined): string | undefined {
  if (!axSnapshot) {
    return undefined;
  }
  const parts = [`supported=${axSnapshot.supported ? "yes" : "no"}`];
  if (normalizeOptionalString(axSnapshot.appName)) {
    parts.push(`app=${axSnapshot.appName}`);
  }
  if (normalizeOptionalString(axSnapshot.windowTitle)) {
    parts.push(`window=${axSnapshot.windowTitle}`);
  }
  if (typeof axSnapshot.nodeCount === "number") {
    parts.push(`nodes=${axSnapshot.nodeCount}`);
  }
  if (axSnapshot.truncated) {
    parts.push("truncated=yes");
  }
  return `AX snapshot: ${parts.join(" | ")}`;
}

function formatCandidates(candidates: ComputerUseCandidate[] | undefined): string | undefined {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return undefined;
  }
  const lines = candidates.slice(0, 6).map((candidate) => {
    const parts = [
      normalizeOptionalString(candidate.label) ?? candidate.id,
      normalizeOptionalString(candidate.role) ?? "candidate",
    ];
    if (typeof candidate.confidence === "number") {
      parts.push(`${Math.round(candidate.confidence * 100)}%`);
    }
    return `- ${parts.join(" | ")}`;
  });
  return lines.length > 0 ? `Candidates:\n${lines.join("\n")}` : undefined;
}

function buildContinuationSummary(params: {
  payload?: ComputerUseStructuredPayload;
  fallbackText?: string;
}): string {
  const payload = params.payload;
  const lines = [
    COMPUTER_USE_OBSERVATION_CONTINUATION_PREFIX,
    formatObservationTarget(payload),
    formatAxSummary(payload?.axSnapshot),
    formatCandidates(payload?.candidates),
    normalizeOptionalString(payload?.axSnapshot?.selectedText)
      ? `Selected text: ${payload?.axSnapshot?.selectedText}`
      : undefined,
    normalizeOptionalString(payload?.warning) ? `Warning: ${payload?.warning}` : undefined,
    normalizeOptionalString(payload?.error) ? `Error: ${payload?.error}` : undefined,
  ].filter((line): line is string => Boolean(line));

  if (lines.length > 1) {
    return lines.join("\n");
  }

  const fallback = normalizeOptionalString(params.fallbackText);
  return fallback
    ? `${COMPUTER_USE_OBSERVATION_CONTINUATION_PREFIX}\n${fallback}`
    : COMPUTER_USE_OBSERVATION_CONTINUATION_PREFIX;
}

function firstTextBlock(message: ComputerUseToolResultMessage): string | undefined {
  if (!Array.isArray(message.content)) {
    return typeof message.content === "string" ? message.content : undefined;
  }
  for (const block of message.content) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      return (block as { text: string }).text;
    }
  }
  return undefined;
}

function buildContinuationMessage(message: ComputerUseToolResultMessage): AgentMessage | undefined {
  const images = extractImageBlocks(message);
  const latestImage = images.at(-1);
  if (!latestImage) {
    return undefined;
  }
  const payload = isComputerUseStructuredPayload(message.details) ? message.details : undefined;
  const continuationMessage: UserAgentMessage = {
    role: "user",
    timestamp: typeof message.timestamp === "number" ? message.timestamp : Date.now(),
    content: [
      {
        type: "text",
        text: buildContinuationSummary({
          payload,
          fallbackText: firstTextBlock(message),
        }),
      },
      latestImage,
    ],
  };
  return markComputerUseObservationContinuationMessage(continuationMessage, {
    toolCallId: normalizeOptionalString(message.toolCallId ?? undefined) ?? undefined,
  });
}

export function appendComputerUseObservationContinuation(messages: AgentMessage[]): AgentMessage[] {
  const latest = extractLatestComputerUseToolResult(messages);
  if (!latest) {
    return messages;
  }
  const continuationMessage = buildContinuationMessage(latest.message);
  if (!continuationMessage) {
    return messages;
  }
  const nextMessages = messages.slice();
  nextMessages[latest.index] = stripToolResultImages(latest.message);
  nextMessages.push(continuationMessage);
  return nextMessages;
}

export function installComputerUseObservationContext(params: {
  agent: object;
  onInjected?: (meta: { index: number; totalMessages: number }) => void;
}): () => void {
  const mutableAgent = params.agent as GuardableAgentRecord;
  const originalTransformContext = mutableAgent.transformContext;

  mutableAgent.transformContext = (async (messages: AgentMessage[], signal: AbortSignal) => {
    const transformed = originalTransformContext
      ? await originalTransformContext.call(mutableAgent, messages, signal)
      : messages;
    const nextMessages = appendComputerUseObservationContinuation(transformed);
    if (nextMessages !== transformed) {
      params.onInjected?.({
        index: transformed.length - 1,
        totalMessages: nextMessages.length,
      });
    }
    return nextMessages;
  }) as GuardableTransformContext;

  return () => {
    mutableAgent.transformContext = originalTransformContext;
  };
}

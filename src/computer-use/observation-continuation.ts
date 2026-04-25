import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { normalizeOptionalString } from "../shared/string-coerce.js";

export const COMPUTER_USE_OBSERVATION_CONTINUATION_PREFIX =
  "Computer Use observation for the next action. Treat the attached image as the latest desktop state.";

type ComputerUseObservationContinuationMessage = Extract<AgentMessage, { role: "user" }> & {
  computerUseObservationContinuation?: true;
  computerUseSourceToolCallId?: string;
};

function hasImageBlock(message: Extract<AgentMessage, { role: "user" }>): boolean {
  return (
    Array.isArray(message.content) &&
    message.content.some(
      (block) =>
        Boolean(block) &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "image" &&
        typeof (block as { data?: unknown }).data === "string",
    )
  );
}

function firstTextBlock(message: Extract<AgentMessage, { role: "user" }>): string | undefined {
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

export function markComputerUseObservationContinuationMessage(
  message: Extract<AgentMessage, { role: "user" }>,
  params?: { toolCallId?: string },
): AgentMessage {
  return {
    ...message,
    computerUseObservationContinuation: true,
    ...(normalizeOptionalString(params?.toolCallId)
      ? { computerUseSourceToolCallId: normalizeOptionalString(params?.toolCallId) ?? undefined }
      : {}),
  } as AgentMessage;
}

export function isComputerUseObservationContinuationMessage(
  message: AgentMessage | undefined,
): message is ComputerUseObservationContinuationMessage {
  if (!message || message.role !== "user") {
    return false;
  }
  if (
    (message as { computerUseObservationContinuation?: unknown })
      .computerUseObservationContinuation === true
  ) {
    return hasImageBlock(message);
  }
  const firstText = normalizeOptionalString(firstTextBlock(message));
  return Boolean(
    firstText?.startsWith(COMPUTER_USE_OBSERVATION_CONTINUATION_PREFIX) && hasImageBlock(message),
  );
}

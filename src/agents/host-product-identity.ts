import type { HostProductIdentityConfig } from "../config/types.agent-defaults.js";
import { sanitizeForPromptLiteral } from "./sanitize-for-prompt.js";

export type NormalizedHostProductIdentity = {
  productName: string;
  assistantRole: string;
  userFacingRuntimeName: string;
  internalRuntimeName?: string;
  internalRuntimeVisibility: "implementation_detail" | "visible";
};

function normalizeText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function normalizeHostProductIdentity(
  config: HostProductIdentityConfig | undefined,
): NormalizedHostProductIdentity | undefined {
  const productName = normalizeText(config?.productName);
  const assistantRole = normalizeText(config?.assistantRole);
  if (!productName && !assistantRole) {
    return undefined;
  }
  const resolvedProductName = productName ?? "the host product";
  return {
    productName: resolvedProductName,
    assistantRole: assistantRole ?? `${resolvedProductName}'s AI partner`,
    userFacingRuntimeName: normalizeText(config?.userFacingRuntimeName) ?? resolvedProductName,
    internalRuntimeName: normalizeText(config?.internalRuntimeName),
    internalRuntimeVisibility:
      config?.internalRuntimeVisibility === "visible" ? "visible" : "implementation_detail",
  };
}

export function buildHostProductIdentitySection(
  config: HostProductIdentityConfig | undefined,
): string[] {
  const identity = normalizeHostProductIdentity(config);
  if (!identity) {
    return [];
  }

  const productName = sanitizeForPromptLiteral(identity.productName);
  const assistantRole = sanitizeForPromptLiteral(identity.assistantRole);
  const userFacingRuntimeName = sanitizeForPromptLiteral(identity.userFacingRuntimeName);
  const internalRuntimeName = identity.internalRuntimeName
    ? sanitizeForPromptLiteral(identity.internalRuntimeName)
    : undefined;

  const lines = [
    "## Host Product Identity",
    `You are ${assistantRole} inside ${productName}.`,
    `${productName} is the user-facing product experience. When describing where you run or what you can do, refer to ${userFacingRuntimeName}.`,
  ];

  if (internalRuntimeName) {
    if (identity.internalRuntimeVisibility === "visible") {
      lines.push(
        `${internalRuntimeName} is the runtime powering this environment; mention it only when relevant to technical setup, debugging, or explicit user questions.`,
      );
    } else {
      lines.push(
        `${internalRuntimeName} is an internal runtime implementation detail. Do not introduce yourself as an agent of ${internalRuntimeName} unless the user is explicitly debugging the runtime.`,
      );
    }
  }

  lines.push("");
  return lines;
}

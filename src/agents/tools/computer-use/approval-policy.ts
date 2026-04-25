import crypto from "node:crypto";
import type {
  ComputerUseAction,
  ComputerUseObservation,
  ComputerUseScope,
} from "../../../computer-use/types.js";
import { normalizeOptionalString } from "../../../shared/string-coerce.js";
import { readStringParam } from "../common.js";

const HIGH_RISK_COMPUTER_USE_ACTIONS = new Set<ComputerUseAction>([
  "launch_app",
  "type",
  "set_text_submit",
  "hotkey",
]);
const MAX_TRUSTED_COMPUTER_USE_SESSIONS = 128;
const MAX_TRUSTED_COMPUTER_USE_FINGERPRINTS_PER_SESSION = 64;
const trustedComputerUseApprovalFingerprintsBySession = new Map<string, Set<string>>();

export const COMPUTER_USE_ALLOWED_APPROVAL_DECISIONS = [
  "allow-once",
  "allow-always",
  "deny",
] as const;
export const COMPUTER_USE_APPROVAL_PLUGIN_ID = "openclaw.computer_use";

export type ComputerUseApprovalMetadata = {
  title: string;
  description: string;
  severity: "info" | "warning" | "critical";
  fingerprint?: string;
};

export type ComputerUseApprovalDecision =
  | "allow-once"
  | "allow-always"
  | "deny"
  | "timeout"
  | "cancelled"
  | "unavailable";

export type ComputerUseApprovalOutcome = {
  decision: ComputerUseApprovalDecision;
  approvalId?: string;
  approvalSlug?: string;
  expiresAtMs?: number;
};

function isHighRiskComputerUseAction(action: ComputerUseAction): boolean {
  return HIGH_RISK_COMPUTER_USE_ACTIONS.has(action);
}

function buildApprovalSlug(approvalId?: string): string | undefined {
  const normalizedId = normalizeOptionalString(approvalId);
  if (!normalizedId) {
    return undefined;
  }
  const compact = normalizedId.startsWith("plugin:")
    ? normalizedId.slice("plugin:".length)
    : normalizedId;
  return compact.slice(0, 8) || undefined;
}

function buildApprovalTargetKey(
  scope: ComputerUseScope,
  observation?: ComputerUseObservation,
): string | undefined {
  const targetId = normalizeOptionalString(observation?.targetId);
  if (targetId) {
    return targetId;
  }
  const windowId =
    normalizeOptionalString(observation?.windowId) ?? normalizeOptionalString(scope.windowId);
  if (windowId) {
    return `window:${windowId}`;
  }
  const displayId =
    normalizeOptionalString(observation?.displayId) ?? normalizeOptionalString(scope.displayId);
  if (displayId) {
    return `display:${displayId}`;
  }
  if (scope.type === "window" || scope.type === "display") {
    return undefined;
  }
  return `scope:${scope.type}`;
}

function hashApprovalText(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function buildHighRiskApprovalFingerprint(params: {
  action: ComputerUseAction;
  args: Record<string, unknown>;
  scope: ComputerUseScope;
  observation?: ComputerUseObservation;
}): string | undefined {
  const targetKey = buildApprovalTargetKey(params.scope, params.observation);
  if (params.action === "launch_app") {
    const appIdentity =
      normalizeOptionalString(readStringParam(params.args, "targetId")) ??
      normalizeOptionalString(readStringParam(params.args, "bundleId")) ??
      normalizeOptionalString(readStringParam(params.args, "appName"));
    return appIdentity ? `launch_app|${appIdentity}` : undefined;
  }
  if (params.action === "hotkey") {
    const hotkey = normalizeOptionalString(readStringParam(params.args, "hotkey"));
    if (!hotkey) {
      return undefined;
    }
    return [params.action, targetKey ?? "global", hotkey.toLowerCase()].join("|");
  }
  if (params.action === "type" || params.action === "set_text_submit") {
    const text = readStringParam(params.args, "text", { trim: false }) ?? "";
    if (!text || !targetKey) {
      return undefined;
    }
    return [params.action, targetKey, hashApprovalText(text)].join("|");
  }
  return targetKey ? `${params.action}|${targetKey}` : undefined;
}

function isTrustedHighRiskComputerUseFingerprint(
  sessionKey: string | undefined,
  fingerprint: string | undefined,
): boolean {
  const normalizedSessionKey = normalizeOptionalString(sessionKey);
  if (!normalizedSessionKey || !fingerprint) {
    return false;
  }
  const trusted = trustedComputerUseApprovalFingerprintsBySession.get(normalizedSessionKey);
  if (!trusted) {
    return false;
  }
  const allowed = trusted.has(fingerprint);
  if (allowed) {
    trustedComputerUseApprovalFingerprintsBySession.delete(normalizedSessionKey);
    trustedComputerUseApprovalFingerprintsBySession.set(normalizedSessionKey, trusted);
  }
  return allowed;
}

function rememberTrustedHighRiskComputerUseFingerprint(
  sessionKey: string | undefined,
  fingerprint: string | undefined,
): void {
  const normalizedSessionKey = normalizeOptionalString(sessionKey);
  if (!normalizedSessionKey || !fingerprint) {
    return;
  }
  if (!trustedComputerUseApprovalFingerprintsBySession.has(normalizedSessionKey)) {
    if (trustedComputerUseApprovalFingerprintsBySession.size >= MAX_TRUSTED_COMPUTER_USE_SESSIONS) {
      const oldestSessionKey = trustedComputerUseApprovalFingerprintsBySession.keys().next().value;
      if (oldestSessionKey) {
        trustedComputerUseApprovalFingerprintsBySession.delete(oldestSessionKey);
      }
    }
    trustedComputerUseApprovalFingerprintsBySession.set(normalizedSessionKey, new Set());
  }
  const trusted = trustedComputerUseApprovalFingerprintsBySession.get(normalizedSessionKey);
  if (!trusted) {
    return;
  }
  if (trusted.has(fingerprint)) {
    trusted.delete(fingerprint);
  } else if (trusted.size >= MAX_TRUSTED_COMPUTER_USE_FINGERPRINTS_PER_SESSION) {
    const oldestFingerprint = trusted.keys().next().value;
    if (oldestFingerprint) {
      trusted.delete(oldestFingerprint);
    }
  }
  trusted.add(fingerprint);
  trustedComputerUseApprovalFingerprintsBySession.delete(normalizedSessionKey);
  trustedComputerUseApprovalFingerprintsBySession.set(normalizedSessionKey, trusted);
}

function describeComputerUseTarget(
  scope: ComputerUseScope,
  observation?: ComputerUseObservation,
): string {
  const appName = normalizeOptionalString(observation?.appName);
  const windowTitle = normalizeOptionalString(observation?.windowTitle);
  const windowId =
    normalizeOptionalString(observation?.windowId) ?? normalizeOptionalString(scope.windowId);
  const displayId =
    normalizeOptionalString(observation?.displayId) ?? normalizeOptionalString(scope.displayId);
  if (appName && windowTitle) {
    return `${appName} — ${windowTitle}`;
  }
  if (appName && windowId) {
    return `${appName} (${windowId})`;
  }
  if (appName) {
    return appName;
  }
  if (windowTitle) {
    return windowId ? `${windowTitle} (${windowId})` : windowTitle;
  }
  if (windowId) {
    return `window ${windowId}`;
  }
  if (displayId) {
    return `display ${displayId}`;
  }
  if (scope.type === "current_window") {
    return "the current window";
  }
  if (scope.type === "full_desktop") {
    return "the desktop";
  }
  return scope.type.replace(/_/g, " ");
}

function buildHighRiskApprovalMetadata(params: {
  action: ComputerUseAction;
  args: Record<string, unknown>;
  scope: ComputerUseScope;
  observation?: ComputerUseObservation;
}): ComputerUseApprovalMetadata {
  const target = describeComputerUseTarget(params.scope, params.observation);
  const fingerprint = buildHighRiskApprovalFingerprint(params);
  if (params.action === "launch_app") {
    const appIdentity =
      normalizeOptionalString(readStringParam(params.args, "bundleId")) ??
      normalizeOptionalString(readStringParam(params.args, "appName")) ??
      "the requested app";
    return {
      title: "Approve launching an app",
      description: `OpenClaw wants to launch ${appIdentity} on ${target}.`,
      severity: "warning",
      fingerprint,
    };
  }
  if (params.action === "hotkey") {
    const hotkey =
      normalizeOptionalString(readStringParam(params.args, "hotkey")) ?? "the requested shortcut";
    return {
      title: "Approve a desktop shortcut",
      description: `OpenClaw wants to send ${hotkey} to ${target}.`,
      severity: "warning",
      fingerprint,
    };
  }
  const text = readStringParam(params.args, "text", { trim: false }) ?? "";
  const preview = text.length > 72 ? `${text.slice(0, 72)}...` : text;
  return {
    title: "Approve typing on the desktop",
    description: `OpenClaw wants to type into ${target}: ${preview || "(empty text)"}`,
    severity: "critical",
    fingerprint,
  };
}

export {
  buildApprovalSlug,
  buildHighRiskApprovalFingerprint,
  buildHighRiskApprovalMetadata,
  isHighRiskComputerUseAction,
  isTrustedHighRiskComputerUseFingerprint,
  rememberTrustedHighRiskComputerUseFingerprint,
};

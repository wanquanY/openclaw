import {
  INTERACTIVE_CAPABILITY_ACTIVATIONS,
  type InteractiveCapabilityActivation,
  INTERACTIVE_CAPABILITY_SOURCES,
  type InteractiveCapabilitySource,
} from "../interactive-capability/types.js";

export const BROWSER_USE_MODES = ["plan_and_act", "observe_only"] as const;

export const BROWSER_USE_HOST_POLICIES = [
  "local_only",
  "local_preferred",
  "remote_allowed",
] as const;

export const BROWSER_USE_ACTIVATIONS = INTERACTIVE_CAPABILITY_ACTIVATIONS;
export const BROWSER_USE_ACTIVATION_SOURCES = INTERACTIVE_CAPABILITY_SOURCES;

export type BrowserUseMode = (typeof BROWSER_USE_MODES)[number];
export type BrowserUseHostPolicy = (typeof BROWSER_USE_HOST_POLICIES)[number];
export type BrowserUseActivation = InteractiveCapabilityActivation;
export type BrowserUseActivationSource = InteractiveCapabilitySource;

export type BrowserUseSessionConfig = {
  enabled: boolean;
  mode: BrowserUseMode;
  hostPolicy: BrowserUseHostPolicy;
  activation: BrowserUseActivation;
  source?: BrowserUseActivationSource;
};

export type BrowserUseInvocationMetadata = {
  activation: BrowserUseActivation;
  source?: BrowserUseActivationSource;
};

export const DEFAULT_BROWSER_USE_SESSION_CONFIG = {
  enabled: false,
  mode: "plan_and_act",
  hostPolicy: "local_only",
  activation: "auto",
} as const satisfies BrowserUseSessionConfig;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeStringEnum<T extends readonly string[]>(
  value: unknown,
  allowed: T,
): T[number] | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return allowed.includes(normalized) ? (normalized as T[number]) : undefined;
}

function hasRecognizedSessionConfigKey(value: Record<string, unknown>): boolean {
  return ["enabled", "mode", "hostPolicy", "activation", "source"].some((key) => key in value);
}

export function normalizeBrowserUseSessionConfig(
  value: unknown,
): BrowserUseSessionConfig | undefined {
  if (!isRecord(value) || !hasRecognizedSessionConfigKey(value)) {
    return undefined;
  }

  return {
    enabled:
      typeof value.enabled === "boolean"
        ? value.enabled
        : DEFAULT_BROWSER_USE_SESSION_CONFIG.enabled,
    mode:
      normalizeStringEnum(value.mode, BROWSER_USE_MODES) ?? DEFAULT_BROWSER_USE_SESSION_CONFIG.mode,
    hostPolicy:
      normalizeStringEnum(value.hostPolicy, BROWSER_USE_HOST_POLICIES) ??
      DEFAULT_BROWSER_USE_SESSION_CONFIG.hostPolicy,
    activation:
      normalizeStringEnum(value.activation, BROWSER_USE_ACTIVATIONS) ??
      DEFAULT_BROWSER_USE_SESSION_CONFIG.activation,
    ...(normalizeStringEnum(value.source, BROWSER_USE_ACTIVATION_SOURCES)
      ? { source: normalizeStringEnum(value.source, BROWSER_USE_ACTIVATION_SOURCES) }
      : {}),
  };
}

export function cloneBrowserUseSessionConfig(
  value: BrowserUseSessionConfig | null | undefined,
): BrowserUseSessionConfig | undefined {
  return normalizeBrowserUseSessionConfig(value);
}

export function hasEnabledBrowserUse(value: unknown): boolean {
  return normalizeBrowserUseSessionConfig(value)?.enabled === true;
}

import { normalizeOptionalString } from "../shared/string-coerce.js";

export const COMPUTER_USE_SCOPE_TYPES = [
  "current_window",
  "window",
  "display",
  "full_desktop",
] as const;

export const COMPUTER_USE_MODES = ["plan_and_act", "observe_only"] as const;

export const COMPUTER_USE_HOST_POLICIES = [
  "local_only",
  "local_preferred",
  "remote_allowed",
] as const;

export const COMPUTER_USE_MODEL_POLICY_MODES = [
  "follow_user_model",
  "executor_override",
  "planner_executor_split",
] as const;

export const COMPUTER_USE_ACTIONS = [
  "observe",
  "discover_targets",
  "focus_window",
  "launch_app",
  "click",
  "double_click",
  "right_click",
  "move",
  "drag",
  "scroll",
  "type",
  "set_text_submit",
  "hotkey",
  "wait",
] as const;

export const COMPUTER_USE_STAGES = [
  "observing",
  "locating",
  "acting",
  "verifying",
  "completed",
  "error",
] as const;

export const COMPUTER_USE_PERMISSION_STATES = ["granted", "denied", "unknown"] as const;

export type ComputerUseScopeType = (typeof COMPUTER_USE_SCOPE_TYPES)[number];
export type ComputerUseMode = (typeof COMPUTER_USE_MODES)[number];
export type ComputerUseHostPolicy = (typeof COMPUTER_USE_HOST_POLICIES)[number];
export type ComputerUseModelPolicyMode = (typeof COMPUTER_USE_MODEL_POLICY_MODES)[number];
export type ComputerUseAction = (typeof COMPUTER_USE_ACTIONS)[number];
export type ComputerUseStage = (typeof COMPUTER_USE_STAGES)[number];
export type ComputerUsePermissionState = (typeof COMPUTER_USE_PERMISSION_STATES)[number];
type OpenString<T extends string> = T | (string & {});

export type ComputerUseScope = {
  type: ComputerUseScopeType;
  windowId?: string;
  displayId?: string;
};

export type ComputerUseSessionConfig = {
  enabled: boolean;
  mode: ComputerUseMode;
  scope: ComputerUseScope;
  hostPolicy: ComputerUseHostPolicy;
  modelPolicy: {
    mode: ComputerUseModelPolicyMode;
    executorModel?: string;
  };
  approvals: {
    highRiskActionsRequireConfirm: boolean;
  };
};

export const DEFAULT_COMPUTER_USE_SESSION_CONFIG = {
  enabled: false,
  mode: "plan_and_act",
  scope: {
    type: "full_desktop",
  },
  hostPolicy: "local_only",
  modelPolicy: {
    mode: "follow_user_model",
  },
  approvals: {
    highRiskActionsRequireConfirm: true,
  },
} as const satisfies ComputerUseSessionConfig;

export type ComputerUsePoint = {
  x: number;
  y: number;
};

export type ComputerUseRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ComputerUseSize = {
  width: number;
  height: number;
};

export type ComputerUseTargetKind = "window" | "display" | "desktop";

export type ComputerUseTargetBinding = {
  targetId: string;
  kind: ComputerUseTargetKind;
  observedAt?: string;
  app?: {
    appName?: string;
    bundleId?: string;
    processId?: number;
    running?: boolean;
  };
  window?: {
    windowId?: string;
    title?: string;
    isFocused?: boolean;
    isMinimized?: boolean;
    isMaximized?: boolean;
  };
  display?: {
    displayId?: string;
    name?: string;
    isPrimary?: boolean;
    isBuiltin?: boolean;
    scaleFactor?: number;
  };
  boundsGlobal?: ComputerUseRect;
  frameSize?: ComputerUseSize;
  logicalSize?: ComputerUseSize;
  capture?: {
    backend?: string;
    scaleFactor?: number;
  };
};

export type ComputerUseFrameArtifactRef = {
  artifactId: string;
  previewUrl?: string;
  width?: number;
  height?: number;
  capturedAt?: string;
};

export type ComputerUseAxNode = {
  id: string;
  path?: number[];
  role: string;
  subrole?: string;
  axIdentifier?: string;
  label?: string;
  value?: string;
  description?: string;
  help?: string;
  url?: string;
  rect?: ComputerUseRect;
  enabled?: boolean;
  focused?: boolean;
  selected?: boolean;
  expanded?: boolean;
  editable?: boolean;
  actions?: string[];
  rolePath?: string[];
  labelPath?: string[];
  children?: ComputerUseAxNode[];
};

export type ComputerUseAxSnapshot = {
  supported: boolean;
  targetKind?: ComputerUseTargetKind;
  targetId?: string;
  observationId?: string;
  bundleId?: string;
  displayId?: string;
  permissionState?: OpenString<ComputerUsePermissionState>;
  windowId?: string;
  appName?: string;
  windowTitle?: string;
  targetMatched?: boolean;
  nodeCount?: number;
  truncated?: boolean;
  selectedText?: string;
  nodes: ComputerUseAxNode[];
  message?: string;
  target?: ComputerUseTargetBinding;
  diagnostics?: ComputerUseDiagnostics;
};

export type ComputerUseOcrRegion = {
  id: string;
  text: string;
  confidence?: number;
  rect: ComputerUseRect;
};

export type ComputerUseOcrSnapshot = {
  supported: boolean;
  targetKind?: ComputerUseTargetKind;
  targetId?: string;
  observationId?: string;
  engine?: string;
  appName?: string;
  bundleId?: string;
  windowId?: string;
  windowTitle?: string;
  displayId?: string;
  regionCount?: number;
  truncated?: boolean;
  fullText?: string;
  regions: ComputerUseOcrRegion[];
  message?: string;
  target?: ComputerUseTargetBinding;
  diagnostics?: ComputerUseDiagnostics;
};

export type ComputerUseCdpViewport = {
  innerWidth?: number;
  innerHeight?: number;
  outerWidth?: number;
  outerHeight?: number;
  screenX?: number;
  screenY?: number;
  scrollX?: number;
  scrollY?: number;
  devicePixelRatio?: number;
};

export type ComputerUseCdpNode = {
  id: string;
  role: string;
  label: string;
  selectorPath?: string;
  tagName?: string;
  inputType?: string;
  text?: string;
  href?: string;
  rect?: ComputerUseRect;
  cssRect?: ComputerUseRect;
  coordinateMapping?: string;
  enabled?: boolean;
  editable?: boolean;
  actionCapabilities?: string[];
};

export type ComputerUseCdpSnapshot = {
  supported: boolean;
  targetKind?: ComputerUseTargetKind;
  targetId?: string;
  observationId?: string;
  appName?: string;
  bundleId?: string;
  windowId?: string;
  windowTitle?: string;
  engine?: string;
  endpointId?: string;
  browser?: string;
  protocolVersion?: string;
  pageId?: string;
  pageTitle?: string;
  pageUrl?: string;
  viewport?: ComputerUseCdpViewport;
  nodeCount?: number;
  truncated?: boolean;
  coordinateMapping?: string;
  nodes: ComputerUseCdpNode[];
  message?: string;
  target?: ComputerUseTargetBinding;
  diagnostics?: ComputerUseDiagnostics;
};

export type ComputerUseCandidate = {
  id: string;
  ref?: string;
  sourceId?: string;
  stableKey?: string;
  selector?: {
    targetId?: string;
    source?: OpenString<"ax" | "cdp" | "ocr" | "vision" | "merged">;
    role?: string;
    label?: string;
    sourceId?: string;
    axIdentifier?: string;
    axPath?: string;
    rolePath?: string[];
    labelPath?: string[];
    rectSignature?: string;
  };
  axIdentifier?: string;
  axPath?: string;
  rolePath?: string[];
  labelPath?: string[];
  label?: string;
  role?: string;
  source?: "ax" | "cdp" | "ocr" | "vision" | "merged";
  confidence?: number;
  rect?: ComputerUseRect;
  actionCapabilities?: Array<
    OpenString<"press" | "click" | "setText" | "scroll" | "drag" | "hover" | "select">
  >;
};

export type ComputerUseSelectedTarget = {
  candidateId?: string;
  elementRef?: string;
  selector?: ComputerUseCandidate["selector"];
  point?: ComputerUsePoint;
  rect?: ComputerUseRect;
};

export type ComputerUseActionResult = {
  type: ComputerUseAction;
  status?: "pending" | "success" | "failed";
  targetId?: string;
  point?: ComputerUsePoint;
  rect?: ComputerUseRect;
  hotkey?: string;
  textPreview?: string;
  waitMs?: number;
  inputBackend?: string;
  semanticPath?: string;
  selectorAttempted?: boolean;
  selectorMatched?: boolean;
  fallbackReason?: string;
  cursorRestored?: boolean;
  focusLocked?: boolean;
};

export type ComputerUseCaptureDiagnostics = {
  backend?: string;
  scopeType?: OpenString<"window" | "display" | "desktop">;
  targetKind?: ComputerUseTargetKind;
  targetId?: string;
  observationId?: string;
  appName?: string;
  bundleId?: string;
  windowId?: string;
  windowTitle?: string;
  displayId?: string;
  displayIds?: string[];
  globalRect?: ComputerUseRect;
  frameSize?: ComputerUseSize;
  logicalSize?: ComputerUseSize;
  scaleFactor?: number;
  overlayWasVisibleBeforeCapture?: boolean;
  overlayHiddenBeforeCapture?: boolean;
  overlayHideSettledMs?: number;
  overlayPayloadId?: string;
  contaminationCheck?: {
    status: OpenString<"clean" | "suspected" | "retry-clean" | "retry-suspected" | "skipped">;
    attempts: number;
    reason?: string;
  };
  capturedAt?: string;
};

export type ComputerUseActionDiagnostics = {
  scopeType?: OpenString<"window" | "display" | "desktop">;
  targetKind?: ComputerUseTargetKind;
  targetId?: string;
  observationId?: string;
  mappingSource?: string;
  interactionMode?: string;
  inputBackend?: string;
  semanticPath?: string;
  selectorAttempted?: boolean;
  selectorMatched?: boolean;
  fallbackReason?: string;
  focusLocked?: boolean;
  cursorRestored?: boolean;
  frameSize?: ComputerUseSize;
  relativePoint?: ComputerUsePoint;
  relativeFromPoint?: ComputerUsePoint;
  relativeToPoint?: ComputerUsePoint;
  absolutePoint?: ComputerUsePoint;
  absoluteFromPoint?: ComputerUsePoint;
  absoluteToPoint?: ComputerUsePoint;
  deltaX?: number;
  deltaY?: number;
  observationAgeMs?: number;
  executedAt?: string;
};

export type ComputerUseDiagnostics = {
  capture?: ComputerUseCaptureDiagnostics;
  postActionCapture?: ComputerUseCaptureDiagnostics;
  action?: ComputerUseActionDiagnostics;
};

export type ComputerUseObservation = {
  targetId?: string;
  targetKind?: ComputerUseTargetKind;
  appName?: string;
  bundleId?: string;
  windowId?: string;
  windowTitle?: string;
  displayId?: string;
  observationId?: string;
};

export type ComputerUseWindowTarget = {
  targetId?: string;
  kind?: "window";
  windowId: string;
  appName: string;
  bundleId?: string;
  processId?: number;
  windowTitle?: string;
  monitorId?: string;
  isFocused?: boolean;
  isMinimized?: boolean;
  isMaximized?: boolean;
  rect?: ComputerUseRect;
};

export type ComputerUseAppTarget = {
  targetId?: string;
  kind?: "app";
  appName: string;
  bundleId?: string;
  processId: number;
  isFrontmost?: boolean;
  isHidden?: boolean;
  activationPolicy?: string;
  visibleWindowCount?: number;
  visibleWindowIds?: string[];
};

export type ComputerUseDisplayTarget = {
  targetId?: string;
  kind?: "display";
  displayId: string;
  name?: string;
  isPrimary?: boolean;
  isBuiltin?: boolean;
  rect?: ComputerUseRect;
  scaleFactor?: number;
};

export type ComputerUseCdpPage = {
  pageId: string;
  pageType?: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
};

export type ComputerUseCdpEndpoint = {
  endpointId: string;
  kind?: "cdp";
  host: string;
  port: number;
  browser?: string;
  protocolVersion?: string;
  webSocketDebuggerUrl?: string;
  pageCount?: number;
  pages?: ComputerUseCdpPage[];
  discoveredAt?: string;
};

export type ComputerUseTargetCatalog = {
  generatedAt?: string;
  desktopTargetId?: string;
  displays?: ComputerUseDisplayTarget[];
  windows: ComputerUseWindowTarget[];
  apps: ComputerUseAppTarget[];
  cdpEndpoints?: ComputerUseCdpEndpoint[];
};

export type ComputerUseStructuredPayload = {
  kind: "computer_use/v1";
  status?: "ok" | "approval-pending" | "error";
  stage: ComputerUseStage;
  summary?: string;
  frame?: ComputerUseFrameArtifactRef;
  axSnapshot?: ComputerUseAxSnapshot;
  ocrSnapshot?: ComputerUseOcrSnapshot;
  cdpSnapshot?: ComputerUseCdpSnapshot;
  candidates?: ComputerUseCandidate[];
  selected?: ComputerUseSelectedTarget;
  action?: ComputerUseActionResult;
  observation?: ComputerUseObservation;
  target?: ComputerUseTargetBinding;
  targets?: ComputerUseTargetCatalog;
  diagnostics?: ComputerUseDiagnostics;
  postActionFrame?: ComputerUseFrameArtifactRef;
  confidence?: number;
  approvalKind?: "exec" | "plugin";
  approvalId?: string;
  approvalSlug?: string;
  allowedDecisions?: ("allow-once" | "allow-always" | "deny")[];
  title?: string;
  description?: string;
  severity?: "info" | "warning" | "critical";
  expiresAtMs?: number;
  warning?: string;
  error?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeStringEnum<T extends readonly string[]>(
  value: unknown,
  allowed: T,
): T[number] | undefined {
  const normalized = normalizeOptionalString(typeof value === "string" ? value : undefined);
  if (!normalized) {
    return undefined;
  }
  return allowed.includes(normalized) ? (normalized as T[number]) : undefined;
}

function hasRecognizedSessionConfigKey(value: Record<string, unknown>): boolean {
  return ["enabled", "mode", "scope", "hostPolicy", "modelPolicy", "approvals"].some(
    (key) => key in value,
  );
}

export function normalizeComputerUseSessionConfig(
  value: unknown,
): ComputerUseSessionConfig | undefined {
  if (!isRecord(value) || !hasRecognizedSessionConfigKey(value)) {
    return undefined;
  }

  const scopeInput = isRecord(value.scope) ? value.scope : {};
  const modelPolicyInput = isRecord(value.modelPolicy) ? value.modelPolicy : {};
  const approvalsInput = isRecord(value.approvals) ? value.approvals : {};

  const scopeType =
    normalizeStringEnum(scopeInput.type, COMPUTER_USE_SCOPE_TYPES) ??
    DEFAULT_COMPUTER_USE_SESSION_CONFIG.scope.type;
  const scope: ComputerUseScope = { type: scopeType };
  if (scopeType === "window") {
    scope.windowId = normalizeOptionalString(
      typeof scopeInput.windowId === "string" ? scopeInput.windowId : undefined,
    );
  }
  if (scopeType === "display") {
    scope.displayId = normalizeOptionalString(
      typeof scopeInput.displayId === "string" ? scopeInput.displayId : undefined,
    );
  }

  return {
    enabled:
      typeof value.enabled === "boolean"
        ? value.enabled
        : DEFAULT_COMPUTER_USE_SESSION_CONFIG.enabled,
    mode:
      normalizeStringEnum(value.mode, COMPUTER_USE_MODES) ??
      DEFAULT_COMPUTER_USE_SESSION_CONFIG.mode,
    scope,
    hostPolicy:
      normalizeStringEnum(value.hostPolicy, COMPUTER_USE_HOST_POLICIES) ??
      DEFAULT_COMPUTER_USE_SESSION_CONFIG.hostPolicy,
    modelPolicy: {
      mode:
        normalizeStringEnum(modelPolicyInput.mode, COMPUTER_USE_MODEL_POLICY_MODES) ??
        DEFAULT_COMPUTER_USE_SESSION_CONFIG.modelPolicy.mode,
      ...(normalizeOptionalString(
        typeof modelPolicyInput.executorModel === "string"
          ? modelPolicyInput.executorModel
          : undefined,
      )
        ? {
            executorModel: normalizeOptionalString(
              typeof modelPolicyInput.executorModel === "string"
                ? modelPolicyInput.executorModel
                : undefined,
            ),
          }
        : {}),
    },
    approvals: {
      highRiskActionsRequireConfirm:
        typeof approvalsInput.highRiskActionsRequireConfirm === "boolean"
          ? approvalsInput.highRiskActionsRequireConfirm
          : DEFAULT_COMPUTER_USE_SESSION_CONFIG.approvals.highRiskActionsRequireConfirm,
    },
  };
}

export function cloneComputerUseSessionConfig(
  value: ComputerUseSessionConfig | null | undefined,
): ComputerUseSessionConfig | undefined {
  return normalizeComputerUseSessionConfig(value);
}

export function hasEnabledComputerUse(value: unknown): boolean {
  return normalizeComputerUseSessionConfig(value)?.enabled === true;
}

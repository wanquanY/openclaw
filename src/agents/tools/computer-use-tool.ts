import crypto from "node:crypto";
import fs from "node:fs/promises";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ComputerUseSessionConfig } from "../../computer-use/types.js";
import {
  type ComputerUseAction,
  type ComputerUseActionResult,
  type ComputerUseCandidate,
  type ComputerUseAxSnapshot,
  type ComputerUseCdpSnapshot,
  type ComputerUseOcrSnapshot,
  type ComputerUseFrameArtifactRef,
  type ComputerUseObservation,
  type ComputerUsePoint,
  type ComputerUseScope,
  type ComputerUseSelectedTarget,
  type ComputerUseStructuredPayload,
  type ComputerUseTargetBinding,
  type ComputerUseTargetCatalog,
} from "../../computer-use/types.js";
import { normalizeComputerUseSessionConfig } from "../../computer-use/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { resolveImageSanitizationLimits } from "../image-sanitization.js";
import { sanitizeToolResultImages } from "../tool-images.js";
import { type AnyAgentTool, readNumberParam, readStringParam, textResult } from "./common.js";
import {
  actionCanLeaseFocusedSurface,
  actionShouldObserveFocusedSurfaceByDefault,
  buildPreActionFocusPayload,
  mergePreActionFocusResultIntoActionArgs,
} from "./computer-use/action-target-policy.js";
import {
  COMPUTER_USE_ALLOWED_APPROVAL_DECISIONS,
  COMPUTER_USE_APPROVAL_PLUGIN_ID,
  buildApprovalSlug,
  buildHighRiskApprovalFingerprint,
  buildHighRiskApprovalMetadata,
  isHighRiskComputerUseAction,
  isTrustedHighRiskComputerUseFingerprint,
  rememberTrustedHighRiskComputerUseFingerprint,
  type ComputerUseApprovalOutcome,
} from "./computer-use/approval-policy.js";
import {
  buildActionCommandTarget,
  buildAxSnapshot,
  buildCdpSnapshot,
  buildCurrentWindowTargetRequest,
  buildFrameRef,
  buildObservation,
  buildOcrSnapshot,
  buildResolvedObservationTarget,
  buildTargetBindingFromGatewayPayload,
  mergeDiagnostics,
  type ComputerUseCaptureTargetRequest,
} from "./computer-use/gateway-normalizers.js";
import type {
  GatewayComputerActionPayload,
  GatewayComputerAxPayload,
  GatewayComputerCapturePayload,
  GatewayComputerCdpPayload,
  GatewayComputerOcrPayload,
  GatewayComputerStatusPayload,
  GatewayPluginApprovalRequestPayload,
  GatewayPluginApprovalWaitPayload,
} from "./computer-use/gateway-payloads.js";
import {
  actionNeedsGroundedElementPoint,
  availableElementRefs,
  buildActionPayloadPoint,
  buildCandidateProposals,
  buildModelFacingSummary,
  buildPendingActionPayload,
  candidateMatchesRememberedSelector,
  countAxNodes,
  describePreparedFocusTarget,
  findCandidateByRef,
  findCandidateByRememberedSelector,
  focusTargetMatchesExpectation,
  lookupRememberedComputerUseCandidate,
  mergeComputerUseWarnings,
  readElementRef,
  rememberComputerUseCandidates,
  resolveSelectedTarget,
  selectedTargetFromCandidate,
  type PreparedComputerUseFocusTarget,
} from "./computer-use/perception.js";
import { ComputerUseToolSchema } from "./computer-use/schema.js";
import {
  discoverComputerUseTargets,
  prepareFocusWindowTarget,
} from "./computer-use/target-discovery.js";
import { callGatewayTool } from "./gateway.js";

export { clearComputerUseCandidateMemoryForTesting } from "./computer-use/perception.js";

const log = createSubsystemLogger("agents/tools/computer-use");
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readOptionalPoint(
  params: Record<string, unknown>,
  prefix: "" | "from" | "to" = "",
): ComputerUsePoint | undefined {
  const xKey = prefix ? `${prefix}X` : "x";
  const yKey = prefix ? `${prefix}Y` : "y";
  const x = readNumberParam(params, xKey);
  const y = readNumberParam(params, yKey);
  if (typeof x !== "number" || typeof y !== "number") {
    return undefined;
  }
  return { x, y };
}

function sameComputerUsePoint(
  left: ComputerUsePoint | undefined,
  right: ComputerUsePoint | undefined,
): boolean {
  return (
    typeof left?.x === "number" &&
    typeof left?.y === "number" &&
    typeof right?.x === "number" &&
    typeof right?.y === "number" &&
    Math.abs(left.x - right.x) < 0.001 &&
    Math.abs(left.y - right.y) < 0.001
  );
}

function buildScope(sessionConfig: ComputerUseSessionConfig): ComputerUseScope {
  return {
    type: sessionConfig.scope.type,
    ...(sessionConfig.scope.windowId ? { windowId: sessionConfig.scope.windowId } : {}),
    ...(sessionConfig.scope.displayId ? { displayId: sessionConfig.scope.displayId } : {}),
  };
}

async function invokeComputerClientCommand<TPayload>(params: {
  sessionKey?: string;
  command: string;
  payload?: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<TPayload> {
  const raw = await callGatewayTool(
    "client.invoke",
    {},
    {
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      capability: "computer_use",
      command: params.command,
      params: params.payload ?? {},
      timeoutMs: params.timeoutMs,
      idempotencyKey: crypto.randomUUID(),
    },
  );
  return (raw?.payload ?? {}) as TPayload;
}

function tokenizeComputerUseHotkey(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter(Boolean);
}

function isApplicationSwitcherHotkey(value: string | undefined): boolean {
  const hotkey = normalizeOptionalString(value);
  if (!hotkey) {
    return false;
  }
  const tokens = tokenizeComputerUseHotkey(hotkey);
  if (!tokens.includes("tab")) {
    return false;
  }
  if (tokens.includes("ctrl") || tokens.includes("control")) {
    return false;
  }
  return tokens.some(
    (token) =>
      token === "cmd" ||
      token === "command" ||
      token === "meta" ||
      token === "super" ||
      token === "win" ||
      token === "windows" ||
      token === "alt" ||
      token === "option",
  );
}

type PreparedComputerUseActionIntent =
  | {
      ok: true;
      action: ComputerUseAction;
      args: Record<string, unknown>;
      warning?: string;
    }
  | {
      ok: false;
      summary: string;
      error: string;
      warning?: string;
    };

function prepareComputerUseActionIntent(params: {
  action: ComputerUseAction;
  args: Record<string, unknown>;
}): PreparedComputerUseActionIntent {
  const text = readStringParam(params.args, "text", { trim: false });
  if (params.action === "click" && typeof text === "string" && text.length > 0) {
    return {
      ok: true,
      action: "type",
      args: {
        ...params.args,
        action: "type",
      },
      warning:
        "Rewrote click with text into a single type action. Prefer action=type with text and elementRef for text entry.",
    };
  }
  if (
    params.action === "hotkey" &&
    ["enter", "return"].includes(
      normalizeOptionalString(readStringParam(params.args, "hotkey"))?.toLowerCase() ?? "",
    ) &&
    typeof text === "string" &&
    text.length > 0
  ) {
    return {
      ok: true,
      action: "set_text_submit",
      args: {
        ...params.args,
        action: "set_text_submit",
      },
      warning:
        "Rewrote text entry followed by Enter into set_text_submit. Prefer action=set_text_submit with text and elementRef for search/open flows.",
    };
  }
  if (params.action !== "hotkey") {
    return {
      ok: true,
      action: params.action,
      args: params.args,
    };
  }
  const hotkey = normalizeOptionalString(readStringParam(params.args, "hotkey"));
  if (!isApplicationSwitcherHotkey(hotkey)) {
    return {
      ok: true,
      action: params.action,
      args: params.args,
    };
  }

  const appName = normalizeOptionalString(readStringParam(params.args, "appName"));
  const bundleId = normalizeOptionalString(readStringParam(params.args, "bundleId"));
  const windowId = normalizeOptionalString(readStringParam(params.args, "windowId"));
  if (!appName && !bundleId && !windowId) {
    return {
      ok: false,
      summary: "Application-switching hotkey blocked; use focus_window with an explicit target.",
      error:
        "Application-switching hotkeys are not allowed without an explicit target. Retry with action=focus_window and provide appName, bundleId, or windowId.",
      warning:
        "Prefer focus_window with appName, bundleId, or windowId instead of application-switcher hotkeys such as cmd+tab.",
    };
  }

  const rewrittenArgs: Record<string, unknown> = {
    ...params.args,
    ...(appName ? { appName } : {}),
    ...(bundleId ? { bundleId } : {}),
    ...(windowId ? { windowId } : {}),
  };
  delete rewrittenArgs.hotkey;
  return {
    ok: true,
    action: "focus_window",
    args: rewrittenArgs,
    warning:
      "Rewrote an application-switching hotkey into focus_window. Prefer focus_window with appName, bundleId, or windowId for app switching.",
  };
}

function actionShouldVerifyFrontmostSurface(params: {
  action: ComputerUseAction;
  target?: ComputerUseTargetBinding;
  observation?: ComputerUseObservation;
}): boolean {
  const actionMayOpenTransientSurface =
    params.action === "click" ||
    params.action === "double_click" ||
    params.action === "right_click" ||
    params.action === "type" ||
    params.action === "hotkey";
  if (!actionMayOpenTransientSurface) {
    return false;
  }
  return params.target?.kind === "window" || params.observation?.targetKind === "window";
}

type ComputerUseClientError = {
  code?: string;
  message?: string;
};

function readComputerUseClientError(error: unknown): ComputerUseClientError | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  const details =
    typeof (error as { details?: unknown }).details === "object" &&
    (error as { details?: unknown }).details &&
    !Array.isArray((error as { details?: unknown }).details)
      ? ((error as { details?: Record<string, unknown> }).details ?? undefined)
      : undefined;
  const detailCode =
    typeof details?.code === "string" && details.code.trim().length > 0 ? details.code : undefined;
  const detailMessage =
    typeof details?.message === "string" && details.message.trim().length > 0
      ? details.message
      : undefined;
  const rawGatewayCode =
    typeof (error as { gatewayCode?: unknown }).gatewayCode === "string"
      ? (error as { gatewayCode?: string }).gatewayCode
      : undefined;
  const gatewayCode =
    rawGatewayCode && rawGatewayCode.trim().length > 0 ? rawGatewayCode : undefined;
  if (!detailCode && !detailMessage && !gatewayCode) {
    return undefined;
  }
  return {
    code: detailCode ?? gatewayCode,
    message: detailMessage ?? error.message,
  };
}

async function createImageContentBlock(
  payload: GatewayComputerCapturePayload | undefined,
): Promise<Extract<AgentToolResult<unknown>["content"][number], { type: "image" }> | undefined> {
  let base64 = normalizeOptionalString(payload?.base64Png);
  const framePath = normalizeOptionalString(payload?.framePath);
  if (!base64 && framePath) {
    const bytes = await fs.readFile(framePath);
    base64 = bytes.toString("base64");
  }
  if (!base64) {
    return undefined;
  }
  return {
    type: "image",
    data: base64,
    mimeType: normalizeOptionalString(payload?.mimeType) ?? "image/png",
  };
}

async function createComputerUseToolResult(params: {
  label: string;
  payload: ComputerUseStructuredPayload;
  summary: string;
  primaryCapture?: GatewayComputerCapturePayload;
  secondaryCapture?: GatewayComputerCapturePayload;
  imageSanitization?: ReturnType<typeof resolveImageSanitizationLimits>;
}): Promise<AgentToolResult<ComputerUseStructuredPayload>> {
  const content: AgentToolResult<ComputerUseStructuredPayload>["content"] = [
    { type: "text", text: params.summary },
  ];
  const primaryImage = await createImageContentBlock(params.primaryCapture);
  if (primaryImage) {
    content.push({ type: "text", text: "Primary screen capture:" });
    content.push(primaryImage);
  }
  const secondaryImage = await createImageContentBlock(params.secondaryCapture);
  if (secondaryImage) {
    content.push({ type: "text", text: "Post-action verification capture:" });
    content.push(secondaryImage);
  }
  return (await sanitizeToolResultImages(
    {
      content,
      details: params.payload,
    },
    params.label,
    params.imageSanitization ?? {},
  )) as AgentToolResult<ComputerUseStructuredPayload>;
}

function withComputerUseInvocationMetadata(
  payload: ComputerUseStructuredPayload,
  sessionConfig: ComputerUseSessionConfig | undefined,
): ComputerUseStructuredPayload {
  if (!sessionConfig) return payload;
  return {
    ...payload,
    activation: payload.activation ?? sessionConfig.activation,
    ...((payload.source ?? sessionConfig.source)
      ? { source: payload.source ?? sessionConfig.source }
      : {}),
  };
}

function summarizeAction(
  action: ComputerUseAction,
  status: "pending" | "success" | "error",
): string {
  const prefix = status === "pending" ? "Running" : status === "success" ? "Completed" : "Failed";
  switch (action) {
    case "observe":
      return `${prefix} screen observation`;
    case "discover_targets":
      return `${prefix} desktop target discovery`;
    case "focus_window":
      return `${prefix} focus window`;
    case "launch_app":
      return `${prefix} launch app`;
    case "click":
      return `${prefix} click`;
    case "double_click":
      return `${prefix} double click`;
    case "right_click":
      return `${prefix} right click`;
    case "move":
      return `${prefix} pointer move`;
    case "drag":
      return `${prefix} drag`;
    case "scroll":
      return `${prefix} scroll`;
    case "type":
      return `${prefix} type`;
    case "set_text_submit":
      return `${prefix} set text and submit`;
    case "hotkey":
      return `${prefix} hotkey`;
    case "wait":
      return `${prefix} wait`;
  }
  return `${prefix} action`;
}

async function createComputerUseFailedResult(params: {
  action: ComputerUseAction;
  args: Record<string, unknown>;
  summary: string;
  error: string;
  capturePayload?: GatewayComputerCapturePayload;
  postActionCapture?: GatewayComputerCapturePayload;
  actionPayload?: GatewayComputerActionPayload;
  frame?: ComputerUseFrameArtifactRef;
  axSnapshot?: ComputerUseAxSnapshot;
  cdpSnapshot?: ComputerUseCdpSnapshot;
  ocrSnapshot?: ComputerUseOcrSnapshot;
  candidates?: ComputerUseCandidate[];
  selected?: ComputerUseSelectedTarget;
  observation?: ComputerUseObservation;
  target?: ComputerUseTargetBinding;
  targets?: ComputerUseTargetCatalog;
  warning?: string;
  imageSanitization?: ReturnType<typeof resolveImageSanitizationLimits>;
  sessionConfig?: ComputerUseSessionConfig;
}) {
  const target =
    params.target ??
    buildTargetBindingFromGatewayPayload(params.postActionCapture) ??
    buildTargetBindingFromGatewayPayload(params.capturePayload);
  const diagnostics = mergeDiagnostics({
    capture: params.capturePayload,
    postActionCapture: params.postActionCapture,
    action: params.actionPayload,
  });
  const payload: ComputerUseStructuredPayload = {
    kind: "computer_use/v1",
    status: "error",
    stage: "error",
    summary: params.summary,
    ...(params.frame ? { frame: params.frame } : {}),
    ...(params.axSnapshot ? { axSnapshot: params.axSnapshot } : {}),
    ...(params.cdpSnapshot ? { cdpSnapshot: params.cdpSnapshot } : {}),
    ...(params.ocrSnapshot ? { ocrSnapshot: params.ocrSnapshot } : {}),
    ...(params.candidates?.length ? { candidates: params.candidates } : {}),
    ...(params.selected ? { selected: params.selected } : {}),
    action: buildActionResult(params.action, params.args, "failed"),
    ...(params.observation ? { observation: params.observation } : {}),
    ...(target ? { target } : {}),
    ...(params.targets ? { targets: params.targets } : {}),
    ...(diagnostics ? { diagnostics } : {}),
    ...(params.warning ? { warning: params.warning } : {}),
    error: params.error,
  };
  return await createComputerUseToolResult({
    label: "computer_use:error",
    payload: withComputerUseInvocationMetadata(payload, params.sessionConfig),
    summary: buildModelFacingSummary({
      summary: params.summary,
      observation: params.observation,
      target,
      targets: params.targets,
      diagnostics,
      axSnapshot: params.axSnapshot,
      cdpSnapshot: params.cdpSnapshot,
      ocrSnapshot: params.ocrSnapshot,
      candidates: params.candidates,
      warning: params.warning,
      error: params.error,
    }),
    primaryCapture: params.capturePayload,
    secondaryCapture: params.postActionCapture,
    imageSanitization: params.imageSanitization,
  });
}

async function waitForPluginApprovalDecision(params: {
  approvalId: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<GatewayPluginApprovalWaitPayload> {
  const waitPromise: Promise<GatewayPluginApprovalWaitPayload> = callGatewayTool(
    "plugin.approval.waitDecision",
    { timeoutMs: params.timeoutMs + 10_000 },
    { id: params.approvalId },
  );
  if (!params.signal) {
    return await waitPromise;
  }
  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    if (params.signal?.aborted) {
      reject(params.signal.reason);
      return;
    }
    onAbort = () => reject(params.signal?.reason);
    params.signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([waitPromise, abortPromise]);
  } finally {
    if (onAbort) {
      params.signal.removeEventListener("abort", onAbort);
    }
  }
}

async function requestComputerUseApproval(params: {
  action: ComputerUseAction;
  args: Record<string, unknown>;
  scope: ComputerUseScope;
  observation?: ComputerUseObservation;
  sessionKey?: string;
  agentId?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onUpdate?: Parameters<AnyAgentTool["execute"]>[3];
  toolCallId: string;
  frame?: ComputerUseFrameArtifactRef;
  selected?: ComputerUseSelectedTarget;
  target?: ComputerUseTargetBinding;
  sessionConfig?: ComputerUseSessionConfig;
}): Promise<ComputerUseApprovalOutcome> {
  const metadata = buildHighRiskApprovalMetadata({
    action: params.action,
    args: params.args,
    scope: params.scope,
    observation: params.observation,
  });
  const timeoutMs = Math.max(1, params.timeoutMs ?? 120_000);
  let requestResult: GatewayPluginApprovalRequestPayload;
  try {
    requestResult = await callGatewayTool(
      "plugin.approval.request",
      { timeoutMs: timeoutMs + 10_000 },
      {
        pluginId: COMPUTER_USE_APPROVAL_PLUGIN_ID,
        title: metadata.title,
        description: metadata.description,
        severity: metadata.severity,
        toolName: "computer_use",
        toolCallId: params.toolCallId,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        timeoutMs,
        twoPhase: true,
      },
      { expectFinal: false },
    );
  } catch {
    return { decision: "unavailable" };
  }

  const approvalId = normalizeOptionalString(requestResult?.id);
  const expiresAtMs =
    typeof requestResult?.expiresAtMs === "number" ? requestResult.expiresAtMs : undefined;
  if (!approvalId) {
    return { decision: "unavailable" };
  }

  emitUpdate(
    params.onUpdate,
    {
      kind: "computer_use/v1",
      status: "approval-pending",
      stage: "acting",
      summary: `Waiting for approval to ${params.action.replace(/_/g, " ")}`,
      ...(params.frame ? { frame: params.frame } : {}),
      ...(params.selected ? { selected: params.selected } : {}),
      action: buildActionResult(params.action, params.args, "pending"),
      ...(params.observation ? { observation: params.observation } : {}),
      ...(params.target ? { target: params.target } : {}),
      approvalKind: "plugin",
      approvalId,
      approvalSlug: buildApprovalSlug(approvalId),
      allowedDecisions: [...COMPUTER_USE_ALLOWED_APPROVAL_DECISIONS],
      title: metadata.title,
      description: metadata.description,
      severity: metadata.severity,
      ...(expiresAtMs !== undefined ? { expiresAtMs } : {}),
      warning: "High-risk desktop action requires approval.",
    },
    params.sessionConfig,
  );

  const immediateDecision =
    typeof requestResult?.decision === "string" || requestResult?.decision === null
      ? requestResult.decision
      : undefined;
  let decision = immediateDecision;
  if (decision === undefined) {
    try {
      const waitResult = await waitForPluginApprovalDecision({
        approvalId,
        timeoutMs,
        signal: params.signal,
      });
      decision = waitResult?.decision;
    } catch {
      return {
        decision: "cancelled",
        approvalId,
        approvalSlug: buildApprovalSlug(approvalId),
        expiresAtMs,
      };
    }
  }

  if (decision === "allow-once" || decision === "allow-always" || decision === "deny") {
    if (decision === "allow-always") {
      rememberTrustedHighRiskComputerUseFingerprint(params.sessionKey, metadata.fingerprint);
    }
    return {
      decision,
      approvalId,
      approvalSlug: buildApprovalSlug(approvalId),
      expiresAtMs,
    };
  }
  if (decision === null) {
    return {
      decision: "unavailable",
      approvalId,
      approvalSlug: buildApprovalSlug(approvalId),
      expiresAtMs,
    };
  }
  return {
    decision: "timeout",
    approvalId,
    approvalSlug: buildApprovalSlug(approvalId),
    expiresAtMs,
  };
}

function buildActionResult(
  action: ComputerUseAction,
  args: Record<string, unknown>,
  status: "pending" | "success" | "failed",
  nodePayload?: GatewayComputerActionPayload,
): ComputerUseActionResult {
  const point = readOptionalPoint(args);
  const actionPoint =
    isRecord(nodePayload?.point) &&
    typeof nodePayload?.point?.x === "number" &&
    typeof nodePayload?.point?.y === "number"
      ? { x: nodePayload.point.x, y: nodePayload.point.y }
      : point;
  const targetId =
    normalizeOptionalString(nodePayload?.targetId) ??
    normalizeOptionalString(readStringParam(args, "targetId"));
  return {
    type: action,
    status,
    ...(targetId ? { targetId } : {}),
    ...(actionPoint ? { point: actionPoint } : {}),
    ...(normalizeOptionalString(nodePayload?.inputBackend)
      ? { inputBackend: normalizeOptionalString(nodePayload?.inputBackend) }
      : {}),
    ...(normalizeOptionalString(nodePayload?.semanticPath)
      ? { semanticPath: normalizeOptionalString(nodePayload?.semanticPath) }
      : {}),
    ...(typeof nodePayload?.selectorAttempted === "boolean"
      ? { selectorAttempted: nodePayload.selectorAttempted }
      : {}),
    ...(typeof nodePayload?.selectorMatched === "boolean"
      ? { selectorMatched: nodePayload.selectorMatched }
      : {}),
    ...(normalizeOptionalString(nodePayload?.fallbackReason)
      ? { fallbackReason: normalizeOptionalString(nodePayload?.fallbackReason) }
      : {}),
    ...(typeof nodePayload?.cursorRestored === "boolean"
      ? { cursorRestored: nodePayload.cursorRestored }
      : {}),
    ...(typeof nodePayload?.focusLocked === "boolean"
      ? { focusLocked: nodePayload.focusLocked }
      : {}),
    ...(normalizeOptionalString(readStringParam(args, "hotkey"))
      ? { hotkey: readStringParam(args, "hotkey") }
      : {}),
    ...(typeof readNumberParam(args, "waitMs") === "number"
      ? { waitMs: readNumberParam(args, "waitMs") }
      : {}),
    ...(normalizeOptionalString(readStringParam(args, "text"))
      ? { textPreview: readStringParam(args, "text")?.slice(0, 120) }
      : {}),
  };
}

function emitUpdate(
  onUpdate: Parameters<AnyAgentTool["execute"]>[3],
  payload: ComputerUseStructuredPayload,
  sessionConfig?: ComputerUseSessionConfig,
): void {
  if (!onUpdate) {
    return;
  }
  const decoratedPayload = withComputerUseInvocationMetadata(payload, sessionConfig);
  onUpdate(textResult(decoratedPayload.summary ?? "computer_use update", decoratedPayload));
}

function buildAxRequestPayload(params: {
  scope: ComputerUseScope;
  observation?: ComputerUseObservation;
}): Record<string, unknown> {
  return buildResolvedObservationTarget(params);
}

function buildOcrRequestPayload(params: {
  scope: ComputerUseScope;
  observation?: ComputerUseObservation;
  capture?: GatewayComputerCapturePayload;
}): Record<string, unknown> | undefined {
  const base64Png = normalizeOptionalString(params.capture?.base64Png);
  const frameId = normalizeOptionalString(params.capture?.frameId);
  const framePath = normalizeOptionalString(params.capture?.framePath);
  const frameUrl = normalizeOptionalString(params.capture?.frameUrl);
  const target = buildResolvedObservationTarget(params);
  const observationId = normalizeOptionalString(target.observationId);
  if (!base64Png && !framePath && !frameUrl && !observationId) {
    return undefined;
  }
  return {
    ...target,
    ...(observationId ? {} : { base64Png, frameId, framePath, frameUrl }),
    ...(normalizeOptionalString(params.capture?.mimeType)
      ? { mimeType: normalizeOptionalString(params.capture?.mimeType) }
      : {}),
    recognitionLanguages: ["zh-Hans", "en-US"],
    maxRegions: 120,
  };
}

function buildCdpRequestPayload(params: {
  scope: ComputerUseScope;
  observation?: ComputerUseObservation;
}): Record<string, unknown> | undefined {
  const target = buildResolvedObservationTarget(params);
  const targetKind = normalizeOptionalString(params.observation?.targetKind);
  if (
    target.scopeType !== "window" &&
    targetKind !== "window" &&
    !normalizeOptionalString(target.windowId)
  ) {
    return undefined;
  }
  return {
    ...target,
    maxNodes: 120,
  };
}

function readTimeoutMs(args: Record<string, unknown>): number | undefined {
  const value = readNumberParam(args, "timeoutMs", { integer: true });
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function createComputerUseTool(options: {
  sessionConfig: ComputerUseSessionConfig;
  sessionKey?: string;
  agentId?: string;
  config?: OpenClawConfig;
}): AnyAgentTool {
  const activation = normalizeComputerUseSessionConfig(options.sessionConfig)?.activation ?? "auto";
  const activationInstruction =
    activation === "required"
      ? "Activation: required. The user explicitly selected Computer Use for this turn; use this tool to complete the desktop-facing part of the request unless it is impossible or unsafe."
      : "Activation: auto. Use this tool only when operating or inspecting the visible desktop is materially useful for the user's task.";
  return {
    label: "Computer Use",
    name: "computer_use",
    description: `Observe and control the bound local desktop client using screenshots and GUI actions. ${activationInstruction} For entering text, call action=type with text and elementRef/x/y in one tool call; do not click a field and observe again before typing. The host uses semantic UI/AX actions first, keeps the target window leased for control actions, and falls back to real input events only when necessary.`,
    parameters: ComputerUseToolSchema,
    execute: async (toolCallId, rawArgs, signal, onUpdate) => {
      const args = isRecord(rawArgs) ? rawArgs : {};
      const sessionConfig =
        normalizeComputerUseSessionConfig(options.sessionConfig) ??
        normalizeComputerUseSessionConfig(DEFAULT_TOOL_SESSION_CONFIG) ??
        DEFAULT_TOOL_SESSION_CONFIG;
      const imageSanitization = resolveImageSanitizationLimits(options.config);
      const requestedAction = readStringParam(args, "action", {
        required: true,
      }) as ComputerUseAction;
      const preparedAction = prepareComputerUseActionIntent({
        action: requestedAction,
        args,
      });
      const action = preparedAction.ok ? preparedAction.action : requestedAction;
      let actionArgs = preparedAction.ok ? preparedAction.args : args;
      let actionWarning = preparedAction.warning;
      const timeoutMs = readTimeoutMs(args);
      const scope = buildScope(sessionConfig);
      const status = await invokeComputerClientCommand<GatewayComputerStatusPayload>({
        sessionKey: options.sessionKey,
        command: "computer.status",
        timeoutMs,
      });
      let targetCatalog: ComputerUseTargetCatalog | undefined;
      let focusTarget: PreparedComputerUseFocusTarget | undefined;

      if (requestedAction === "discover_targets") {
        try {
          targetCatalog = await discoverComputerUseTargets({
            invokeClientCommand: invokeComputerClientCommand,
            sessionKey: options.sessionKey,
            timeoutMs,
          });
        } catch (error) {
          return await createComputerUseFailedResult({
            action: requestedAction,
            args,
            summary: "Desktop target discovery failed.",
            error:
              error instanceof Error
                ? error.message
                : "The host failed to enumerate running apps and windows.",
            warning:
              "Retry discover_targets after the desktop host is ready. Use only real device targets for focus_window.",
            imageSanitization,
            sessionConfig,
          });
        }
        const summary =
          targetCatalog && (targetCatalog.windows.length > 0 || targetCatalog.apps.length > 0)
            ? summarizeAction(requestedAction, "success")
            : "No desktop targets are currently discoverable.";
        const warning =
          targetCatalog && (targetCatalog.windows.length > 0 || targetCatalog.apps.length > 0)
            ? undefined
            : "Retry after the target app is running and visible on the desktop.";
        const payload: ComputerUseStructuredPayload = {
          kind: "computer_use/v1",
          status: "ok",
          stage: "completed",
          summary,
          action: buildActionResult(requestedAction, args, "success"),
          ...(targetCatalog ? { targets: targetCatalog } : {}),
          ...(warning ? { warning } : {}),
        };
        return await createComputerUseToolResult({
          label: "computer_use:discover_targets",
          payload: withComputerUseInvocationMetadata(payload, sessionConfig),
          summary: buildModelFacingSummary({
            summary,
            targets: targetCatalog,
            warning,
          }),
          imageSanitization,
        });
      }

      if (action === "focus_window") {
        const preparedFocusTarget = await prepareFocusWindowTarget({
          invokeClientCommand: invokeComputerClientCommand,
          args: actionArgs,
          sessionKey: options.sessionKey,
          timeoutMs,
        });
        targetCatalog = preparedFocusTarget.targets;
        if (!preparedFocusTarget.ok) {
          return await createComputerUseFailedResult({
            action,
            args: actionArgs,
            summary: preparedFocusTarget.summary,
            error: preparedFocusTarget.error,
            targets: preparedFocusTarget.targets,
            warning: mergeComputerUseWarnings(actionWarning, preparedFocusTarget.warning),
            imageSanitization,
            sessionConfig,
          });
        }
        actionArgs = preparedFocusTarget.args;
        focusTarget = preparedFocusTarget.focusTarget;
        actionWarning = mergeComputerUseWarnings(actionWarning, preparedFocusTarget.warning);
      }

      if (status.observeAllowed === false) {
        throw new Error("computer_use observe is unavailable on the bound local desktop client");
      }
      if (action !== "observe" && status.controlAllowed === false) {
        throw new Error(
          "computer_use control actions are unavailable on the bound local desktop client",
        );
      }

      let preActionFocused = false;
      const preActionFocusPayload = buildPreActionFocusPayload({
        action,
        args: actionArgs,
        sessionKey: options.sessionKey,
        agentId: options.agentId,
      });
      if (preActionFocusPayload) {
        try {
          const focusPayload = await invokeComputerClientCommand<GatewayComputerActionPayload>({
            sessionKey: options.sessionKey,
            command: "computer.action",
            payload: preActionFocusPayload,
            timeoutMs,
          });
          actionArgs = mergePreActionFocusResultIntoActionArgs({
            args: actionArgs,
            focusPayload,
          });
          preActionFocused = true;
          actionWarning = mergeComputerUseWarnings(
            actionWarning,
            "Focused the referenced desktop surface before executing the action to refresh the window lease.",
          );
        } catch (error) {
          return await createComputerUseFailedResult({
            action,
            args: actionArgs,
            summary: "Desktop target could not be focused before the action.",
            error:
              error instanceof Error
                ? error.message
                : "The referenced desktop target is no longer available.",
            warning: mergeComputerUseWarnings(
              "Re-run discover_targets or observe the target, then retry with a current elementRef.",
              actionWarning,
            ),
            imageSanitization,
            sessionConfig,
          });
        }
      }

      let capturePayload: GatewayComputerCapturePayload | undefined;
      const shouldCaptureBeforeAction = action !== "focus_window";
      const shouldReadBeforeSemanticSnapshot = action !== "focus_window";
      const shouldReadAfterOcrSnapshot = action !== "focus_window";
      if (shouldCaptureBeforeAction) {
        const explicitTargetId = normalizeOptionalString(readStringParam(actionArgs, "targetId"));
        const explicitWindowId = normalizeOptionalString(readStringParam(actionArgs, "windowId"));
        const explicitDisplayId = normalizeOptionalString(readStringParam(actionArgs, "displayId"));
        const captureTarget = explicitWindowId
          ? {
              scopeType: "window",
              windowId: explicitWindowId,
              ...(explicitTargetId ? { targetId: explicitTargetId } : {}),
            }
          : preActionFocused ||
              (!explicitTargetId &&
                !explicitDisplayId &&
                actionShouldObserveFocusedSurfaceByDefault(action))
            ? buildCurrentWindowTargetRequest()
            : {
                ...buildResolvedObservationTarget({ scope }),
                ...(explicitTargetId ? { targetId: explicitTargetId } : {}),
              };
        capturePayload = await invokeComputerClientCommand<GatewayComputerCapturePayload>({
          sessionKey: options.sessionKey,
          command: "computer.capture",
          payload: captureTarget,
          timeoutMs,
        });
        log.info("computer_use capture completed", {
          sessionKey: options.sessionKey,
          toolCallId,
          action: requestedAction,
          scopeType: scope.type,
          targetKind: capturePayload.targetKind ?? undefined,
          appName: capturePayload.appName ?? undefined,
          hasImage: Boolean(
            normalizeOptionalString(capturePayload.framePath) ??
            normalizeOptionalString(capturePayload.frameUrl) ??
            normalizeOptionalString(capturePayload.base64Png),
          ),
          width: capturePayload.width,
          height: capturePayload.height,
          windowId: capturePayload.windowId ?? undefined,
        });
      } else {
        log.info("computer_use skipped pre-action capture for focus_window fast path", {
          sessionKey: options.sessionKey,
          toolCallId,
          action: requestedAction,
        });
      }

      const beforeFrame =
        capturePayload && action !== "observe"
          ? buildFrameRef(toolCallId, "before", capturePayload)
          : action === "observe"
            ? buildFrameRef(toolCallId, "observe", capturePayload ?? {})
            : undefined;
      const observation = buildObservation(scope, capturePayload);
      const beforeTargetBinding = buildTargetBindingFromGatewayPayload(capturePayload);
      const readAxSnapshot = async (
        phase: "observe" | "before" | "after",
        currentObservation: ComputerUseObservation | undefined,
      ): Promise<ComputerUseAxSnapshot | undefined> => {
        if (status.supportsAx === false) {
          return undefined;
        }
        try {
          const axPayload = await invokeComputerClientCommand<GatewayComputerAxPayload>({
            sessionKey: options.sessionKey,
            command: "computer.ax",
            payload: buildAxRequestPayload({
              scope,
              observation: currentObservation,
            }),
            timeoutMs,
          });
          const axSnapshot = buildAxSnapshot(axPayload);
          log.info("computer_use ax snapshot completed", {
            sessionKey: options.sessionKey,
            toolCallId,
            action: requestedAction,
            phase,
            supported: axSnapshot?.supported === true,
            nodeCount: axSnapshot?.nodeCount ?? countAxNodes(axSnapshot?.nodes),
            truncated: axSnapshot?.truncated === true,
            windowId: axSnapshot?.windowId,
          });
          return axSnapshot;
        } catch (error) {
          log.warn("computer_use ax snapshot failed", {
            sessionKey: options.sessionKey,
            toolCallId,
            action: requestedAction,
            phase,
            error: error instanceof Error ? error.message : String(error),
          });
          return undefined;
        }
      };
      const readOcrSnapshot = async (
        phase: "observe" | "before" | "after",
        currentObservation: ComputerUseObservation | undefined,
        currentCapturePayload: GatewayComputerCapturePayload | undefined,
      ): Promise<ComputerUseOcrSnapshot | undefined> => {
        if (status.supportsOcr !== true) {
          return undefined;
        }
        const payload = buildOcrRequestPayload({
          scope,
          observation: currentObservation,
          capture: currentCapturePayload,
        });
        if (!payload) {
          return undefined;
        }
        try {
          const ocrPayload = await invokeComputerClientCommand<GatewayComputerOcrPayload>({
            sessionKey: options.sessionKey,
            command: "computer.ocr",
            payload,
            timeoutMs,
          });
          const ocrSnapshot = buildOcrSnapshot(ocrPayload);
          log.info("computer_use ocr snapshot completed", {
            sessionKey: options.sessionKey,
            toolCallId,
            action: requestedAction,
            phase,
            supported: ocrSnapshot?.supported === true,
            engine: ocrSnapshot?.engine,
            regionCount: ocrSnapshot?.regionCount ?? ocrSnapshot?.regions.length ?? 0,
            truncated: ocrSnapshot?.truncated === true,
            windowId: ocrSnapshot?.windowId,
          });
          return ocrSnapshot;
        } catch (error) {
          log.warn("computer_use ocr snapshot failed", {
            sessionKey: options.sessionKey,
            toolCallId,
            action: requestedAction,
            phase,
            error: error instanceof Error ? error.message : String(error),
          });
          return undefined;
        }
      };
      const readCdpSnapshot = async (
        phase: "observe" | "before" | "after",
        currentObservation: ComputerUseObservation | undefined,
      ): Promise<ComputerUseCdpSnapshot | undefined> => {
        if (status.supportsCdp !== true) {
          return undefined;
        }
        const payload = buildCdpRequestPayload({
          scope,
          observation: currentObservation,
        });
        if (!payload) {
          return undefined;
        }
        try {
          const cdpPayload = await invokeComputerClientCommand<GatewayComputerCdpPayload>({
            sessionKey: options.sessionKey,
            command: "computer.cdp",
            payload,
            timeoutMs,
          });
          const cdpSnapshot = buildCdpSnapshot(cdpPayload);
          log.info("computer_use cdp snapshot completed", {
            sessionKey: options.sessionKey,
            toolCallId,
            action: requestedAction,
            phase,
            supported: cdpSnapshot?.supported === true,
            engine: cdpSnapshot?.engine,
            endpointId: cdpSnapshot?.endpointId,
            pageId: cdpSnapshot?.pageId,
            nodeCount: cdpSnapshot?.nodeCount ?? cdpSnapshot?.nodes.length ?? 0,
            coordinateMapping: cdpSnapshot?.coordinateMapping,
            truncated: cdpSnapshot?.truncated === true,
            windowId: cdpSnapshot?.windowId,
          });
          return cdpSnapshot;
        } catch (error) {
          log.warn("computer_use cdp snapshot failed", {
            sessionKey: options.sessionKey,
            toolCallId,
            action: requestedAction,
            phase,
            error: error instanceof Error ? error.message : String(error),
          });
          return undefined;
        }
      };
      const beforeAxSnapshot = shouldReadBeforeSemanticSnapshot
        ? await readAxSnapshot(action === "observe" ? "observe" : "before", observation)
        : undefined;
      const beforeCdpSnapshot = shouldReadBeforeSemanticSnapshot
        ? await readCdpSnapshot(action === "observe" ? "observe" : "before", observation)
        : undefined;
      const beforeOcrSnapshot = shouldReadBeforeSemanticSnapshot
        ? await readOcrSnapshot(
            action === "observe" ? "observe" : "before",
            observation,
            capturePayload,
          )
        : undefined;
      if (action === "observe" && !targetCatalog) {
        try {
          targetCatalog = await discoverComputerUseTargets({
            invokeClientCommand: invokeComputerClientCommand,
            sessionKey: options.sessionKey,
            timeoutMs,
          });
        } catch (error) {
          log.warn("computer_use target discovery failed", {
            sessionKey: options.sessionKey,
            toolCallId,
            action,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const beforeDiagnostics = mergeDiagnostics({
        capture: capturePayload,
      });
      const beforeCandidates = buildCandidateProposals({
        axSnapshot: beforeAxSnapshot,
        cdpSnapshot: beforeCdpSnapshot,
        ocrSnapshot: beforeOcrSnapshot,
        capture: beforeDiagnostics?.capture,
        observation,
      });
      const selectedPoint = readOptionalPoint(actionArgs);
      const selectedElementRef = readElementRef(actionArgs);
      const rememberedSelectedCandidate = lookupRememberedComputerUseCandidate({
        sessionKey: options.sessionKey,
        agentId: options.agentId,
        elementRef: selectedElementRef,
      });
      const currentCandidateByRef = findCandidateByRef(beforeCandidates, selectedElementRef);
      let selectedTarget = resolveSelectedTarget({
        point: selectedPoint,
        elementRef: selectedElementRef,
        candidates: beforeCandidates,
        target: beforeTargetBinding,
      });
      if (selectedElementRef && rememberedSelectedCandidate) {
        const currentCandidateMatchesMemory = candidateMatchesRememberedSelector({
          candidate: currentCandidateByRef,
          remembered: rememberedSelectedCandidate,
          observation,
        });
        if (!currentCandidateMatchesMemory) {
          const relocatedCandidate = findCandidateByRememberedSelector({
            candidates: beforeCandidates,
            remembered: rememberedSelectedCandidate,
            observation,
          });
          selectedTarget = relocatedCandidate
            ? selectedTargetFromCandidate(relocatedCandidate)
            : undefined;
          if (relocatedCandidate) {
            actionWarning = mergeComputerUseWarnings(
              `Element reference ${selectedElementRef} was relocated to ${relocatedCandidate.ref ?? relocatedCandidate.id} using the previous selector.`,
              actionWarning,
            );
          }
        }
      }
      if (
        action !== "observe" &&
        selectedPoint &&
        !selectedElementRef &&
        selectedTarget?.candidateId &&
        selectedTarget.point &&
        !sameComputerUsePoint(selectedPoint, selectedTarget.point)
      ) {
        actionWarning = mergeComputerUseWarnings(
          `Raw coordinate (${selectedPoint.x}, ${selectedPoint.y}) was snapped to ${selectedTarget.elementRef ?? selectedTarget.candidateId} at (${selectedTarget.point.x}, ${selectedTarget.point.y}). Prefer elementRef for repeatable actions.`,
          actionWarning,
        );
      }
      const groundedActionPoint = buildActionPayloadPoint({
        selected: selectedTarget,
        args: actionArgs,
      });
      const pendingActionPayload = buildPendingActionPayload({
        targetId: observation?.targetId,
        selected: selectedTarget,
        args: actionArgs,
      });
      rememberComputerUseCandidates({
        sessionKey: options.sessionKey,
        agentId: options.agentId,
        observation,
        candidates: beforeCandidates,
      });
      if (action !== "observe" && selectedElementRef && !selectedTarget) {
        return await createComputerUseFailedResult({
          action,
          args: actionArgs,
          summary: `Element reference ${selectedElementRef} is stale or not present in the current observation.`,
          error:
            `ELEMENT_STALE: ${selectedElementRef} does not exist in the current element candidate set. ` +
            "Re-observe the target before retrying.",
          capturePayload,
          frame: beforeFrame,
          axSnapshot: beforeAxSnapshot,
          cdpSnapshot: beforeCdpSnapshot,
          ocrSnapshot: beforeOcrSnapshot,
          candidates: beforeCandidates,
          observation,
          target: beforeTargetBinding,
          targets: targetCatalog,
          warning: mergeComputerUseWarnings(
            `Re-observe the target and use a current elementRef value: ${availableElementRefs(beforeCandidates)}.`,
            actionWarning,
          ),
          imageSanitization,
          sessionConfig,
        });
      }
      if (
        action !== "observe" &&
        selectedPoint &&
        !selectedElementRef &&
        actionNeedsGroundedElementPoint(action) &&
        !selectedTarget?.candidateId
      ) {
        return await createComputerUseFailedResult({
          action,
          args: actionArgs,
          summary: "Raw coordinate action could not be grounded to a current candidate.",
          error:
            `COORDINATE_UNGROUNDED: point (${selectedPoint.x}, ${selectedPoint.y}) did not match any current element candidate. ` +
            "Re-observe the target and use elementRef, or choose a coordinate inside a listed candidate.",
          capturePayload,
          frame: beforeFrame,
          axSnapshot: beforeAxSnapshot,
          cdpSnapshot: beforeCdpSnapshot,
          ocrSnapshot: beforeOcrSnapshot,
          candidates: beforeCandidates,
          selected: selectedTarget,
          observation,
          target: beforeTargetBinding,
          targets: targetCatalog,
          warning: mergeComputerUseWarnings(
            `Use a current elementRef value instead of naked coordinates: ${availableElementRefs(beforeCandidates)}.`,
            actionWarning,
          ),
          imageSanitization,
          sessionConfig,
        });
      }
      if (action === "set_text_submit" && !selectedPoint && !selectedElementRef) {
        return await createComputerUseFailedResult({
          action,
          args: actionArgs,
          summary: "set_text_submit requires a grounded text input target.",
          error:
            "TARGET_REQUIRED: set_text_submit must include elementRef or coordinates grounded to a current text input candidate.",
          capturePayload,
          frame: beforeFrame,
          axSnapshot: beforeAxSnapshot,
          cdpSnapshot: beforeCdpSnapshot,
          ocrSnapshot: beforeOcrSnapshot,
          candidates: beforeCandidates,
          selected: selectedTarget,
          observation,
          target: beforeTargetBinding,
          targets: targetCatalog,
          warning: mergeComputerUseWarnings(
            `Use the search/input elementRef before submitting: ${availableElementRefs(beforeCandidates)}.`,
            actionWarning,
          ),
          imageSanitization,
          sessionConfig,
        });
      }
      if (
        action !== "observe" &&
        selectedElementRef &&
        actionNeedsGroundedElementPoint(action) &&
        !groundedActionPoint
      ) {
        return await createComputerUseFailedResult({
          action,
          args: actionArgs,
          summary: `Element reference ${selectedElementRef} cannot be grounded to a point.`,
          error:
            `ELEMENT_UNGROUNDABLE: ${selectedElementRef} matched a candidate without a usable rect or point. ` +
            "Choose a candidate with geometry or provide an explicit point.",
          capturePayload,
          frame: beforeFrame,
          axSnapshot: beforeAxSnapshot,
          cdpSnapshot: beforeCdpSnapshot,
          ocrSnapshot: beforeOcrSnapshot,
          candidates: beforeCandidates,
          selected: selectedTarget,
          observation,
          target: beforeTargetBinding,
          targets: targetCatalog,
          warning: mergeComputerUseWarnings(
            "Choose a candidate with a rect or re-observe the target.",
            actionWarning,
          ),
          imageSanitization,
          sessionConfig,
        });
      }
      emitUpdate(
        onUpdate,
        {
          kind: "computer_use/v1",
          status: "ok",
          stage: action === "observe" ? "observing" : "acting",
          summary: summarizeAction(action, "pending"),
          ...(beforeFrame ? { frame: beforeFrame } : {}),
          ...(beforeAxSnapshot ? { axSnapshot: beforeAxSnapshot } : {}),
          ...(beforeCdpSnapshot ? { cdpSnapshot: beforeCdpSnapshot } : {}),
          ...(beforeOcrSnapshot ? { ocrSnapshot: beforeOcrSnapshot } : {}),
          ...(beforeCandidates?.length ? { candidates: beforeCandidates } : {}),
          ...(selectedTarget ? { selected: selectedTarget } : {}),
          action: buildActionResult(action, actionArgs, "pending", pendingActionPayload),
          ...(observation ? { observation } : {}),
          ...(beforeTargetBinding ? { target: beforeTargetBinding } : {}),
          ...(targetCatalog ? { targets: targetCatalog } : {}),
          ...(beforeDiagnostics ? { diagnostics: beforeDiagnostics } : {}),
          ...(actionWarning ? { warning: actionWarning } : {}),
        },
        sessionConfig,
      );

      if (!preparedAction.ok) {
        return await createComputerUseFailedResult({
          action: requestedAction,
          args,
          summary: preparedAction.summary,
          error: preparedAction.error,
          capturePayload,
          frame: beforeFrame,
          axSnapshot: beforeAxSnapshot,
          cdpSnapshot: beforeCdpSnapshot,
          ocrSnapshot: beforeOcrSnapshot,
          candidates: beforeCandidates,
          selected: selectedTarget,
          observation,
          target: beforeTargetBinding,
          targets: targetCatalog,
          warning: preparedAction.warning,
          imageSanitization,
          sessionConfig,
        });
      }

      if (action === "observe") {
        const resultPayload: ComputerUseStructuredPayload = {
          kind: "computer_use/v1",
          status: "ok",
          stage: "completed",
          summary: summarizeAction(action, "success"),
          ...(beforeFrame ? { frame: beforeFrame } : {}),
          ...(beforeAxSnapshot ? { axSnapshot: beforeAxSnapshot } : {}),
          ...(beforeCdpSnapshot ? { cdpSnapshot: beforeCdpSnapshot } : {}),
          ...(beforeOcrSnapshot ? { ocrSnapshot: beforeOcrSnapshot } : {}),
          ...(beforeCandidates?.length ? { candidates: beforeCandidates } : {}),
          action: buildActionResult(action, actionArgs, "success", pendingActionPayload),
          ...(observation ? { observation } : {}),
          ...(beforeTargetBinding ? { target: beforeTargetBinding } : {}),
          ...(targetCatalog ? { targets: targetCatalog } : {}),
          ...(beforeDiagnostics ? { diagnostics: beforeDiagnostics } : {}),
          ...(actionWarning ? { warning: actionWarning } : {}),
        };
        return await createComputerUseToolResult({
          label: "computer_use:observe",
          payload: withComputerUseInvocationMetadata(resultPayload, sessionConfig),
          summary: buildModelFacingSummary({
            summary: resultPayload.summary ?? "computer_use observe complete",
            observation,
            target: beforeTargetBinding,
            targets: targetCatalog,
            diagnostics: beforeDiagnostics,
            axSnapshot: beforeAxSnapshot,
            cdpSnapshot: beforeCdpSnapshot,
            ocrSnapshot: beforeOcrSnapshot,
            candidates: beforeCandidates,
            warning: resultPayload.warning,
          }),
          primaryCapture: capturePayload,
          imageSanitization,
        });
      }

      if (
        sessionConfig.approvals.highRiskActionsRequireConfirm &&
        isHighRiskComputerUseAction(action)
      ) {
        const approvalFingerprint = buildHighRiskApprovalFingerprint({
          action,
          args: actionArgs,
          scope,
          observation,
        });
        if (!isTrustedHighRiskComputerUseFingerprint(options.sessionKey, approvalFingerprint)) {
          const approvalOutcome = await requestComputerUseApproval({
            action,
            args: actionArgs,
            scope,
            observation,
            sessionKey: options.sessionKey,
            agentId: options.agentId,
            timeoutMs,
            signal,
            onUpdate,
            toolCallId,
            frame: beforeFrame,
            selected: selectedTarget,
            target: beforeTargetBinding,
            sessionConfig,
          });
          if (
            approvalOutcome.decision !== "allow-once" &&
            approvalOutcome.decision !== "allow-always"
          ) {
            const deniedReason =
              approvalOutcome.decision === "deny"
                ? "The desktop action was denied."
                : approvalOutcome.decision === "cancelled"
                  ? "The desktop action was cancelled."
                  : approvalOutcome.decision === "timeout"
                    ? "The desktop approval timed out."
                    : "No desktop approval route is available.";
            return await createComputerUseFailedResult({
              action,
              args: actionArgs,
              summary: deniedReason,
              error: deniedReason,
              capturePayload,
              frame: beforeFrame,
              axSnapshot: beforeAxSnapshot,
              cdpSnapshot: beforeCdpSnapshot,
              ocrSnapshot: beforeOcrSnapshot,
              candidates: beforeCandidates,
              selected: selectedTarget,
              observation,
              target: beforeTargetBinding,
              targets: targetCatalog,
              warning: mergeComputerUseWarnings(
                "High-risk desktop action was not executed.",
                actionWarning,
              ),
              imageSanitization,
              sessionConfig,
            });
          }
        }
      }

      let actionPayload: GatewayComputerActionPayload;
      try {
        const explicitWindowId = normalizeOptionalString(readStringParam(actionArgs, "windowId"));
        actionPayload = await invokeComputerClientCommand<GatewayComputerActionPayload>({
          sessionKey: options.sessionKey,
          command: "computer.action",
          payload: {
            action,
            ...buildActionCommandTarget({
              action,
              scope,
              observation,
              args: actionArgs,
            }),
            point: groundedActionPoint,
            elementSelector: selectedTarget?.selector,
            fromPoint: readOptionalPoint(actionArgs, "from"),
            toPoint: readOptionalPoint(actionArgs, "to"),
            direction: readStringParam(actionArgs, "direction"),
            amount: readNumberParam(actionArgs, "amount"),
            text: readStringParam(actionArgs, "text", { trim: false }),
            hotkey: readStringParam(actionArgs, "hotkey"),
            waitMs: readNumberParam(actionArgs, "waitMs", { integer: true }),
            appName: readStringParam(actionArgs, "appName"),
            bundleId: readStringParam(actionArgs, "bundleId"),
            ...(explicitWindowId ? { windowId: explicitWindowId } : {}),
            frameWidth: capturePayload?.width,
            frameHeight: capturePayload?.height,
          },
          timeoutMs,
        });
      } catch (error) {
        const clientError = readComputerUseClientError(error);
        if (clientError?.code === "OBSERVATION_STALE") {
          return await createComputerUseFailedResult({
            action,
            args: actionArgs,
            summary: "Desktop observation expired before the action could run.",
            error:
              clientError.message ??
              "The current desktop observation is stale. Re-observe the target before retrying.",
            capturePayload,
            frame: beforeFrame,
            axSnapshot: beforeAxSnapshot,
            cdpSnapshot: beforeCdpSnapshot,
            ocrSnapshot: beforeOcrSnapshot,
            candidates: beforeCandidates,
            selected: selectedTarget,
            observation,
            target: beforeTargetBinding,
            targets: targetCatalog,
            warning: mergeComputerUseWarnings(
              "Re-observe the target and retry the desktop action.",
              actionWarning,
            ),
            imageSanitization,
            sessionConfig,
          });
        }
        throw error;
      }

      let afterFrame: ComputerUseFrameArtifactRef | undefined;
      let afterCapturePayload: GatewayComputerCapturePayload | undefined;
      let afterObservation: ComputerUseObservation | undefined;
      let afterAxSnapshot: ComputerUseAxSnapshot | undefined;
      let afterCdpSnapshot: ComputerUseCdpSnapshot | undefined;
      let afterOcrSnapshot: ComputerUseOcrSnapshot | undefined;
      let afterTargetCatalog: ComputerUseTargetCatalog | undefined;
      const shouldVerifyAfterAction = args.verifyAfterAction !== false || action === "focus_window";
      if (shouldVerifyAfterAction) {
        const verifyingDiagnostics = mergeDiagnostics({
          capture: capturePayload,
          action: actionPayload,
        });
        emitUpdate(
          onUpdate,
          {
            kind: "computer_use/v1",
            status: "ok",
            stage: "verifying",
            summary: "Verifying desktop state",
            ...(beforeFrame ? { frame: beforeFrame } : {}),
            ...(beforeAxSnapshot ? { axSnapshot: beforeAxSnapshot } : {}),
            ...(beforeCdpSnapshot ? { cdpSnapshot: beforeCdpSnapshot } : {}),
            ...(beforeOcrSnapshot ? { ocrSnapshot: beforeOcrSnapshot } : {}),
            ...(beforeCandidates?.length ? { candidates: beforeCandidates } : {}),
            action: buildActionResult(action, actionArgs, "pending", actionPayload),
            ...(observation ? { observation } : {}),
            ...(beforeTargetBinding ? { target: beforeTargetBinding } : {}),
            ...(targetCatalog ? { targets: targetCatalog } : {}),
            ...(verifyingDiagnostics ? { diagnostics: verifyingDiagnostics } : {}),
            ...(actionWarning ? { warning: actionWarning } : {}),
          },
          sessionConfig,
        );
        const focusVerificationWindowId =
          action === "focus_window"
            ? (normalizeOptionalString(actionPayload.windowId) ?? focusTarget?.windowId)
            : undefined;
        let verificationTarget: ComputerUseCaptureTargetRequest =
          action === "focus_window"
            ? focusVerificationWindowId
              ? { scopeType: "window", windowId: focusVerificationWindowId }
              : buildCurrentWindowTargetRequest()
            : actionShouldVerifyFrontmostSurface({
                  action,
                  target: beforeTargetBinding,
                  observation,
                })
              ? buildCurrentWindowTargetRequest()
              : buildResolvedObservationTarget({
                  scope,
                  observation,
                });
        try {
          afterCapturePayload = await invokeComputerClientCommand<GatewayComputerCapturePayload>({
            sessionKey: options.sessionKey,
            command: "computer.capture",
            payload: verificationTarget,
            timeoutMs,
          });
        } catch (error) {
          if (action !== "focus_window" || !verificationTarget.windowId) {
            throw error;
          }
          log.warn("computer_use post-focus window capture failed; retrying frontmost window", {
            sessionKey: options.sessionKey,
            toolCallId,
            action,
            windowId: verificationTarget.windowId,
            error: error instanceof Error ? error.message : String(error),
          });
          verificationTarget = buildCurrentWindowTargetRequest();
          afterCapturePayload = await invokeComputerClientCommand<GatewayComputerCapturePayload>({
            sessionKey: options.sessionKey,
            command: "computer.capture",
            payload: verificationTarget,
            timeoutMs,
          });
        }
        afterFrame = buildFrameRef(toolCallId, "after", afterCapturePayload);
        afterObservation = buildObservation(scope, afterCapturePayload);
        afterAxSnapshot = await readAxSnapshot("after", afterObservation ?? observation);
        afterCdpSnapshot = await readCdpSnapshot("after", afterObservation ?? observation);
        afterOcrSnapshot = shouldReadAfterOcrSnapshot
          ? await readOcrSnapshot("after", afterObservation ?? observation, afterCapturePayload)
          : undefined;
        if (action === "focus_window") {
          try {
            afterTargetCatalog = await discoverComputerUseTargets({
              invokeClientCommand: invokeComputerClientCommand,
              sessionKey: options.sessionKey,
              timeoutMs,
            });
          } catch (error) {
            log.warn("computer_use post-focus target discovery failed", {
              sessionKey: options.sessionKey,
              toolCallId,
              action,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
      const finalObservation = afterObservation ?? observation;
      const afterTargetBinding = buildTargetBindingFromGatewayPayload(afterCapturePayload);
      const finalTargetBinding = afterTargetBinding ?? beforeTargetBinding;
      const finalAxSnapshot = afterAxSnapshot ?? beforeAxSnapshot;
      const finalCdpSnapshot = afterCdpSnapshot ?? beforeCdpSnapshot;
      const finalOcrSnapshot = afterOcrSnapshot ?? beforeOcrSnapshot;
      const finalTargetCatalog = afterTargetCatalog ?? targetCatalog;
      const finalDiagnostics = mergeDiagnostics({
        capture: capturePayload,
        postActionCapture: afterCapturePayload,
        action: actionPayload,
      });
      const finalCandidates =
        buildCandidateProposals({
          axSnapshot: finalAxSnapshot,
          cdpSnapshot: finalCdpSnapshot,
          ocrSnapshot: finalOcrSnapshot,
          capture: finalDiagnostics?.postActionCapture ?? finalDiagnostics?.capture,
          observation: finalObservation ?? observation,
        }) ?? beforeCandidates;
      rememberComputerUseCandidates({
        sessionKey: options.sessionKey,
        agentId: options.agentId,
        observation: finalObservation ?? observation,
        candidates: finalCandidates,
      });
      const finalSelectedTarget =
        selectedTarget ??
        resolveSelectedTarget({
          point: selectedPoint,
          elementRef: selectedElementRef,
          candidates: finalCandidates ?? beforeCandidates,
          target: finalTargetBinding,
        });
      if (
        action === "focus_window" &&
        focusTarget &&
        !focusTargetMatchesExpectation({
          focusTarget,
          observation: finalObservation,
          axSnapshot: finalAxSnapshot,
        })
      ) {
        const targetLabel = describePreparedFocusTarget(focusTarget);
        return await createComputerUseFailedResult({
          action,
          args: actionArgs,
          summary: `Focus target verification failed for ${targetLabel}.`,
          error:
            `focus_window expected ${targetLabel}, but the verified desktop observation did not match the requested target. ` +
            "Retry using a real windowId or rerun discover_targets before focusing again.",
          capturePayload,
          postActionCapture: afterCapturePayload,
          actionPayload,
          frame: beforeFrame,
          axSnapshot: finalAxSnapshot,
          cdpSnapshot: finalCdpSnapshot,
          ocrSnapshot: finalOcrSnapshot,
          candidates: finalCandidates,
          selected: finalSelectedTarget,
          observation: finalObservation,
          target: finalTargetBinding,
          targets: finalTargetCatalog,
          warning: mergeComputerUseWarnings(
            "The verified desktop target did not match the requested focus target.",
            actionWarning,
          ),
          imageSanitization,
          sessionConfig,
        });
      }

      const resultPayload: ComputerUseStructuredPayload = {
        kind: "computer_use/v1",
        status: "ok",
        stage: "completed",
        summary: summarizeAction(action, "success"),
        ...(finalAxSnapshot ? { axSnapshot: finalAxSnapshot } : {}),
        ...(finalCdpSnapshot ? { cdpSnapshot: finalCdpSnapshot } : {}),
        ...(finalOcrSnapshot ? { ocrSnapshot: finalOcrSnapshot } : {}),
        ...(finalCandidates?.length ? { candidates: finalCandidates } : {}),
        ...((beforeFrame ?? afterFrame) ? { frame: beforeFrame ?? afterFrame } : {}),
        ...(beforeFrame && afterFrame ? { postActionFrame: afterFrame } : {}),
        ...(finalSelectedTarget ? { selected: finalSelectedTarget } : {}),
        action: buildActionResult(action, actionArgs, "success", actionPayload),
        ...(finalObservation ? { observation: finalObservation } : {}),
        ...(finalTargetBinding ? { target: finalTargetBinding } : {}),
        ...(finalTargetCatalog ? { targets: finalTargetCatalog } : {}),
        ...(finalDiagnostics ? { diagnostics: finalDiagnostics } : {}),
        ...(mergeComputerUseWarnings(actionPayload.warning ?? undefined, actionWarning)
          ? {
              warning: mergeComputerUseWarnings(actionPayload.warning ?? undefined, actionWarning),
            }
          : {}),
      };
      log.info("computer_use tool result prepared", {
        sessionKey: options.sessionKey,
        toolCallId,
        action,
        targetKind: finalObservation?.targetKind ?? undefined,
        appName: finalObservation?.appName ?? undefined,
        hasPrimaryImage: Boolean(
          normalizeOptionalString((capturePayload ?? afterCapturePayload)?.framePath) ??
          normalizeOptionalString((capturePayload ?? afterCapturePayload)?.frameUrl) ??
          normalizeOptionalString((capturePayload ?? afterCapturePayload)?.base64Png),
        ),
        hasVerificationImage: Boolean(
          normalizeOptionalString(afterCapturePayload?.framePath) ??
          normalizeOptionalString(afterCapturePayload?.frameUrl) ??
          normalizeOptionalString(afterCapturePayload?.base64Png),
        ),
        hasAxSnapshot: Boolean(finalAxSnapshot),
        axNodeCount: finalAxSnapshot?.nodeCount ?? countAxNodes(finalAxSnapshot?.nodes),
        hasCdpSnapshot: Boolean(finalCdpSnapshot),
        cdpNodeCount: finalCdpSnapshot?.nodeCount ?? finalCdpSnapshot?.nodes.length ?? 0,
        hasOcrSnapshot: Boolean(finalOcrSnapshot),
        ocrRegionCount: finalOcrSnapshot?.regionCount ?? finalOcrSnapshot?.regions.length ?? 0,
        candidateCount: finalCandidates?.length ?? 0,
      });
      return await createComputerUseToolResult({
        label: "computer_use:action",
        payload: withComputerUseInvocationMetadata(resultPayload, sessionConfig),
        summary: buildModelFacingSummary({
          summary: resultPayload.summary ?? "computer_use action complete",
          observation: finalObservation,
          target: finalTargetBinding,
          targets: finalTargetCatalog,
          diagnostics: finalDiagnostics,
          axSnapshot: finalAxSnapshot,
          cdpSnapshot: finalCdpSnapshot,
          ocrSnapshot: finalOcrSnapshot,
          candidates: finalCandidates,
          warning: resultPayload.warning,
        }),
        primaryCapture: capturePayload ?? afterCapturePayload,
        secondaryCapture: capturePayload ? afterCapturePayload : undefined,
        imageSanitization,
      });
    },
  };
}

const DEFAULT_TOOL_SESSION_CONFIG: ComputerUseSessionConfig = {
  enabled: true,
  mode: "plan_and_act",
  activation: "auto",
  scope: { type: "full_desktop" },
  hostPolicy: "local_only",
  modelPolicy: { mode: "follow_user_model" },
  approvals: { highRiskActionsRequireConfirm: true },
};

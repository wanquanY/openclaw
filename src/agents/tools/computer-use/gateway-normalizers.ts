import crypto from "node:crypto";
import type {
  ComputerUseAction,
  ComputerUseActionDiagnostics,
  ComputerUseAppTarget,
  ComputerUseAxNode,
  ComputerUseAxSnapshot,
  ComputerUseCaptureDiagnostics,
  ComputerUseCdpNode,
  ComputerUseCdpSnapshot,
  ComputerUseDiagnostics,
  ComputerUseFrameArtifactRef,
  ComputerUseObservation,
  ComputerUseOcrRegion,
  ComputerUseOcrSnapshot,
  ComputerUsePoint,
  ComputerUseScope,
  ComputerUseTargetBinding,
  ComputerUseTargetCatalog,
  ComputerUseWindowTarget,
} from "../../../computer-use/types.js";
import { normalizeOptionalString } from "../../../shared/string-coerce.js";
import { readStringParam } from "../common.js";
import type {
  GatewayComputerActionPayload,
  GatewayComputerAxNodePayload,
  GatewayComputerAxPayload,
  GatewayComputerCapturePayload,
  GatewayComputerCdpEndpointPayload,
  GatewayComputerCdpNodePayload,
  GatewayComputerCdpPagePayload,
  GatewayComputerCdpPayload,
  GatewayComputerOcrPayload,
  GatewayComputerOcrRegionPayload,
  GatewayComputerPerceptionContextPayload,
  GatewayComputerTargetAppPayload,
  GatewayComputerTargetCatalogPayload,
  GatewayComputerTargetDisplayPayload,
  GatewayComputerTargetWindowPayload,
} from "./gateway-payloads.js";

function buildFramePreviewUrl(payload: GatewayComputerCapturePayload): string | undefined {
  const frameUrl = normalizeOptionalString(payload.frameUrl);
  if (frameUrl) {
    return frameUrl;
  }
  const mimeType = normalizeOptionalString(payload.mimeType) ?? "image/png";
  const base64 = normalizeOptionalString(payload.base64Png);
  return base64 ? `data:${mimeType};base64,${base64}` : undefined;
}

function buildFrameRef(
  toolCallId: string,
  phase: "before" | "after" | "observe",
  payload: GatewayComputerCapturePayload,
): ComputerUseFrameArtifactRef | undefined {
  const previewUrl = buildFramePreviewUrl(payload);
  const filePath = normalizeOptionalString(payload.framePath);
  if (!previewUrl && !filePath) {
    return undefined;
  }
  return {
    artifactId: normalizeOptionalString(payload.capturedAt)
      ? `${toolCallId}:${phase}:${payload.capturedAt}`
      : `${toolCallId}:${phase}:${crypto.randomUUID()}`,
    ...(previewUrl ? { previewUrl } : {}),
    ...(filePath ? { filePath } : {}),
    width: typeof payload.width === "number" ? payload.width : undefined,
    height: typeof payload.height === "number" ? payload.height : undefined,
    capturedAt: normalizeOptionalString(payload.capturedAt) ?? undefined,
  };
}

function normalizeCaptureTargetKind(
  value: string | null | undefined,
): ComputerUseObservation["targetKind"] | undefined {
  const normalized = normalizeOptionalString(value);
  if (normalized === "window") {
    return "window";
  }
  if (normalized === "display") {
    return "display";
  }
  if (normalized === "desktop") {
    return "desktop";
  }
  return undefined;
}

function buildObservation(
  scope: ComputerUseScope,
  payload?: GatewayComputerCapturePayload,
): ComputerUseObservation | undefined {
  const targetBinding = buildTargetBindingFromGatewayPayload(payload);
  const normalizedTargetKind = normalizeOptionalString(payload?.targetKind);
  const targetKindFromPayload =
    normalizedTargetKind === "display"
      ? "display"
      : normalizedTargetKind === "window"
        ? "window"
        : normalizedTargetKind === "desktop"
          ? "desktop"
          : normalizeOptionalString(payload?.windowId) ||
              normalizeOptionalString(payload?.windowTitle) ||
              normalizeOptionalString(payload?.appName)
            ? "window"
            : normalizeOptionalString(payload?.displayId) ||
                normalizeOptionalString(scope.displayId)
              ? "display"
              : scope.type === "full_desktop" ||
                  normalizeOptionalString(payload?.scopeType) === "desktop"
                ? "desktop"
                : undefined;
  const targetKind = targetBinding?.kind ?? targetKindFromPayload;
  const observation: ComputerUseObservation = {
    targetId: targetBinding?.targetId ?? normalizeOptionalString(payload?.targetId) ?? undefined,
    ...(targetKind ? { targetKind } : {}),
    appName:
      normalizeOptionalString(targetBinding?.app?.appName) ??
      normalizeOptionalString(payload?.appName) ??
      undefined,
    bundleId:
      normalizeOptionalString(targetBinding?.app?.bundleId) ??
      normalizeOptionalString(payload?.bundleId) ??
      undefined,
    windowId:
      normalizeOptionalString(targetBinding?.window?.windowId) ??
      normalizeOptionalString(payload?.windowId) ??
      scope.windowId,
    windowTitle:
      normalizeOptionalString(targetBinding?.window?.title) ??
      normalizeOptionalString(payload?.windowTitle) ??
      undefined,
    displayId:
      normalizeOptionalString(targetBinding?.display?.displayId) ??
      normalizeOptionalString(payload?.displayId) ??
      scope.displayId,
    observationId: normalizeOptionalString(payload?.observationId) ?? undefined,
  };
  if (
    !observation.targetKind &&
    !observation.targetId &&
    !observation.appName &&
    !observation.bundleId &&
    !observation.windowId &&
    !observation.windowTitle &&
    !observation.displayId &&
    !observation.observationId
  ) {
    return undefined;
  }
  return observation;
}

function toGatewayPoint(
  value:
    | {
        x?: number;
        y?: number;
      }
    | null
    | undefined,
): ComputerUsePoint | undefined {
  if (typeof value?.x !== "number" || typeof value?.y !== "number") {
    return undefined;
  }
  return {
    x: value.x,
    y: value.y,
  };
}

function toGatewayRect(
  value:
    | {
        x?: number;
        y?: number;
        width?: number;
        height?: number;
      }
    | null
    | undefined,
): ComputerUseCaptureDiagnostics["globalRect"] | undefined {
  if (
    typeof value?.x !== "number" ||
    typeof value?.y !== "number" ||
    typeof value?.width !== "number" ||
    typeof value?.height !== "number"
  ) {
    return undefined;
  }
  return {
    x: value.x,
    y: value.y,
    width: value.width,
    height: value.height,
  };
}

function toGatewaySize(
  value:
    | {
        width?: number;
        height?: number;
      }
    | null
    | undefined,
): ComputerUseCaptureDiagnostics["frameSize"] | undefined {
  if (typeof value?.width !== "number" || typeof value?.height !== "number") {
    return undefined;
  }
  return {
    width: value.width,
    height: value.height,
  };
}

function toGatewayStringArray(value: unknown[] | null | undefined): string[] | undefined {
  const items =
    value
      ?.map((item) =>
        normalizeOptionalString(
          typeof item === "string" || typeof item === "number" || typeof item === "boolean"
            ? String(item)
            : undefined,
        ),
      )
      .filter((item): item is string => Boolean(item)) ?? [];
  return items.length > 0 ? items : undefined;
}

function toGatewayNumberArray(value: unknown[] | null | undefined): number[] | undefined {
  const items =
    value
      ?.map((item) => {
        if (typeof item === "number" && Number.isFinite(item)) {
          return Math.round(item);
        }
        const normalized = normalizeOptionalString(typeof item === "string" ? item : undefined);
        const parsed = normalized ? Number(normalized) : Number.NaN;
        return Number.isFinite(parsed) ? Math.round(parsed) : undefined;
      })
      .filter((item): item is number => typeof item === "number") ?? [];
  return items.length > 0 ? items : undefined;
}

function buildCaptureDiagnosticsFromGatewayPayload(
  payload?: GatewayComputerPerceptionContextPayload | null,
): ComputerUseCaptureDiagnostics | undefined {
  const diagnostics = payload?.diagnostics?.capture;
  const backend =
    normalizeOptionalString(diagnostics?.backend) ??
    normalizeOptionalString(payload?.backend) ??
    undefined;
  const scopeType =
    normalizeOptionalString(diagnostics?.scopeType) ??
    normalizeOptionalString(payload?.scopeType) ??
    undefined;
  const targetKind =
    normalizeCaptureTargetKind(diagnostics?.targetKind) ??
    normalizeCaptureTargetKind(payload?.targetKind) ??
    undefined;
  const targetId =
    normalizeOptionalString(diagnostics?.targetId) ??
    normalizeOptionalString(payload?.targetId) ??
    undefined;
  const observationId =
    normalizeOptionalString(diagnostics?.observationId) ??
    normalizeOptionalString(payload?.observationId) ??
    undefined;
  const appName =
    normalizeOptionalString(diagnostics?.appName) ??
    normalizeOptionalString(payload?.appName) ??
    undefined;
  const bundleId =
    normalizeOptionalString(diagnostics?.bundleId) ??
    normalizeOptionalString(payload?.bundleId) ??
    undefined;
  const windowId =
    normalizeOptionalString(diagnostics?.windowId) ??
    normalizeOptionalString(payload?.windowId) ??
    undefined;
  const windowTitle =
    normalizeOptionalString(diagnostics?.windowTitle) ??
    normalizeOptionalString(payload?.windowTitle) ??
    undefined;
  const displayId =
    normalizeOptionalString(diagnostics?.displayId) ??
    normalizeOptionalString(payload?.displayId) ??
    undefined;
  const displayIds =
    toGatewayStringArray(diagnostics?.displayIds) ??
    toGatewayStringArray(payload?.displayIds) ??
    undefined;
  const globalRect =
    toGatewayRect(diagnostics?.globalRect) ??
    toGatewayRect(
      typeof payload?.globalX === "number" &&
        typeof payload?.globalY === "number" &&
        typeof payload?.logicalWidth === "number" &&
        typeof payload?.logicalHeight === "number"
        ? {
            x: payload.globalX,
            y: payload.globalY,
            width: payload.logicalWidth,
            height: payload.logicalHeight,
          }
        : undefined,
    );
  const frameSize =
    toGatewaySize(diagnostics?.frameSize) ??
    (typeof payload?.width === "number" && typeof payload?.height === "number"
      ? { width: payload.width, height: payload.height }
      : undefined);
  const logicalSize =
    toGatewaySize(diagnostics?.logicalSize) ??
    (typeof payload?.logicalWidth === "number" && typeof payload?.logicalHeight === "number"
      ? { width: payload.logicalWidth, height: payload.logicalHeight }
      : undefined);
  const scaleFactor =
    typeof diagnostics?.scaleFactor === "number"
      ? diagnostics.scaleFactor
      : typeof payload?.scaleFactor === "number"
        ? payload.scaleFactor
        : undefined;
  const overlayWasVisibleBeforeCapture =
    typeof diagnostics?.overlayWasVisibleBeforeCapture === "boolean"
      ? diagnostics.overlayWasVisibleBeforeCapture
      : undefined;
  const overlayHiddenBeforeCapture =
    typeof diagnostics?.overlayHiddenBeforeCapture === "boolean"
      ? diagnostics.overlayHiddenBeforeCapture
      : undefined;
  const overlayHideSettledMs =
    typeof diagnostics?.overlayHideSettledMs === "number"
      ? diagnostics.overlayHideSettledMs
      : undefined;
  const overlayPayloadId = normalizeOptionalString(diagnostics?.overlayPayloadId) ?? undefined;
  const contaminationStatus =
    normalizeOptionalString(diagnostics?.contaminationCheck?.status) ?? undefined;
  const contaminationAttempts =
    typeof diagnostics?.contaminationCheck?.attempts === "number" &&
    Number.isFinite(diagnostics.contaminationCheck.attempts)
      ? Math.max(1, Math.round(diagnostics.contaminationCheck.attempts))
      : undefined;
  const contaminationReason =
    normalizeOptionalString(diagnostics?.contaminationCheck?.reason) ?? undefined;
  const contaminationCheck = contaminationStatus
    ? {
        status: contaminationStatus,
        attempts: contaminationAttempts ?? 1,
        ...(contaminationReason ? { reason: contaminationReason } : {}),
      }
    : undefined;
  const capturedAt =
    normalizeOptionalString(diagnostics?.capturedAt) ??
    normalizeOptionalString(payload?.capturedAt) ??
    undefined;
  if (
    !backend &&
    !scopeType &&
    !targetKind &&
    !targetId &&
    !observationId &&
    !appName &&
    !bundleId &&
    !windowId &&
    !windowTitle &&
    !displayId &&
    !displayIds?.length &&
    !globalRect &&
    !frameSize &&
    !logicalSize &&
    scaleFactor === undefined &&
    overlayWasVisibleBeforeCapture === undefined &&
    overlayHiddenBeforeCapture === undefined &&
    overlayHideSettledMs === undefined &&
    !overlayPayloadId &&
    !contaminationCheck &&
    !capturedAt
  ) {
    return undefined;
  }
  return {
    ...(backend ? { backend } : {}),
    ...(scopeType ? { scopeType } : {}),
    ...(targetKind ? { targetKind } : {}),
    ...(targetId ? { targetId } : {}),
    ...(observationId ? { observationId } : {}),
    ...(appName ? { appName } : {}),
    ...(bundleId ? { bundleId } : {}),
    ...(windowId ? { windowId } : {}),
    ...(windowTitle ? { windowTitle } : {}),
    ...(displayId ? { displayId } : {}),
    ...(displayIds?.length ? { displayIds } : {}),
    ...(globalRect ? { globalRect } : {}),
    ...(frameSize ? { frameSize } : {}),
    ...(logicalSize ? { logicalSize } : {}),
    ...(typeof scaleFactor === "number" ? { scaleFactor } : {}),
    ...(typeof overlayWasVisibleBeforeCapture === "boolean"
      ? { overlayWasVisibleBeforeCapture }
      : {}),
    ...(typeof overlayHiddenBeforeCapture === "boolean" ? { overlayHiddenBeforeCapture } : {}),
    ...(typeof overlayHideSettledMs === "number" ? { overlayHideSettledMs } : {}),
    ...(overlayPayloadId ? { overlayPayloadId } : {}),
    ...(contaminationCheck ? { contaminationCheck } : {}),
    ...(capturedAt ? { capturedAt } : {}),
  };
}

function inferTargetKindFromTargetId(
  value: string | undefined,
): ComputerUseTargetBinding["kind"] | undefined {
  if (!value) {
    return undefined;
  }
  if (value === "desktop" || value === "desktop:all") {
    return "desktop";
  }
  if (value.startsWith("window:")) {
    return "window";
  }
  if (value.startsWith("display:")) {
    return "display";
  }
  return undefined;
}

function buildTargetBindingFromGatewayPayload(
  payload?: GatewayComputerPerceptionContextPayload | null,
): ComputerUseTargetBinding | undefined {
  const raw = payload?.target;
  const diagnostics = buildCaptureDiagnosticsFromGatewayPayload(payload);
  const targetId =
    normalizeOptionalString(raw?.targetId) ??
    normalizeOptionalString(diagnostics?.targetId) ??
    normalizeOptionalString(payload?.targetId) ??
    undefined;
  const kind =
    normalizeCaptureTargetKind(raw?.kind) ??
    diagnostics?.targetKind ??
    normalizeCaptureTargetKind(payload?.targetKind) ??
    inferTargetKindFromTargetId(targetId);
  if (!targetId || !kind) {
    return undefined;
  }

  const appName =
    normalizeOptionalString(raw?.app?.appName) ??
    normalizeOptionalString(diagnostics?.appName) ??
    normalizeOptionalString(payload?.appName) ??
    undefined;
  const bundleId =
    normalizeOptionalString(raw?.app?.bundleId) ??
    normalizeOptionalString(diagnostics?.bundleId) ??
    normalizeOptionalString(payload?.bundleId) ??
    undefined;
  const processId = typeof raw?.app?.processId === "number" ? raw.app.processId : undefined;
  const app =
    appName || bundleId || typeof processId === "number" || typeof raw?.app?.running === "boolean"
      ? {
          ...(appName ? { appName } : {}),
          ...(bundleId ? { bundleId } : {}),
          ...(typeof processId === "number" ? { processId } : {}),
          ...(typeof raw?.app?.running === "boolean" ? { running: raw.app.running } : {}),
        }
      : undefined;

  const windowId =
    normalizeOptionalString(raw?.window?.windowId) ??
    normalizeOptionalString(diagnostics?.windowId) ??
    normalizeOptionalString(payload?.windowId) ??
    undefined;
  const title =
    trimModelText(raw?.window?.title ?? undefined, 200) ??
    trimModelText(diagnostics?.windowTitle, 200) ??
    trimModelText(payload?.windowTitle ?? undefined, 200);
  const window =
    windowId ||
    title ||
    typeof raw?.window?.isFocused === "boolean" ||
    typeof raw?.window?.isMinimized === "boolean" ||
    typeof raw?.window?.isMaximized === "boolean"
      ? {
          ...(windowId ? { windowId } : {}),
          ...(title ? { title } : {}),
          ...(typeof raw?.window?.isFocused === "boolean"
            ? { isFocused: raw.window.isFocused }
            : {}),
          ...(typeof raw?.window?.isMinimized === "boolean"
            ? { isMinimized: raw.window.isMinimized }
            : {}),
          ...(typeof raw?.window?.isMaximized === "boolean"
            ? { isMaximized: raw.window.isMaximized }
            : {}),
        }
      : undefined;

  const displayId =
    normalizeOptionalString(raw?.display?.displayId) ??
    normalizeOptionalString(diagnostics?.displayId) ??
    normalizeOptionalString(payload?.displayId) ??
    undefined;
  const displayName = trimModelText(raw?.display?.name ?? undefined, 120);
  const displayScaleFactor =
    typeof raw?.display?.scaleFactor === "number"
      ? raw.display.scaleFactor
      : typeof diagnostics?.scaleFactor === "number"
        ? diagnostics.scaleFactor
        : typeof payload?.scaleFactor === "number"
          ? payload.scaleFactor
          : undefined;
  const display =
    displayId ||
    displayName ||
    typeof raw?.display?.isPrimary === "boolean" ||
    typeof raw?.display?.isBuiltin === "boolean" ||
    typeof displayScaleFactor === "number"
      ? {
          ...(displayId ? { displayId } : {}),
          ...(displayName ? { name: displayName } : {}),
          ...(typeof raw?.display?.isPrimary === "boolean"
            ? { isPrimary: raw.display.isPrimary }
            : {}),
          ...(typeof raw?.display?.isBuiltin === "boolean"
            ? { isBuiltin: raw.display.isBuiltin }
            : {}),
          ...(typeof displayScaleFactor === "number" ? { scaleFactor: displayScaleFactor } : {}),
        }
      : undefined;

  const boundsGlobal = toGatewayRect(raw?.boundsGlobal) ?? diagnostics?.globalRect;
  const frameSize = toGatewaySize(raw?.frameSize) ?? diagnostics?.frameSize;
  const logicalSize = toGatewaySize(raw?.logicalSize) ?? diagnostics?.logicalSize;
  const backend =
    normalizeOptionalString(raw?.capture?.backend) ??
    normalizeOptionalString(diagnostics?.backend) ??
    normalizeOptionalString(payload?.backend) ??
    undefined;
  const captureScaleFactor =
    typeof raw?.capture?.scaleFactor === "number"
      ? raw.capture.scaleFactor
      : typeof diagnostics?.scaleFactor === "number"
        ? diagnostics.scaleFactor
        : undefined;
  const capture =
    backend || typeof captureScaleFactor === "number"
      ? {
          ...(backend ? { backend } : {}),
          ...(typeof captureScaleFactor === "number" ? { scaleFactor: captureScaleFactor } : {}),
        }
      : undefined;
  const observedAt =
    normalizeOptionalString(raw?.observedAt) ??
    normalizeOptionalString(diagnostics?.capturedAt) ??
    normalizeOptionalString(payload?.capturedAt) ??
    undefined;

  return {
    targetId,
    kind,
    ...(observedAt ? { observedAt } : {}),
    ...(app ? { app } : {}),
    ...(window ? { window } : {}),
    ...(display ? { display } : {}),
    ...(boundsGlobal ? { boundsGlobal } : {}),
    ...(frameSize ? { frameSize } : {}),
    ...(logicalSize ? { logicalSize } : {}),
    ...(capture ? { capture } : {}),
  };
}

function buildActionDiagnosticsFromGatewayPayload(
  payload?: GatewayComputerActionPayload | null,
): ComputerUseActionDiagnostics | undefined {
  const diagnostics = payload?.diagnostics?.action;
  const scopeType = normalizeOptionalString(diagnostics?.scopeType) ?? undefined;
  const targetKind = normalizeCaptureTargetKind(diagnostics?.targetKind);
  const targetId =
    normalizeOptionalString(diagnostics?.targetId) ??
    normalizeOptionalString(payload?.targetId) ??
    undefined;
  const observationId = normalizeOptionalString(diagnostics?.observationId) ?? undefined;
  const mappingSource = normalizeOptionalString(diagnostics?.mappingSource) ?? undefined;
  const interactionMode = normalizeOptionalString(diagnostics?.interactionMode) ?? undefined;
  const inputBackend =
    normalizeOptionalString(diagnostics?.inputBackend) ??
    normalizeOptionalString(payload?.inputBackend) ??
    undefined;
  const semanticPath =
    normalizeOptionalString(diagnostics?.semanticPath) ??
    normalizeOptionalString(payload?.semanticPath) ??
    undefined;
  const selectorAttempted =
    typeof diagnostics?.selectorAttempted === "boolean"
      ? diagnostics.selectorAttempted
      : typeof payload?.selectorAttempted === "boolean"
        ? payload.selectorAttempted
        : undefined;
  const selectorMatched =
    typeof diagnostics?.selectorMatched === "boolean"
      ? diagnostics.selectorMatched
      : typeof payload?.selectorMatched === "boolean"
        ? payload.selectorMatched
        : undefined;
  const fallbackReason =
    normalizeOptionalString(diagnostics?.fallbackReason) ??
    normalizeOptionalString(payload?.fallbackReason) ??
    undefined;
  const focusLocked =
    typeof diagnostics?.focusLocked === "boolean"
      ? diagnostics.focusLocked
      : typeof payload?.focusLocked === "boolean"
        ? payload.focusLocked
        : undefined;
  const cursorRestored =
    typeof diagnostics?.cursorRestored === "boolean"
      ? diagnostics.cursorRestored
      : typeof payload?.cursorRestored === "boolean"
        ? payload.cursorRestored
        : undefined;
  const frameSize = toGatewaySize(diagnostics?.frameSize);
  const relativePoint = toGatewayPoint(diagnostics?.relativePoint);
  const relativeFromPoint = toGatewayPoint(diagnostics?.relativeFromPoint);
  const relativeToPoint = toGatewayPoint(diagnostics?.relativeToPoint);
  const absolutePoint = toGatewayPoint(diagnostics?.absolutePoint);
  const absoluteFromPoint = toGatewayPoint(diagnostics?.absoluteFromPoint);
  const absoluteToPoint = toGatewayPoint(diagnostics?.absoluteToPoint);
  const deltaX = typeof diagnostics?.deltaX === "number" ? diagnostics.deltaX : undefined;
  const deltaY = typeof diagnostics?.deltaY === "number" ? diagnostics.deltaY : undefined;
  const observationAgeMs =
    typeof diagnostics?.observationAgeMs === "number" ? diagnostics.observationAgeMs : undefined;
  const executedAt =
    normalizeOptionalString(diagnostics?.executedAt) ??
    normalizeOptionalString(payload?.executedAt) ??
    undefined;
  if (
    !scopeType &&
    !targetKind &&
    !targetId &&
    !observationId &&
    !mappingSource &&
    !interactionMode &&
    !inputBackend &&
    !semanticPath &&
    selectorAttempted === undefined &&
    selectorMatched === undefined &&
    !fallbackReason &&
    focusLocked === undefined &&
    cursorRestored === undefined &&
    !frameSize &&
    !relativePoint &&
    !relativeFromPoint &&
    !relativeToPoint &&
    !absolutePoint &&
    !absoluteFromPoint &&
    !absoluteToPoint &&
    deltaX === undefined &&
    deltaY === undefined &&
    observationAgeMs === undefined &&
    !executedAt
  ) {
    return undefined;
  }
  return {
    ...(scopeType ? { scopeType } : {}),
    ...(targetKind ? { targetKind } : {}),
    ...(targetId ? { targetId } : {}),
    ...(observationId ? { observationId } : {}),
    ...(mappingSource ? { mappingSource } : {}),
    ...(interactionMode ? { interactionMode } : {}),
    ...(inputBackend ? { inputBackend } : {}),
    ...(semanticPath ? { semanticPath } : {}),
    ...(typeof selectorAttempted === "boolean" ? { selectorAttempted } : {}),
    ...(typeof selectorMatched === "boolean" ? { selectorMatched } : {}),
    ...(fallbackReason ? { fallbackReason } : {}),
    ...(typeof focusLocked === "boolean" ? { focusLocked } : {}),
    ...(typeof cursorRestored === "boolean" ? { cursorRestored } : {}),
    ...(frameSize ? { frameSize } : {}),
    ...(relativePoint ? { relativePoint } : {}),
    ...(relativeFromPoint ? { relativeFromPoint } : {}),
    ...(relativeToPoint ? { relativeToPoint } : {}),
    ...(absolutePoint ? { absolutePoint } : {}),
    ...(absoluteFromPoint ? { absoluteFromPoint } : {}),
    ...(absoluteToPoint ? { absoluteToPoint } : {}),
    ...(typeof deltaX === "number" ? { deltaX } : {}),
    ...(typeof deltaY === "number" ? { deltaY } : {}),
    ...(typeof observationAgeMs === "number" ? { observationAgeMs } : {}),
    ...(executedAt ? { executedAt } : {}),
  };
}

function mergeDiagnostics(params: {
  capture?: GatewayComputerCapturePayload | null;
  postActionCapture?: GatewayComputerCapturePayload | null;
  action?: GatewayComputerActionPayload | null;
}): ComputerUseDiagnostics | undefined {
  const capture = buildCaptureDiagnosticsFromGatewayPayload(params.capture);
  const postActionCapture = buildCaptureDiagnosticsFromGatewayPayload(params.postActionCapture);
  const action = buildActionDiagnosticsFromGatewayPayload(params.action);
  if (!capture && !postActionCapture && !action) {
    return undefined;
  }
  return {
    ...(capture ? { capture } : {}),
    ...(postActionCapture ? { postActionCapture } : {}),
    ...(action ? { action } : {}),
  };
}

function buildResolvedObservationTarget(params: {
  scope: ComputerUseScope;
  observation?: ComputerUseObservation;
}): {
  scopeType: string;
  targetId?: string;
  windowId?: string;
  displayId?: string;
  observationId?: string;
} {
  const targetKind = normalizeOptionalString(params.observation?.targetKind);
  const targetId = normalizeOptionalString(params.observation?.targetId);
  const windowId = normalizeOptionalString(params.observation?.windowId);
  const displayId = normalizeOptionalString(params.observation?.displayId);
  const observationId = normalizeOptionalString(params.observation?.observationId);
  if ((targetKind === "window" || windowId) && windowId) {
    return {
      scopeType: "window",
      ...(targetId ? { targetId } : {}),
      windowId,
      ...(observationId ? { observationId } : {}),
    };
  }
  if (targetKind === "display" || displayId) {
    return {
      scopeType: "display",
      ...(targetId ? { targetId } : {}),
      ...(displayId ? { displayId } : {}),
      ...(observationId ? { observationId } : {}),
    };
  }
  if (targetKind === "desktop") {
    return {
      scopeType: "full_desktop",
      ...(targetId ? { targetId } : {}),
      ...(observationId ? { observationId } : {}),
    };
  }
  return {
    scopeType: params.scope.type,
    ...(targetId ? { targetId } : {}),
    ...(normalizeOptionalString(params.scope.windowId) ? { windowId: params.scope.windowId } : {}),
    ...(normalizeOptionalString(params.scope.displayId)
      ? { displayId: params.scope.displayId }
      : {}),
    ...(observationId ? { observationId } : {}),
  };
}

function buildCurrentWindowTargetRequest(): { scopeType: string } {
  return { scopeType: "current_window" };
}

type ComputerUseCaptureTargetRequest = {
  scopeType: string;
  targetId?: string;
  windowId?: string;
  displayId?: string;
  observationId?: string;
};

function buildActionCommandTarget(params: {
  action: ComputerUseAction;
  scope: ComputerUseScope;
  observation?: ComputerUseObservation;
  args: Record<string, unknown>;
}): {
  scopeType?: string;
  targetId?: string;
  windowId?: string;
  displayId?: string;
  observationId?: string;
} {
  const explicitTargetId = normalizeOptionalString(readStringParam(params.args, "targetId"));
  if (params.action === "focus_window") {
    const explicitWindowId = normalizeOptionalString(readStringParam(params.args, "windowId"));
    if (explicitWindowId) {
      return {
        scopeType: "window",
        ...(explicitTargetId ? { targetId: explicitTargetId } : {}),
        windowId: explicitWindowId,
      };
    }
    return explicitTargetId ? { targetId: explicitTargetId } : {};
  }
  if (explicitTargetId) {
    return {
      ...buildResolvedObservationTarget({
        scope: params.scope,
        observation: params.observation,
      }),
      targetId: explicitTargetId,
    };
  }
  return buildResolvedObservationTarget({
    scope: params.scope,
    observation: params.observation,
  });
}

function trimModelText(value: string | undefined, maxLength = 240): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
}

function buildRect(
  value:
    | {
        x?: number;
        y?: number;
        width?: number;
        height?: number;
      }
    | null
    | undefined,
) {
  if (
    typeof value?.x !== "number" ||
    typeof value?.y !== "number" ||
    typeof value?.width !== "number" ||
    typeof value?.height !== "number"
  ) {
    return undefined;
  }
  return {
    x: value.x,
    y: value.y,
    width: value.width,
    height: value.height,
  };
}

function buildWindowTarget(
  payload: GatewayComputerTargetWindowPayload | null | undefined,
): ComputerUseWindowTarget | undefined {
  const windowId = normalizeOptionalString(payload?.windowId);
  const appName = normalizeOptionalString(payload?.appName);
  if (!windowId || !appName) {
    return undefined;
  }
  const rect = buildRect(payload?.rect);
  return {
    targetId: normalizeOptionalString(payload?.targetId) ?? undefined,
    kind: "window",
    windowId,
    appName,
    bundleId: normalizeOptionalString(payload?.bundleId) ?? undefined,
    ...(typeof payload?.processId === "number" ? { processId: payload.processId } : {}),
    windowTitle: trimModelText(payload?.windowTitle ?? undefined, 200),
    monitorId: normalizeOptionalString(payload?.monitorId) ?? undefined,
    ...(typeof payload?.isFocused === "boolean" ? { isFocused: payload.isFocused } : {}),
    ...(typeof payload?.isMinimized === "boolean" ? { isMinimized: payload.isMinimized } : {}),
    ...(typeof payload?.isMaximized === "boolean" ? { isMaximized: payload.isMaximized } : {}),
    ...(rect ? { rect } : {}),
  };
}

function buildAppTarget(
  payload: GatewayComputerTargetAppPayload | null | undefined,
): ComputerUseAppTarget | undefined {
  const appName = normalizeOptionalString(payload?.appName);
  if (!appName || typeof payload?.processId !== "number") {
    return undefined;
  }
  return {
    targetId: normalizeOptionalString(payload?.targetId) ?? undefined,
    kind: "app",
    appName,
    processId: payload.processId,
    bundleId: normalizeOptionalString(payload?.bundleId) ?? undefined,
    ...(typeof payload?.isFrontmost === "boolean" ? { isFrontmost: payload.isFrontmost } : {}),
    ...(typeof payload?.isHidden === "boolean" ? { isHidden: payload.isHidden } : {}),
    activationPolicy: normalizeOptionalString(payload?.activationPolicy) ?? undefined,
    ...(typeof payload?.visibleWindowCount === "number"
      ? { visibleWindowCount: payload.visibleWindowCount }
      : {}),
    ...(toGatewayStringArray(payload?.visibleWindowIds)?.length
      ? { visibleWindowIds: toGatewayStringArray(payload?.visibleWindowIds) }
      : {}),
  };
}

function buildDisplayTarget(
  payload: GatewayComputerTargetDisplayPayload | null | undefined,
): NonNullable<ComputerUseTargetCatalog["displays"]>[number] | undefined {
  const displayId = normalizeOptionalString(payload?.displayId);
  if (!displayId) {
    return undefined;
  }
  return {
    targetId: normalizeOptionalString(payload?.targetId) ?? undefined,
    kind: "display",
    displayId,
    ...(trimModelText(payload?.name ?? undefined, 120)
      ? { name: trimModelText(payload?.name ?? undefined, 120) }
      : {}),
    ...(typeof payload?.isPrimary === "boolean" ? { isPrimary: payload.isPrimary } : {}),
    ...(typeof payload?.isBuiltin === "boolean" ? { isBuiltin: payload.isBuiltin } : {}),
    ...(typeof payload?.scaleFactor === "number" ? { scaleFactor: payload.scaleFactor } : {}),
    ...(buildRect(payload?.rect) ? { rect: buildRect(payload?.rect) } : {}),
  };
}

function buildCdpPage(
  payload: GatewayComputerCdpPagePayload | null | undefined,
):
  | NonNullable<NonNullable<ComputerUseTargetCatalog["cdpEndpoints"]>[number]["pages"]>[number]
  | undefined {
  const pageId =
    normalizeOptionalString(payload?.pageId) ??
    normalizeOptionalString(payload?.page_id) ??
    normalizeOptionalString(payload?.id);
  if (!pageId) {
    return undefined;
  }
  return {
    pageId,
    pageType:
      normalizeOptionalString(payload?.pageType) ??
      normalizeOptionalString(payload?.page_type) ??
      normalizeOptionalString(payload?.type) ??
      undefined,
    title: trimModelText(payload?.title ?? undefined, 160) || undefined,
    url: trimModelText(payload?.url ?? undefined, 260) || undefined,
    webSocketDebuggerUrl:
      normalizeOptionalString(payload?.webSocketDebuggerUrl) ??
      normalizeOptionalString(payload?.web_socket_debugger_url) ??
      undefined,
  };
}

function buildCdpEndpoint(
  payload: GatewayComputerCdpEndpointPayload | null | undefined,
): NonNullable<ComputerUseTargetCatalog["cdpEndpoints"]>[number] | undefined {
  const endpointId =
    normalizeOptionalString(payload?.endpointId) ?? normalizeOptionalString(payload?.endpoint_id);
  const host = normalizeOptionalString(payload?.host);
  if (!endpointId || !host || typeof payload?.port !== "number") {
    return undefined;
  }
  const pages =
    payload.pages
      ?.map((item) => buildCdpPage(item))
      .filter(
        (
          item,
        ): item is NonNullable<
          NonNullable<ComputerUseTargetCatalog["cdpEndpoints"]>[number]["pages"]
        >[number] => Boolean(item),
      ) ?? [];
  return {
    endpointId,
    kind: "cdp",
    host,
    port: payload.port,
    browser: trimModelText(payload?.browser ?? undefined, 160) || undefined,
    protocolVersion:
      normalizeOptionalString(payload?.protocolVersion) ??
      normalizeOptionalString(payload?.protocol_version) ??
      undefined,
    webSocketDebuggerUrl:
      normalizeOptionalString(payload?.webSocketDebuggerUrl) ??
      normalizeOptionalString(payload?.web_socket_debugger_url) ??
      undefined,
    pageCount:
      typeof payload?.pageCount === "number"
        ? payload.pageCount
        : typeof payload?.page_count === "number"
          ? payload.page_count
          : pages.length,
    ...(pages.length > 0 ? { pages } : {}),
    discoveredAt:
      normalizeOptionalString(payload?.discoveredAt) ??
      normalizeOptionalString(payload?.discovered_at) ??
      undefined,
  };
}

function buildTargetCatalog(
  payload: GatewayComputerTargetCatalogPayload | null | undefined,
): ComputerUseTargetCatalog | undefined {
  if (!payload) {
    return undefined;
  }
  const displays =
    payload.displays
      ?.map((item) => buildDisplayTarget(item))
      .filter((item): item is NonNullable<ComputerUseTargetCatalog["displays"]>[number] =>
        Boolean(item),
      ) ?? [];
  const windows =
    payload.windows
      ?.map((item) => buildWindowTarget(item))
      .filter((item): item is ComputerUseWindowTarget => Boolean(item)) ?? [];
  const apps =
    payload.apps
      ?.map((item) => buildAppTarget(item))
      .filter((item): item is ComputerUseAppTarget => Boolean(item)) ?? [];
  const cdpEndpoints =
    (payload.cdpEndpoints ?? payload.cdp_endpoints)
      ?.map((item) => buildCdpEndpoint(item))
      .filter((item): item is NonNullable<ComputerUseTargetCatalog["cdpEndpoints"]>[number] =>
        Boolean(item),
      ) ?? [];
  const generatedAt = normalizeOptionalString(payload.generatedAt) ?? undefined;
  const desktopTargetId = normalizeOptionalString(payload.desktopTargetId) ?? undefined;
  if (
    !generatedAt &&
    !desktopTargetId &&
    displays.length === 0 &&
    windows.length === 0 &&
    apps.length === 0 &&
    cdpEndpoints.length === 0
  ) {
    return undefined;
  }
  return {
    ...(generatedAt ? { generatedAt } : {}),
    ...(desktopTargetId ? { desktopTargetId } : {}),
    ...(displays.length > 0 ? { displays } : {}),
    windows,
    apps,
    ...(cdpEndpoints.length > 0 ? { cdpEndpoints } : {}),
  };
}

function buildAxNode(
  node: GatewayComputerAxNodePayload | null | undefined,
): ComputerUseAxNode | undefined {
  const role = normalizeOptionalString(node?.role);
  if (!role) {
    return undefined;
  }
  const children = Array.isArray(node?.children)
    ? node.children
        .map((child) => buildAxNode(child))
        .filter((child): child is ComputerUseAxNode => Boolean(child))
    : [];
  return {
    id: normalizeOptionalString(node?.id) ?? `${role}:${crypto.randomUUID()}`,
    path: toGatewayNumberArray(node?.path),
    role,
    subrole: normalizeOptionalString(node?.subrole) ?? undefined,
    axIdentifier:
      normalizeOptionalString(node?.axIdentifier) ??
      normalizeOptionalString(node?.ax_identifier) ??
      undefined,
    label: trimModelText(node?.label ?? undefined, 160),
    value: trimModelText(node?.value ?? undefined, 220),
    description: trimModelText(node?.description ?? undefined, 220),
    help: trimModelText(node?.help ?? undefined, 220),
    url: trimModelText(node?.url ?? undefined, 320),
    rect: buildRect(node?.rect),
    ...(typeof node?.enabled === "boolean" ? { enabled: node.enabled } : {}),
    ...(typeof node?.focused === "boolean" ? { focused: node.focused } : {}),
    ...(typeof node?.selected === "boolean" ? { selected: node.selected } : {}),
    ...(typeof node?.expanded === "boolean" ? { expanded: node.expanded } : {}),
    ...(typeof node?.editable === "boolean" ? { editable: node.editable } : {}),
    actions: toGatewayStringArray(node?.actions),
    rolePath: toGatewayStringArray(node?.rolePath ?? node?.role_path),
    labelPath: toGatewayStringArray(node?.labelPath ?? node?.label_path),
    ...(children.length > 0 ? { children } : {}),
  };
}

function buildPerceptionSnapshotContext(
  payload: GatewayComputerPerceptionContextPayload | null | undefined,
): {
  targetKind?: ComputerUseObservation["targetKind"];
  targetId?: string;
  observationId?: string;
  bundleId?: string;
  displayId?: string;
  target?: ComputerUseTargetBinding;
  diagnostics?: ComputerUseDiagnostics;
} {
  const diagnosticsCapture = buildCaptureDiagnosticsFromGatewayPayload(payload);
  const target = buildTargetBindingFromGatewayPayload(payload);
  const targetId =
    target?.targetId ??
    normalizeOptionalString(diagnosticsCapture?.targetId) ??
    normalizeOptionalString(payload?.targetId) ??
    undefined;
  const targetKind =
    target?.kind ??
    diagnosticsCapture?.targetKind ??
    normalizeCaptureTargetKind(payload?.targetKind) ??
    inferTargetKindFromTargetId(targetId);
  const observationId =
    normalizeOptionalString(diagnosticsCapture?.observationId) ??
    normalizeOptionalString(payload?.observationId) ??
    undefined;
  const bundleId =
    normalizeOptionalString(target?.app?.bundleId) ??
    normalizeOptionalString(diagnosticsCapture?.bundleId) ??
    normalizeOptionalString(payload?.bundleId) ??
    undefined;
  const displayId =
    normalizeOptionalString(target?.display?.displayId) ??
    normalizeOptionalString(diagnosticsCapture?.displayId) ??
    normalizeOptionalString(payload?.displayId) ??
    undefined;
  const diagnostics = diagnosticsCapture ? { capture: diagnosticsCapture } : undefined;

  return {
    ...(targetKind ? { targetKind } : {}),
    ...(targetId ? { targetId } : {}),
    ...(observationId ? { observationId } : {}),
    ...(bundleId ? { bundleId } : {}),
    ...(displayId ? { displayId } : {}),
    ...(target ? { target } : {}),
    ...(diagnostics ? { diagnostics } : {}),
  };
}

function buildAxSnapshot(
  payload: GatewayComputerAxPayload | null | undefined,
): ComputerUseAxSnapshot | undefined {
  if (!payload) {
    return undefined;
  }
  const context = buildPerceptionSnapshotContext(payload);
  const nodes = Array.isArray(payload.nodes)
    ? payload.nodes
        .map((node) => buildAxNode(node))
        .filter((node): node is ComputerUseAxNode => Boolean(node))
    : [];
  const windowId =
    normalizeOptionalString(payload.windowId) ??
    normalizeOptionalString(context.target?.window?.windowId) ??
    normalizeOptionalString(context.diagnostics?.capture?.windowId) ??
    undefined;
  const appName =
    normalizeOptionalString(payload.appName) ??
    normalizeOptionalString(context.target?.app?.appName) ??
    normalizeOptionalString(context.diagnostics?.capture?.appName) ??
    undefined;
  const windowTitle =
    trimModelText(payload.windowTitle ?? undefined, 200) ??
    trimModelText(context.target?.window?.title, 200) ??
    trimModelText(context.diagnostics?.capture?.windowTitle, 200);
  if (
    payload.supported !== true &&
    !normalizeOptionalString(payload.message) &&
    nodes.length === 0 &&
    !windowId &&
    !appName &&
    !context.targetId &&
    !context.observationId
  ) {
    return undefined;
  }
  return {
    supported: payload.supported === true,
    ...context,
    permissionState: normalizeOptionalString(payload.permissionState) ?? undefined,
    ...(windowId ? { windowId } : {}),
    ...(appName ? { appName } : {}),
    ...(windowTitle ? { windowTitle } : {}),
    ...(typeof payload.targetMatched === "boolean" ? { targetMatched: payload.targetMatched } : {}),
    ...(typeof payload.nodeCount === "number" ? { nodeCount: payload.nodeCount } : {}),
    ...(typeof payload.truncated === "boolean" ? { truncated: payload.truncated } : {}),
    selectedText: trimModelText(payload.selectedText ?? undefined, 320),
    nodes,
    message: trimModelText(payload.message ?? undefined, 320),
  };
}

function buildOcrRegion(
  payload: GatewayComputerOcrRegionPayload | null | undefined,
): ComputerUseOcrRegion | undefined {
  const text = trimModelText(payload?.text ?? undefined, 320);
  const rect = buildRect(payload?.rect);
  if (!text || !rect) {
    return undefined;
  }
  return {
    id: normalizeOptionalString(payload?.id) ?? `ocr:${crypto.randomUUID()}`,
    text,
    ...(typeof payload?.confidence === "number" ? { confidence: payload.confidence } : {}),
    rect,
  };
}

function buildOcrSnapshot(
  payload: GatewayComputerOcrPayload | null | undefined,
): ComputerUseOcrSnapshot | undefined {
  if (!payload) {
    return undefined;
  }
  const context = buildPerceptionSnapshotContext(payload);
  const regions = Array.isArray(payload.regions)
    ? payload.regions
        .map((item) => buildOcrRegion(item))
        .filter((item): item is ComputerUseOcrRegion => Boolean(item))
    : [];
  const fullText = trimModelText(payload.fullText ?? undefined, 1200);
  const message = trimModelText(payload.message ?? undefined, 320);
  const appName =
    normalizeOptionalString(payload.appName) ??
    normalizeOptionalString(context.target?.app?.appName) ??
    normalizeOptionalString(context.diagnostics?.capture?.appName) ??
    undefined;
  const bundleId =
    normalizeOptionalString(payload.bundleId) ??
    normalizeOptionalString(context.bundleId) ??
    normalizeOptionalString(context.diagnostics?.capture?.bundleId) ??
    undefined;
  const windowId =
    normalizeOptionalString(payload.windowId) ??
    normalizeOptionalString(context.target?.window?.windowId) ??
    normalizeOptionalString(context.diagnostics?.capture?.windowId) ??
    undefined;
  const windowTitle =
    trimModelText(payload.windowTitle ?? undefined, 200) ??
    trimModelText(context.target?.window?.title, 200) ??
    trimModelText(context.diagnostics?.capture?.windowTitle, 200);
  if (
    payload.supported !== true &&
    !normalizeOptionalString(payload.engine) &&
    regions.length === 0 &&
    !fullText &&
    !message &&
    !context.targetId &&
    !context.observationId
  ) {
    return undefined;
  }
  return {
    supported: payload.supported === true,
    ...context,
    engine: normalizeOptionalString(payload.engine) ?? undefined,
    ...(appName ? { appName } : {}),
    ...(bundleId ? { bundleId } : {}),
    ...(windowId ? { windowId } : {}),
    ...(windowTitle ? { windowTitle } : {}),
    ...(typeof payload.regionCount === "number" ? { regionCount: payload.regionCount } : {}),
    ...(typeof payload.truncated === "boolean" ? { truncated: payload.truncated } : {}),
    ...(fullText ? { fullText } : {}),
    regions,
    ...(message ? { message } : {}),
  };
}

function buildCdpNode(
  payload: GatewayComputerCdpNodePayload | null | undefined,
): ComputerUseCdpNode | undefined {
  const id = normalizeOptionalString(payload?.id);
  const role = normalizeOptionalString(payload?.role);
  const label = trimModelText(payload?.label ?? undefined, 180);
  if (!id || !role || !label) {
    return undefined;
  }
  return {
    id,
    role,
    label,
    selectorPath:
      normalizeOptionalString(payload?.selectorPath) ??
      normalizeOptionalString(payload?.selector_path) ??
      undefined,
    tagName:
      normalizeOptionalString(payload?.tagName) ??
      normalizeOptionalString(payload?.tag_name) ??
      undefined,
    inputType:
      normalizeOptionalString(payload?.inputType) ??
      normalizeOptionalString(payload?.input_type) ??
      undefined,
    text: trimModelText(payload?.text ?? undefined, 240) || undefined,
    href: trimModelText(payload?.href ?? undefined, 260) || undefined,
    ...(buildRect(payload?.rect) ? { rect: buildRect(payload?.rect) } : {}),
    ...(buildRect(payload?.cssRect ?? payload?.css_rect)
      ? { cssRect: buildRect(payload?.cssRect ?? payload?.css_rect) }
      : {}),
    coordinateMapping:
      normalizeOptionalString(payload?.coordinateMapping) ??
      normalizeOptionalString(payload?.coordinate_mapping) ??
      undefined,
    ...(typeof payload?.enabled === "boolean" ? { enabled: payload.enabled } : {}),
    ...(typeof payload?.editable === "boolean" ? { editable: payload.editable } : {}),
    ...(toGatewayStringArray(payload?.actionCapabilities ?? payload?.action_capabilities)?.length
      ? {
          actionCapabilities: toGatewayStringArray(
            payload?.actionCapabilities ?? payload?.action_capabilities,
          ),
        }
      : {}),
  };
}

function buildCdpSnapshot(
  payload: GatewayComputerCdpPayload | null | undefined,
): ComputerUseCdpSnapshot | undefined {
  if (!payload) {
    return undefined;
  }
  const context = buildPerceptionSnapshotContext(payload);
  const nodes = Array.isArray(payload.nodes)
    ? payload.nodes
        .map((item) => buildCdpNode(item))
        .filter((item): item is ComputerUseCdpNode => Boolean(item))
    : [];
  const message = trimModelText(payload.message ?? undefined, 320);
  const engine = normalizeOptionalString(payload.engine) ?? undefined;
  if (payload.supported !== true && !engine && nodes.length === 0 && !message) {
    return undefined;
  }
  return {
    supported: payload.supported === true,
    ...context,
    ...(engine ? { engine } : {}),
    endpointId:
      normalizeOptionalString(payload.endpointId) ??
      normalizeOptionalString(payload.endpoint_id) ??
      undefined,
    browser: trimModelText(payload.browser ?? undefined, 160) || undefined,
    protocolVersion:
      normalizeOptionalString(payload.protocolVersion) ??
      normalizeOptionalString(payload.protocol_version) ??
      undefined,
    pageId:
      normalizeOptionalString(payload.pageId) ??
      normalizeOptionalString(payload.page_id) ??
      undefined,
    pageTitle:
      trimModelText(payload.pageTitle ?? payload.page_title ?? undefined, 200) || undefined,
    pageUrl: trimModelText(payload.pageUrl ?? payload.page_url ?? undefined, 320) || undefined,
    viewport: payload.viewport
      ? {
          ...(typeof payload.viewport.innerWidth === "number"
            ? { innerWidth: payload.viewport.innerWidth }
            : {}),
          ...(typeof payload.viewport.innerHeight === "number"
            ? { innerHeight: payload.viewport.innerHeight }
            : {}),
          ...(typeof payload.viewport.outerWidth === "number"
            ? { outerWidth: payload.viewport.outerWidth }
            : {}),
          ...(typeof payload.viewport.outerHeight === "number"
            ? { outerHeight: payload.viewport.outerHeight }
            : {}),
          ...(typeof payload.viewport.screenX === "number"
            ? { screenX: payload.viewport.screenX }
            : {}),
          ...(typeof payload.viewport.screenY === "number"
            ? { screenY: payload.viewport.screenY }
            : {}),
          ...(typeof payload.viewport.scrollX === "number"
            ? { scrollX: payload.viewport.scrollX }
            : {}),
          ...(typeof payload.viewport.scrollY === "number"
            ? { scrollY: payload.viewport.scrollY }
            : {}),
          ...(typeof payload.viewport.devicePixelRatio === "number"
            ? { devicePixelRatio: payload.viewport.devicePixelRatio }
            : {}),
        }
      : undefined,
    nodeCount:
      typeof payload.nodeCount === "number"
        ? payload.nodeCount
        : typeof payload.node_count === "number"
          ? payload.node_count
          : nodes.length,
    ...(typeof payload.truncated === "boolean" ? { truncated: payload.truncated } : {}),
    coordinateMapping:
      normalizeOptionalString(payload.coordinateMapping) ??
      normalizeOptionalString(payload.coordinate_mapping) ??
      undefined,
    nodes,
    ...(message ? { message } : {}),
  };
}

export {
  buildActionCommandTarget,
  buildAxSnapshot,
  buildCdpSnapshot,
  buildCurrentWindowTargetRequest,
  buildFrameRef,
  buildObservation,
  buildOcrSnapshot,
  buildResolvedObservationTarget,
  buildTargetBindingFromGatewayPayload,
  buildTargetCatalog,
  mergeDiagnostics,
};

export type { ComputerUseCaptureTargetRequest };

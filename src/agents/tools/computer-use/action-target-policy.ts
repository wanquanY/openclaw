import type { ComputerUseAction } from "../../../computer-use/types.js";
import { normalizeOptionalString } from "../../../shared/string-coerce.js";
import { readStringParam } from "../common.js";
import type { GatewayComputerActionPayload } from "./gateway-payloads.js";
import { lookupRememberedComputerUseObservation } from "./perception.js";

export function actionCanLeaseFocusedSurface(action: ComputerUseAction): boolean {
  return action !== "observe" && action !== "focus_window" && action !== "wait";
}

export function actionShouldObserveFocusedSurfaceByDefault(action: ComputerUseAction): boolean {
  return action === "type" || action === "set_text_submit" || action === "hotkey";
}

export function buildPreActionFocusPayload(params: {
  action: ComputerUseAction;
  args: Record<string, unknown>;
  sessionKey?: string;
  agentId?: string;
}): Record<string, unknown> | undefined {
  if (!actionCanLeaseFocusedSurface(params.action)) {
    return undefined;
  }
  const targetId = normalizeOptionalString(readStringParam(params.args, "targetId"));
  const windowId = normalizeOptionalString(readStringParam(params.args, "windowId"));
  const appName = normalizeOptionalString(readStringParam(params.args, "appName"));
  const bundleId = normalizeOptionalString(readStringParam(params.args, "bundleId"));
  const rememberedObservation = lookupRememberedComputerUseObservation({
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    targetId,
    windowId,
    appName,
    bundleId,
  });
  const resolvedAppName = appName ?? normalizeOptionalString(rememberedObservation?.appName);
  const resolvedBundleId = bundleId ?? normalizeOptionalString(rememberedObservation?.bundleId);
  const resolvedWindowId = windowId ?? normalizeOptionalString(rememberedObservation?.windowId);
  if (!targetId && !resolvedWindowId && !resolvedAppName && !resolvedBundleId) {
    return undefined;
  }
  if (resolvedAppName || resolvedBundleId) {
    return {
      action: "focus_window",
      ...(resolvedAppName ? { appName: resolvedAppName } : {}),
      ...(resolvedBundleId ? { bundleId: resolvedBundleId } : {}),
    };
  }
  if (resolvedWindowId) {
    return {
      action: "focus_window",
      windowId: resolvedWindowId,
    };
  }
  return targetId
    ? {
        action: "focus_window",
        targetId,
      }
    : undefined;
}

export function mergePreActionFocusResultIntoActionArgs(params: {
  args: Record<string, unknown>;
  focusPayload: GatewayComputerActionPayload;
}): Record<string, unknown> {
  const focusedWindowId = normalizeOptionalString(params.focusPayload.windowId);
  const focusedTargetId = focusedWindowId ? `window:${focusedWindowId}` : undefined;
  const { targetId: _staleTargetId, windowId: _staleWindowId, ...baseArgs } = params.args;
  return {
    ...baseArgs,
    ...(normalizeOptionalString(params.focusPayload.appName)
      ? { appName: normalizeOptionalString(params.focusPayload.appName) }
      : {}),
    ...(normalizeOptionalString(params.focusPayload.bundleId)
      ? { bundleId: normalizeOptionalString(params.focusPayload.bundleId) }
      : {}),
    ...(focusedWindowId ? { windowId: focusedWindowId } : {}),
    ...(focusedTargetId ? { targetId: focusedTargetId } : {}),
  };
}

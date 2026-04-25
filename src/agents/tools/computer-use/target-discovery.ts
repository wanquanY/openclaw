import type {
  ComputerUseAppTarget,
  ComputerUseTargetCatalog,
  ComputerUseWindowTarget,
} from "../../../computer-use/types.js";
import { normalizeOptionalString } from "../../../shared/string-coerce.js";
import { readStringParam } from "../common.js";
import { buildTargetCatalog } from "./gateway-normalizers.js";
import type { GatewayComputerTargetCatalogPayload } from "./gateway-payloads.js";
import { normalizeTargetLookupValue, type PreparedComputerUseFocusIntent } from "./perception.js";

type ComputerUseClientCommandInvoker = <TPayload>(params: {
  sessionKey?: string;
  command: string;
  payload?: Record<string, unknown>;
  timeoutMs?: number;
}) => Promise<TPayload>;

async function discoverComputerUseTargets(params: {
  invokeClientCommand: ComputerUseClientCommandInvoker;
  sessionKey?: string;
  timeoutMs?: number;
}): Promise<ComputerUseTargetCatalog | undefined> {
  const payload = await params.invokeClientCommand<GatewayComputerTargetCatalogPayload>({
    sessionKey: params.sessionKey,
    command: "computer.targets",
    timeoutMs: params.timeoutMs,
  });
  return buildTargetCatalog(payload);
}

function pickPreferredWindowTarget(
  matches: ComputerUseWindowTarget[],
): ComputerUseWindowTarget | undefined {
  if (matches.length === 1) {
    return matches[0];
  }
  const focused = matches.filter((item) => item.isFocused === true);
  if (focused.length === 1) {
    return focused[0];
  }
  return undefined;
}

function matchFocusWindowTargets(params: {
  targets: ComputerUseTargetCatalog;
  appName?: string;
  bundleId?: string;
}): {
  windows: ComputerUseWindowTarget[];
  apps: ComputerUseAppTarget[];
} {
  const requestedBundleId = normalizeTargetLookupValue(params.bundleId);
  const requestedAppName = normalizeTargetLookupValue(params.appName);
  const bundleMatches = requestedBundleId
    ? params.targets.windows.filter(
        (item) => normalizeTargetLookupValue(item.bundleId) === requestedBundleId,
      )
    : [];
  const appMatches = requestedAppName
    ? params.targets.windows.filter(
        (item) => normalizeTargetLookupValue(item.appName) === requestedAppName,
      )
    : [];
  const windows = (bundleMatches.length > 0 ? bundleMatches : appMatches).toSorted(
    (left, right) => Number(right.isFocused === true) - Number(left.isFocused === true),
  );

  const matchedApps = (
    requestedBundleId
      ? params.targets.apps.filter(
          (item) => normalizeTargetLookupValue(item.bundleId) === requestedBundleId,
        )
      : []
  ).concat(
    requestedBundleId || !requestedAppName
      ? []
      : params.targets.apps.filter(
          (item) => normalizeTargetLookupValue(item.appName) === requestedAppName,
        ),
  );
  const dedupedApps = matchedApps
    .filter((item, index, all) => {
      const key = `${normalizeTargetLookupValue(item.bundleId) ?? ""}|${item.processId}`;
      return (
        all.findIndex(
          (candidate) =>
            `${normalizeTargetLookupValue(candidate.bundleId) ?? ""}|${candidate.processId}` ===
            key,
        ) === index
      );
    })
    .toSorted(
      (left, right) => Number(right.isFrontmost === true) - Number(left.isFrontmost === true),
    );

  return {
    windows,
    apps: dedupedApps,
  };
}

async function prepareFocusWindowTarget(params: {
  invokeClientCommand: ComputerUseClientCommandInvoker;
  args: Record<string, unknown>;
  sessionKey?: string;
  timeoutMs?: number;
}): Promise<PreparedComputerUseFocusIntent> {
  const explicitTargetId = normalizeOptionalString(readStringParam(params.args, "targetId"));
  const explicitWindowId = normalizeOptionalString(readStringParam(params.args, "windowId"));
  const explicitAppName = normalizeOptionalString(readStringParam(params.args, "appName"));
  const explicitBundleId = normalizeOptionalString(readStringParam(params.args, "bundleId"));
  let targets: ComputerUseTargetCatalog | undefined;
  try {
    targets = await discoverComputerUseTargets({
      invokeClientCommand: params.invokeClientCommand,
      sessionKey: params.sessionKey,
      timeoutMs: params.timeoutMs,
    });
  } catch (error) {
    return {
      ok: false,
      summary: "Desktop target discovery failed before focusing a window.",
      error:
        error instanceof Error
          ? error.message
          : "The host failed to enumerate running apps and windows for focus_window.",
      warning:
        "Retry discover_targets after the desktop host is ready, then focus using a real appName, bundleId, or windowId.",
    };
  }

  if (explicitTargetId) {
    const matchedWindow = targets?.windows.find(
      (item) =>
        normalizeTargetLookupValue(item.targetId) === normalizeTargetLookupValue(explicitTargetId),
    );
    if (matchedWindow) {
      return {
        ok: true,
        args: {
          ...params.args,
          targetId: matchedWindow.targetId ?? explicitTargetId,
          appName: matchedWindow.appName,
          ...(matchedWindow.bundleId ? { bundleId: matchedWindow.bundleId } : {}),
          windowId: matchedWindow.windowId,
        },
        focusTarget: {
          targetId: matchedWindow.targetId ?? explicitTargetId,
          appName: matchedWindow.appName,
          bundleId: matchedWindow.bundleId,
          windowId: matchedWindow.windowId,
        },
        targets,
      };
    }
    const matchedApp = targets?.apps.find(
      (item) =>
        normalizeTargetLookupValue(item.targetId) === normalizeTargetLookupValue(explicitTargetId),
    );
    if (matchedApp) {
      return {
        ok: true,
        args: {
          ...params.args,
          targetId: matchedApp.targetId ?? explicitTargetId,
          appName: matchedApp.appName,
          ...(matchedApp.bundleId ? { bundleId: matchedApp.bundleId } : {}),
        },
        focusTarget: {
          targetId: matchedApp.targetId ?? explicitTargetId,
          appName: matchedApp.appName,
          bundleId: matchedApp.bundleId,
        },
        targets,
      };
    }
    return {
      ok: false,
      summary: "Requested focus target was not found on this device.",
      error:
        `No running app or visible window matched targetId=${explicitTargetId}. ` +
        "Retry discover_targets and use a current targetId from the device target catalog.",
      targets,
      warning: "Use targetId values exactly as returned by discover_targets.",
    };
  }

  if (explicitWindowId) {
    const matchedWindow = targets?.windows.find(
      (item) =>
        normalizeTargetLookupValue(item.windowId) === normalizeTargetLookupValue(explicitWindowId),
    );
    if (!matchedWindow) {
      return {
        ok: false,
        summary: "Requested focus target was not found on this device.",
        error:
          `No visible desktop window matched windowId=${explicitWindowId}. ` +
          "Retry with a real windowId, appName, or bundleId from the current device target catalog.",
        targets,
        warning:
          "Use the returned device target catalog for focus_window. Do not guess windowId values.",
      };
    }
    return {
      ok: true,
      args: {
        ...params.args,
        ...(matchedWindow.targetId ? { targetId: matchedWindow.targetId } : {}),
        appName: matchedWindow.appName,
        ...(matchedWindow.bundleId ? { bundleId: matchedWindow.bundleId } : {}),
        windowId: matchedWindow.windowId,
      },
      focusTarget: {
        ...(matchedWindow.targetId ? { targetId: matchedWindow.targetId } : {}),
        appName: matchedWindow.appName,
        bundleId: matchedWindow.bundleId,
        windowId: matchedWindow.windowId,
      },
      targets,
    };
  }

  if (!explicitAppName && !explicitBundleId) {
    return {
      ok: false,
      summary: "focus_window requires a real device target.",
      error:
        "focus_window must provide targetId, appName, bundleId, or windowId from the current device target catalog.",
      targets,
      warning:
        "Call discover_targets or use the available targets returned below before retrying focus_window.",
    };
  }

  if (!targets || (targets.windows.length === 0 && targets.apps.length === 0)) {
    return {
      ok: false,
      summary: "No desktop targets are currently discoverable.",
      error:
        "The host returned no running apps or visible windows, so focus_window cannot resolve a real target.",
      targets,
      warning: "Retry after the target app is running and visible on the desktop.",
    };
  }

  const matches = matchFocusWindowTargets({
    targets,
    appName: explicitAppName,
    bundleId: explicitBundleId,
  });
  const preferredWindow = pickPreferredWindowTarget(matches.windows);
  if (preferredWindow) {
    return {
      ok: true,
      args: {
        ...params.args,
        ...(preferredWindow.targetId ? { targetId: preferredWindow.targetId } : {}),
        appName: preferredWindow.appName,
        ...(preferredWindow.bundleId ? { bundleId: preferredWindow.bundleId } : {}),
        windowId: preferredWindow.windowId,
      },
      focusTarget: {
        ...(preferredWindow.targetId ? { targetId: preferredWindow.targetId } : {}),
        appName: preferredWindow.appName,
        bundleId: preferredWindow.bundleId,
        windowId: preferredWindow.windowId,
      },
      targets,
      warning:
        preferredWindow.windowId !== explicitWindowId
          ? `Resolved focus_window to real device window ${preferredWindow.windowId}.`
          : undefined,
    };
  }

  const preferredApp =
    matches.apps[0] ??
    (matches.windows[0]
      ? {
          targetId: matches.windows[0].targetId,
          appName: matches.windows[0].appName,
          bundleId: matches.windows[0].bundleId,
          processId: matches.windows[0].processId ?? -1,
          isFrontmost: matches.windows[0].isFocused === true,
        }
      : undefined);
  if (preferredApp) {
    return {
      ok: true,
      args: {
        ...params.args,
        ...(preferredApp.targetId ? { targetId: preferredApp.targetId } : {}),
        appName: preferredApp.appName,
        ...(preferredApp.bundleId ? { bundleId: preferredApp.bundleId } : {}),
      },
      focusTarget: {
        ...(preferredApp.targetId ? { targetId: preferredApp.targetId } : {}),
        appName: preferredApp.appName,
        bundleId: preferredApp.bundleId,
      },
      targets,
    };
  }

  return {
    ok: false,
    summary: "Requested focus target was not found on this device.",
    error:
      `No running app or visible window matched ${explicitBundleId ? `bundleId=${explicitBundleId}` : `appName=${explicitAppName}`}. ` +
      "Retry with a real appName, bundleId, or windowId from the device target catalog.",
    targets,
    warning:
      "Use the returned device target catalog for focus_window. Do not guess application names.",
  };
}

export { discoverComputerUseTargets, prepareFocusWindowTarget };
export type { ComputerUseClientCommandInvoker };

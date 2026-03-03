import { getChannelPlugin, listChannelPlugins } from "../../channels/plugins/index.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateWebLoginStartParams,
  validateWebLoginWaitParams,
} from "../protocol/index.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

type WebLoginMethod = "web.login.start" | "web.login.wait";
const WEB_LOGIN_METHODS = new Set<WebLoginMethod>(["web.login.start", "web.login.wait"]);

function resolveRequestedChannel(params: unknown): string | undefined {
  if (typeof (params as { channel?: unknown }).channel !== "string") {
    return undefined;
  }
  const trimmed = (params as { channel?: string }).channel?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveAccountId(params: unknown): string | undefined {
  return typeof (params as { accountId?: unknown }).accountId === "string"
    ? (params as { accountId?: string }).accountId
    : undefined;
}

function providerDeclaresMethod(
  provider: { gatewayMethods?: string[] },
  method: WebLoginMethod,
): boolean {
  return (provider.gatewayMethods ?? []).some(
    (item) => WEB_LOGIN_METHODS.has(item as WebLoginMethod) && item === method,
  );
}

function resolveWebLoginProvider(method: WebLoginMethod, channel?: string) {
  if (channel) {
    return getChannelPlugin(channel) ?? null;
  }
  return listChannelPlugins().find((plugin) => providerDeclaresMethod(plugin, method)) ?? null;
}

function respondProviderUnavailable(respond: RespondFn, channel?: string) {
  const message = channel
    ? `web login provider is not available for channel ${channel}`
    : "web login provider is not available";
  respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
}

function respondProviderUnsupported(respond: RespondFn, providerId: string) {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, `web login is not supported by provider ${providerId}`),
  );
}

export const webHandlers: GatewayRequestHandlers = {
  "web.login.start": async ({ params, respond, context }) => {
    if (!validateWebLoginStartParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid web.login.start params: ${formatValidationErrors(validateWebLoginStartParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const accountId = resolveAccountId(params);
      const channel = resolveRequestedChannel(params);
      const provider = resolveWebLoginProvider("web.login.start", channel);
      if (!provider) {
        respondProviderUnavailable(respond, channel);
        return;
      }
      const startLogin = provider.gateway?.loginWithQrStart;
      if (!providerDeclaresMethod(provider, "web.login.start") || !startLogin) {
        respondProviderUnsupported(respond, provider.id);
        return;
      }
      await context.stopChannel(provider.id, accountId);
      const result = await startLogin({
        force: Boolean((params as { force?: boolean }).force),
        timeoutMs:
          typeof (params as { timeoutMs?: unknown }).timeoutMs === "number"
            ? (params as { timeoutMs?: number }).timeoutMs
            : undefined,
        verbose: Boolean((params as { verbose?: boolean }).verbose),
        accountId,
      });
      respond(true, result, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "web.login.wait": async ({ params, respond, context }) => {
    if (!validateWebLoginWaitParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid web.login.wait params: ${formatValidationErrors(validateWebLoginWaitParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const accountId = resolveAccountId(params);
      const channel = resolveRequestedChannel(params);
      const provider = resolveWebLoginProvider("web.login.wait", channel);
      if (!provider) {
        respondProviderUnavailable(respond, channel);
        return;
      }
      const waitLogin = provider.gateway?.loginWithQrWait;
      if (!providerDeclaresMethod(provider, "web.login.wait") || !waitLogin) {
        respondProviderUnsupported(respond, provider.id);
        return;
      }
      const result = await waitLogin({
        timeoutMs:
          typeof (params as { timeoutMs?: unknown }).timeoutMs === "number"
            ? (params as { timeoutMs?: number }).timeoutMs
            : undefined,
        accountId,
      });
      if (result.connected) {
        await context.startChannel(provider.id, accountId);
      }
      respond(true, result, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
};

import { normalizeOptionalString } from "../../shared/string-coerce.js";
import {
  ErrorCodes,
  errorShape,
  validateClientInvokeParams,
  validateClientInvokeResultParams,
} from "../protocol/index.js";
import { loadSessionEntry } from "../session-utils.js";
import { respondInvalidParams } from "./nodes.helpers.js";
import type { GatewayRequestHandler, GatewayRequestHandlers } from "./types.js";

function normalizeClientInvokeResultParams(params: unknown): unknown {
  if (!params || typeof params !== "object") {
    return params;
  }
  const raw = params as Record<string, unknown>;
  const normalized: Record<string, unknown> = { ...raw };
  if (normalized.payloadJSON === null) {
    delete normalized.payloadJSON;
  } else if (normalized.payloadJSON !== undefined && typeof normalized.payloadJSON !== "string") {
    if (normalized.payload === undefined) {
      normalized.payload = normalized.payloadJSON;
    }
    delete normalized.payloadJSON;
  }
  if (normalized.error === null) {
    delete normalized.error;
  }
  return normalized;
}

function resolveBoundClientDeviceId(params: {
  sessionKey?: string;
  capability?: string;
}): string | undefined {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  const capability = normalizeOptionalString(params.capability);
  if (!sessionKey || !capability) {
    return undefined;
  }
  const { entry } = loadSessionEntry(sessionKey);
  const binding = entry?.clientCapabilityBindings?.[capability];
  return normalizeOptionalString(binding?.deviceId);
}

export const handleClientInvokeResult: GatewayRequestHandler = async ({
  params,
  respond,
  context,
  client,
}) => {
  const normalizedParams = normalizeClientInvokeResultParams(params);
  if (!validateClientInvokeResultParams(normalizedParams)) {
    respondInvalidParams({
      respond,
      method: "client.invoke.result",
      validator: validateClientInvokeResultParams,
    });
    return;
  }
  const p = normalizedParams as {
    id: string;
    connId: string;
    ok: boolean;
    payload?: unknown;
    payloadJSON?: string | null;
    error?: { code?: string; message?: string } | null;
  };
  const callerConnId = client?.connId;
  if (callerConnId && callerConnId !== p.connId) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "connId mismatch"));
    return;
  }
  const ok = context.clientHostRegistry.handleInvokeResult({
    id: p.id,
    connId: p.connId,
    ok: p.ok,
    payload: p.payload,
    payloadJSON: p.payloadJSON ?? null,
    error: p.error ?? null,
  });
  if (!ok) {
    context.logGateway.debug(`late client invoke result ignored: id=${p.id} conn=${p.connId}`);
    respond(true, { ok: true, ignored: true }, undefined);
    return;
  }
  respond(true, { ok: true }, undefined);
};

export const clientHostHandlers: GatewayRequestHandlers = {
  "client.invoke": async ({ params, respond, context, client }) => {
    if (!validateClientInvokeParams(params)) {
      respondInvalidParams({
        respond,
        method: "client.invoke",
        validator: validateClientInvokeParams,
      });
      return;
    }
    const p = params as {
      sessionKey?: string;
      capability?: string;
      deviceId?: string;
      connId?: string;
      command: string;
      params?: unknown;
      timeoutMs?: number;
      idempotencyKey: string;
    };
    const command = normalizeOptionalString(p.command) ?? "";
    if (!command) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "command required"));
      return;
    }
    const connId = normalizeOptionalString(p.connId);
    const deviceId =
      normalizeOptionalString(p.deviceId) ??
      resolveBoundClientDeviceId({
        sessionKey: p.sessionKey,
        capability: p.capability,
      }) ??
      normalizeOptionalString(
        !p.sessionKey && client?.connect?.device?.id ? client.connect.device.id : undefined,
      );

    if (!connId && !deviceId) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "client.invoke requires connId, deviceId, or a session-bound capability target",
        ),
      );
      return;
    }

    const result = await context.clientHostRegistry.invoke({
      connId: connId ?? undefined,
      deviceId: deviceId ?? undefined,
      capability: normalizeOptionalString(p.capability) ?? undefined,
      command,
      invokeParams: p.params,
      timeoutMs: typeof p.timeoutMs === "number" ? p.timeoutMs : undefined,
      idempotencyKey: p.idempotencyKey,
    });
    if (!result.ok) {
      respond(
        false,
        undefined,
        errorShape(
          result.error?.code === "TIMEOUT" ? ErrorCodes.UNAVAILABLE : ErrorCodes.INVALID_REQUEST,
          result.error?.message ?? "client invoke failed",
          result.error?.code ? { details: { code: result.error.code, command } } : undefined,
        ),
      );
      return;
    }
    respond(true, { payload: result.payload }, undefined);
  },
  "client.invoke.result": handleClientInvokeResult,
};

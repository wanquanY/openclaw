import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateEventsSubscribeParams,
  validateEventsUnsubscribeParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

function normalizeStreams(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return ["*"];
  }
  const normalized = value
    .map((entry) => String(entry ?? "").trim())
    .filter((entry) => entry.length > 0);
  if (normalized.length === 0 || normalized.includes("*")) {
    return ["*"];
  }
  return Array.from(new Set(normalized));
}

export const eventsHandlers: GatewayRequestHandlers = {
  "events.subscribe": ({ params, client, context, respond }) => {
    if (!validateEventsSubscribeParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid events.subscribe params: ${formatValidationErrors(
            validateEventsSubscribeParams.errors,
          )}`,
        ),
      );
      return;
    }
    const connId = typeof client?.connId === "string" ? client.connId.trim() : "";
    if (!connId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "events.subscribe requires an active connection"),
      );
      return;
    }
    if (!context.eventsSubscribe) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "events.subscribe unavailable"));
      return;
    }
    const sessionKey = params.sessionKey.trim();
    const streams = normalizeStreams(params.streams);
    context.eventsSubscribe(connId, sessionKey, streams);
    respond(true, { ok: true, sessionKey, streams }, undefined);
  },
  "events.unsubscribe": ({ params, client, context, respond }) => {
    if (!validateEventsUnsubscribeParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid events.unsubscribe params: ${formatValidationErrors(
            validateEventsUnsubscribeParams.errors,
          )}`,
        ),
      );
      return;
    }
    const connId = typeof client?.connId === "string" ? client.connId.trim() : "";
    if (!connId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "events.unsubscribe requires an active connection"),
      );
      return;
    }
    if (!context.eventsUnsubscribe) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "events.unsubscribe unavailable"),
      );
      return;
    }
    const sessionKey = params.sessionKey.trim();
    const streams = normalizeStreams(params.streams);
    context.eventsUnsubscribe(connId, sessionKey, streams);
    respond(true, { ok: true, sessionKey, streams }, undefined);
  },
};

import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

export const ClientInvokeParamsSchema = Type.Object(
  {
    sessionKey: Type.Optional(NonEmptyString),
    capability: Type.Optional(NonEmptyString),
    deviceId: Type.Optional(NonEmptyString),
    connId: Type.Optional(NonEmptyString),
    command: NonEmptyString,
    params: Type.Optional(Type.Unknown()),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
    idempotencyKey: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ClientInvokeResultParamsSchema = Type.Object(
  {
    id: NonEmptyString,
    connId: NonEmptyString,
    ok: Type.Boolean(),
    payload: Type.Optional(Type.Unknown()),
    payloadJSON: Type.Optional(Type.String()),
    error: Type.Optional(
      Type.Object(
        {
          code: Type.Optional(NonEmptyString),
          message: Type.Optional(NonEmptyString),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const ClientInvokeRequestEventSchema = Type.Object(
  {
    id: NonEmptyString,
    connId: NonEmptyString,
    hostId: NonEmptyString,
    deviceId: Type.Optional(NonEmptyString),
    capability: Type.Optional(NonEmptyString),
    command: NonEmptyString,
    paramsJSON: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
    idempotencyKey: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

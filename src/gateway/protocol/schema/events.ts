import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

export type EventsSubscribeParams = {
  sessionKey: string;
  streams?: string[];
};

export type EventsUnsubscribeParams = {
  sessionKey: string;
  streams?: string[];
};

const EventStreamSchema = Type.String({ minLength: 1, maxLength: 64 });
const EventStreamListSchema = Type.Array(EventStreamSchema, {
  minItems: 1,
  maxItems: 16,
});

export const EventsSubscribeParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    streams: Type.Optional(EventStreamListSchema),
  },
  { additionalProperties: false },
);

export const EventsUnsubscribeParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    streams: Type.Optional(EventStreamListSchema),
  },
  { additionalProperties: false },
);

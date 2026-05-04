import { Type } from "typebox";
import {
  BROWSER_USE_ACTIVATIONS,
  BROWSER_USE_ACTIVATION_SOURCES,
  BROWSER_USE_HOST_POLICIES,
  BROWSER_USE_MODES,
  type BrowserUseActivation,
  type BrowserUseActivationSource,
  type BrowserUseHostPolicy,
  type BrowserUseMode,
} from "./types.js";

function stringEnum<T extends string>(values: readonly T[]) {
  return Type.Unsafe<T>({
    type: "string",
    enum: [...values],
  });
}

export const BrowserUseSessionConfigSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    mode: stringEnum<BrowserUseMode>(BROWSER_USE_MODES),
    hostPolicy: stringEnum<BrowserUseHostPolicy>(BROWSER_USE_HOST_POLICIES),
    activation: Type.Optional(stringEnum<BrowserUseActivation>(BROWSER_USE_ACTIVATIONS)),
    source: Type.Optional(stringEnum<BrowserUseActivationSource>(BROWSER_USE_ACTIVATION_SOURCES)),
  },
  { additionalProperties: false },
);

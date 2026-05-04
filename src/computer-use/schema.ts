import { Type } from "typebox";
import {
  COMPUTER_USE_HOST_POLICIES,
  COMPUTER_USE_ACTIVATIONS,
  COMPUTER_USE_ACTIVATION_SOURCES,
  COMPUTER_USE_MODEL_POLICY_MODES,
  COMPUTER_USE_MODES,
  COMPUTER_USE_SCOPE_TYPES,
  type ComputerUseActivation,
  type ComputerUseActivationSource,
  type ComputerUseHostPolicy,
  type ComputerUseMode,
  type ComputerUseModelPolicyMode,
  type ComputerUseScopeType,
} from "./types.js";

function stringEnum<T extends string>(values: readonly T[]) {
  return Type.Unsafe<T>({
    type: "string",
    enum: [...values],
  });
}

export const ComputerUseScopeSchema = Type.Object(
  {
    type: stringEnum<ComputerUseScopeType>(COMPUTER_USE_SCOPE_TYPES),
    windowId: Type.Optional(Type.String()),
    displayId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const ComputerUseModelPolicySchema = Type.Object(
  {
    mode: stringEnum<ComputerUseModelPolicyMode>(COMPUTER_USE_MODEL_POLICY_MODES),
    executorModel: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const ComputerUseApprovalsSchema = Type.Object(
  {
    highRiskActionsRequireConfirm: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const ComputerUseSessionConfigSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    mode: stringEnum<ComputerUseMode>(COMPUTER_USE_MODES),
    activation: Type.Optional(stringEnum<ComputerUseActivation>(COMPUTER_USE_ACTIVATIONS)),
    source: Type.Optional(stringEnum<ComputerUseActivationSource>(COMPUTER_USE_ACTIVATION_SOURCES)),
    scope: ComputerUseScopeSchema,
    hostPolicy: stringEnum<ComputerUseHostPolicy>(COMPUTER_USE_HOST_POLICIES),
    modelPolicy: ComputerUseModelPolicySchema,
    approvals: ComputerUseApprovalsSchema,
  },
  { additionalProperties: false },
);

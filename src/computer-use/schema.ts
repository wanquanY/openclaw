import { Type } from "@sinclair/typebox";
import {
  COMPUTER_USE_HOST_POLICIES,
  COMPUTER_USE_MODEL_POLICY_MODES,
  COMPUTER_USE_MODES,
  COMPUTER_USE_SCOPE_TYPES,
} from "./types.js";

function literalUnion<T extends readonly string[]>(values: T) {
  return Type.Union(values.map((value) => Type.Literal(value)));
}

export const ComputerUseScopeSchema = Type.Object(
  {
    type: literalUnion(COMPUTER_USE_SCOPE_TYPES),
    windowId: Type.Optional(Type.String()),
    displayId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const ComputerUseModelPolicySchema = Type.Object(
  {
    mode: literalUnion(COMPUTER_USE_MODEL_POLICY_MODES),
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
    mode: literalUnion(COMPUTER_USE_MODES),
    scope: ComputerUseScopeSchema,
    hostPolicy: literalUnion(COMPUTER_USE_HOST_POLICIES),
    modelPolicy: ComputerUseModelPolicySchema,
    approvals: ComputerUseApprovalsSchema,
  },
  { additionalProperties: false },
);

import { randomUUID } from "node:crypto";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import {
  buildConfiguredModelCatalog,
  type ModelRef,
  resolveAllowedModelRef,
  resolveDefaultModelForAgent,
  resolveSubagentConfiguredModelSelection,
} from "../agents/model-selection.js";
import { normalizeGroupActivation } from "../auto-reply/group-activation.js";
import {
  formatThinkingLevels,
  isThinkingLevelSupported,
  normalizeElevatedLevel,
  normalizeFastMode,
  normalizeReasoningLevel,
  normalizeThinkLevel,
  normalizeUsageDisplay,
  resolveSupportedThinkingLevel,
} from "../auto-reply/thinking.js";
import { normalizeComputerUseSessionConfig } from "../computer-use/types.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeExecTarget } from "../infra/exec-approvals.js";
import {
  isAcpSessionKey,
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import {
  applyTraceOverride,
  applyVerboseOverride,
  parseTraceOverride,
  parseVerboseOverride,
} from "../sessions/level-overrides.js";
import { applyModelOverrideToSessionEntry } from "../sessions/model-overrides.js";
import { normalizeSendPolicy } from "../sessions/send-policy.js";
import { parseSessionLabel } from "../sessions/session-label.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import {
  ErrorCodes,
  type ErrorShape,
  errorShape,
  type SessionsPatchParams,
} from "./protocol/index.js";

function invalid(message: string): { ok: false; error: ErrorShape } {
  return { ok: false, error: errorShape(ErrorCodes.INVALID_REQUEST, message) };
}

function normalizeExecSecurity(raw: string): "deny" | "allowlist" | "full" | undefined {
  const normalized = normalizeOptionalLowercaseString(raw);
  if (normalized === "deny" || normalized === "allowlist" || normalized === "full") {
    return normalized;
  }
  return undefined;
}

function normalizeExecAsk(raw: string): "off" | "on-miss" | "always" | undefined {
  const normalized = normalizeOptionalLowercaseString(raw);
  if (normalized === "off" || normalized === "on-miss" || normalized === "always") {
    return normalized;
  }
  return undefined;
}

function supportsSpawnLineage(storeKey: string): boolean {
  return isSubagentSessionKey(storeKey) || isAcpSessionKey(storeKey);
}

function normalizeSubagentRole(raw: string): "orchestrator" | "leaf" | undefined {
  const normalized = normalizeOptionalLowercaseString(raw);
  if (normalized === "orchestrator" || normalized === "leaf") {
    return normalized;
  }
  return undefined;
}

function normalizeSubagentControlScope(raw: string): "children" | "none" | undefined {
  const normalized = normalizeOptionalLowercaseString(raw);
  if (normalized === "children" || normalized === "none") {
    return normalized;
  }
  return undefined;
}

function normalizeOptionalTrimmedString(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed || undefined;
}

function applyResolvedModelOverride(params: {
  entry: SessionEntry;
  resolved: ModelRef;
  resolvedDefault: ModelRef;
}) {
  const isDefault =
    params.resolved.provider === params.resolvedDefault.provider &&
    params.resolved.model === params.resolvedDefault.model;
  applyModelOverrideToSessionEntry({
    entry: params.entry,
    selection: {
      provider: params.resolved.provider,
      model: params.resolved.model,
      isDefault,
    },
    markLiveSwitchPending: true,
  });
}

export async function applySessionsPatchToStore(params: {
  cfg: OpenClawConfig;
  store: Record<string, SessionEntry>;
  storeKey: string;
  patch: SessionsPatchParams;
  loadGatewayModelCatalog?: () => Promise<ModelCatalogEntry[]>;
}): Promise<{ ok: true; entry: SessionEntry } | { ok: false; error: ErrorShape }> {
  const { cfg, store, storeKey, patch } = params;
  const now = Date.now();
  const parsedAgent = parseAgentSessionKey(storeKey);
  const sessionAgentId = normalizeAgentId(parsedAgent?.agentId ?? resolveDefaultAgentId(cfg));
  const resolvedDefault = resolveDefaultModelForAgent({ cfg, agentId: sessionAgentId });
  const subagentModelHint = isSubagentSessionKey(storeKey)
    ? resolveSubagentConfiguredModelSelection({ cfg, agentId: sessionAgentId })
    : undefined;

  const existing = store[storeKey];
  const next: SessionEntry = existing
    ? {
        ...existing,
        updatedAt: Math.max(existing.updatedAt ?? 0, now),
      }
    : { sessionId: randomUUID(), updatedAt: now };

  if ("spawnedBy" in patch) {
    const raw = patch.spawnedBy;
    if (raw === null) {
      if (existing?.spawnedBy) {
        return invalid("spawnedBy cannot be cleared once set");
      }
    } else if (raw !== undefined) {
      const trimmed = normalizeOptionalString(raw) ?? "";
      if (!trimmed) {
        return invalid("invalid spawnedBy: empty");
      }
      if (!supportsSpawnLineage(storeKey)) {
        return invalid("spawnedBy is only supported for subagent:* or acp:* sessions");
      }
      if (existing?.spawnedBy && existing.spawnedBy !== trimmed) {
        return invalid("spawnedBy cannot be changed once set");
      }
      next.spawnedBy = trimmed;
    }
  }

  if ("spawnedWorkspaceDir" in patch) {
    const raw = patch.spawnedWorkspaceDir;
    if (raw === null) {
      if (existing?.spawnedWorkspaceDir) {
        return invalid("spawnedWorkspaceDir cannot be cleared once set");
      }
    } else if (raw !== undefined) {
      if (!supportsSpawnLineage(storeKey)) {
        return invalid("spawnedWorkspaceDir is only supported for subagent:* or acp:* sessions");
      }
      const trimmed = normalizeOptionalString(raw) ?? "";
      if (!trimmed) {
        return invalid("invalid spawnedWorkspaceDir: empty");
      }
      if (existing?.spawnedWorkspaceDir && existing.spawnedWorkspaceDir !== trimmed) {
        return invalid("spawnedWorkspaceDir cannot be changed once set");
      }
      next.spawnedWorkspaceDir = trimmed;
    }
  }

  if ("spawnDepth" in patch) {
    const raw = patch.spawnDepth;
    if (raw === null) {
      if (typeof existing?.spawnDepth === "number") {
        return invalid("spawnDepth cannot be cleared once set");
      }
    } else if (raw !== undefined) {
      if (!supportsSpawnLineage(storeKey)) {
        return invalid("spawnDepth is only supported for subagent:* or acp:* sessions");
      }
      const numeric = raw;
      if (!Number.isInteger(numeric) || numeric < 0) {
        return invalid("invalid spawnDepth (use an integer >= 0)");
      }
      const normalized = numeric;
      if (typeof existing?.spawnDepth === "number" && existing.spawnDepth !== normalized) {
        return invalid("spawnDepth cannot be changed once set");
      }
      next.spawnDepth = normalized;
    }
  }

  if ("subagentRole" in patch) {
    const raw = patch.subagentRole;
    if (raw === null) {
      if (existing?.subagentRole) {
        return invalid("subagentRole cannot be cleared once set");
      }
    } else if (raw !== undefined) {
      if (!supportsSpawnLineage(storeKey)) {
        return invalid("subagentRole is only supported for subagent:* or acp:* sessions");
      }
      const normalized = normalizeSubagentRole(raw);
      if (!normalized) {
        return invalid('invalid subagentRole (use "orchestrator" or "leaf")');
      }
      if (existing?.subagentRole && existing.subagentRole !== normalized) {
        return invalid("subagentRole cannot be changed once set");
      }
      next.subagentRole = normalized;
    }
  }

  if ("subagentControlScope" in patch) {
    const raw = patch.subagentControlScope;
    if (raw === null) {
      if (existing?.subagentControlScope) {
        return invalid("subagentControlScope cannot be cleared once set");
      }
    } else if (raw !== undefined) {
      if (!supportsSpawnLineage(storeKey)) {
        return invalid("subagentControlScope is only supported for subagent:* or acp:* sessions");
      }
      const normalized = normalizeSubagentControlScope(raw);
      if (!normalized) {
        return invalid('invalid subagentControlScope (use "children" or "none")');
      }
      if (existing?.subagentControlScope && existing.subagentControlScope !== normalized) {
        return invalid("subagentControlScope cannot be changed once set");
      }
      next.subagentControlScope = normalized;
    }
  }

  if ("threadId" in patch) {
    const raw = patch.threadId;
    if (raw === null) {
      if (existing?.threadId) {
        return invalid("threadId cannot be cleared once set");
      }
    } else if (raw !== undefined) {
      const normalized = normalizeOptionalTrimmedString(raw);
      if (!normalized) {
        return invalid("invalid threadId: empty");
      }
      if (existing?.threadId && existing.threadId !== normalized) {
        return invalid("threadId cannot be changed once set");
      }
      next.threadId = normalized;
    }
  }

  if ("title" in patch) {
    const raw = patch.title;
    if (raw === null) {
      delete next.title;
    } else if (raw !== undefined) {
      const normalized = normalizeOptionalTrimmedString(raw);
      if (!normalized) {
        return invalid("invalid title: empty");
      }
      next.title = normalized;
      if (!("titleSource" in patch)) {
        next.titleSource = "manual";
      }
      if (!("titleStatus" in patch)) {
        next.titleStatus = "ready";
      }
    }
  }

  if ("fallbackTitle" in patch) {
    const raw = patch.fallbackTitle;
    if (raw === null) {
      delete next.fallbackTitle;
    } else if (raw !== undefined) {
      const normalized = normalizeOptionalTrimmedString(raw);
      if (!normalized) {
        return invalid("invalid fallbackTitle: empty");
      }
      next.fallbackTitle = normalized;
    }
  }

  if ("titleSource" in patch) {
    const raw = patch.titleSource;
    if (raw === null) {
      delete next.titleSource;
    } else if (raw !== undefined) {
      next.titleSource = raw;
    }
  }

  if ("titleStatus" in patch) {
    const raw = patch.titleStatus;
    if (raw === null) {
      delete next.titleStatus;
    } else if (raw !== undefined) {
      next.titleStatus = raw;
    }
  }

  if ("titleLocked" in patch) {
    const raw = patch.titleLocked;
    if (raw === null) {
      delete next.titleLocked;
    } else if (raw !== undefined) {
      next.titleLocked = raw;
    }
  }

  if ("titleBasisMessageId" in patch) {
    const raw = patch.titleBasisMessageId;
    if (raw === null) {
      delete next.titleBasisMessageId;
    } else if (raw !== undefined) {
      const normalized = normalizeOptionalTrimmedString(raw);
      if (!normalized) {
        return invalid("invalid titleBasisMessageId: empty");
      }
      next.titleBasisMessageId = normalized;
    }
  }

  if ("titleGeneratedAt" in patch) {
    const raw = patch.titleGeneratedAt;
    if (raw === null) {
      delete next.titleGeneratedAt;
    } else if (raw !== undefined) {
      const numeric = raw;
      if (!Number.isFinite(numeric) || numeric < 0) {
        return invalid("invalid titleGeneratedAt (use an integer >= 0)");
      }
      next.titleGeneratedAt = Math.floor(numeric);
    }
  }

  if ("label" in patch) {
    const raw = patch.label;
    if (raw === null) {
      delete next.label;
    } else if (raw !== undefined) {
      const parsed = parseSessionLabel(raw);
      if (!parsed.ok) {
        return invalid(parsed.error);
      }
      for (const [key, entry] of Object.entries(store)) {
        if (key === storeKey) {
          continue;
        }
        if (entry?.label === parsed.label) {
          return invalid(`label already in use: ${parsed.label}`);
        }
      }
      next.label = parsed.label;
    }
  }

  if ("thinkingLevel" in patch) {
    const raw = patch.thinkingLevel;
    if (raw === null) {
      // Clear the override and fall back to model default
      delete next.thinkingLevel;
    } else if (raw !== undefined) {
      const normalized = normalizeThinkLevel(raw);
      if (!normalized) {
        const hintProvider =
          normalizeOptionalString(existing?.providerOverride) || resolvedDefault.provider;
        const hintModel = normalizeOptionalString(existing?.modelOverride) || resolvedDefault.model;
        return invalid(
          `invalid thinkingLevel (use ${formatThinkingLevels(hintProvider, hintModel, "|")})`,
        );
      }
      next.thinkingLevel = normalized;
    }
  }

  if ("fastMode" in patch) {
    const raw = patch.fastMode;
    if (raw === null) {
      delete next.fastMode;
    } else if (raw !== undefined) {
      const normalized = normalizeFastMode(raw);
      if (normalized === undefined) {
        return invalid("invalid fastMode (use true or false)");
      }
      next.fastMode = normalized;
    }
  }

  if ("verboseLevel" in patch) {
    const raw = patch.verboseLevel;
    const parsed = parseVerboseOverride(raw);
    if (!parsed.ok) {
      return invalid(parsed.error);
    }
    applyVerboseOverride(next, parsed.value);
  }

  if ("traceLevel" in patch) {
    const raw = patch.traceLevel;
    const parsed = parseTraceOverride(raw);
    if (!parsed.ok) {
      return invalid(parsed.error);
    }
    applyTraceOverride(next, parsed.value);
  }

  if ("reasoningLevel" in patch) {
    const raw = patch.reasoningLevel;
    if (raw === null) {
      delete next.reasoningLevel;
    } else if (raw !== undefined) {
      const normalized = normalizeReasoningLevel(raw);
      if (!normalized) {
        return invalid('invalid reasoningLevel (use "on"|"off"|"stream")');
      }
      // Persist "off" explicitly so that resolveDefaultReasoningLevel()
      // does not re-enable reasoning for capable models (#24406).
      next.reasoningLevel = normalized;
    }
  }

  if ("responseUsage" in patch) {
    const raw = patch.responseUsage;
    if (raw === null) {
      delete next.responseUsage;
    } else if (raw !== undefined) {
      const normalized = normalizeUsageDisplay(raw);
      if (!normalized) {
        return invalid('invalid responseUsage (use "off"|"tokens"|"full")');
      }
      if (normalized === "off") {
        delete next.responseUsage;
      } else {
        next.responseUsage = normalized;
      }
    }
  }

  if ("elevatedLevel" in patch) {
    const raw = patch.elevatedLevel;
    if (raw === null) {
      delete next.elevatedLevel;
    } else if (raw !== undefined) {
      const normalized = normalizeElevatedLevel(raw);
      if (!normalized) {
        return invalid('invalid elevatedLevel (use "on"|"off"|"ask"|"full")');
      }
      // Persist "off" explicitly so patches can override defaults.
      next.elevatedLevel = normalized;
    }
  }

  if ("execHost" in patch) {
    const raw = patch.execHost;
    if (raw === null) {
      delete next.execHost;
    } else if (raw !== undefined) {
      const normalized = normalizeExecTarget(raw) ?? undefined;
      if (!normalized) {
        return invalid('invalid execHost (use "auto"|"sandbox"|"gateway"|"node")');
      }
      next.execHost = normalized;
    }
  }

  if ("execSecurity" in patch) {
    const raw = patch.execSecurity;
    if (raw === null) {
      delete next.execSecurity;
    } else if (raw !== undefined) {
      const normalized = normalizeExecSecurity(raw);
      if (!normalized) {
        return invalid('invalid execSecurity (use "deny"|"allowlist"|"full")');
      }
      next.execSecurity = normalized;
    }
  }

  if ("execAsk" in patch) {
    const raw = patch.execAsk;
    if (raw === null) {
      delete next.execAsk;
    } else if (raw !== undefined) {
      const normalized = normalizeExecAsk(raw);
      if (!normalized) {
        return invalid('invalid execAsk (use "off"|"on-miss"|"always")');
      }
      next.execAsk = normalized;
    }
  }

  if ("execNode" in patch) {
    const raw = patch.execNode;
    if (raw === null) {
      delete next.execNode;
    } else if (raw !== undefined) {
      const trimmed = normalizeOptionalString(raw) ?? "";
      if (!trimmed) {
        return invalid("invalid execNode: empty");
      }
      next.execNode = trimmed;
    }
  }

  if ("computerUse" in patch) {
    const raw = patch.computerUse;
    if (raw === null) {
      delete next.computerUse;
    } else if (raw !== undefined) {
      const normalized = normalizeComputerUseSessionConfig(raw);
      if (!normalized) {
        return invalid("invalid computerUse config");
      }
      next.computerUse = normalized;
    }
  }

  if ("model" in patch) {
    const raw = patch.model;
    if (raw === null) {
      applyModelOverrideToSessionEntry({
        entry: next,
        selection: {
          provider: resolvedDefault.provider,
          model: resolvedDefault.model,
          isDefault: true,
        },
        markLiveSwitchPending: true,
      });
    } else if (raw !== undefined) {
      const trimmed = normalizeOptionalString(raw) ?? "";
      if (!trimmed) {
        return invalid("invalid model: empty");
      }
      const configuredCatalog = buildConfiguredModelCatalog({ cfg });
      const configuredResolved = resolveAllowedModelRef({
        cfg,
        catalog: configuredCatalog,
        raw: trimmed,
        defaultProvider: resolvedDefault.provider,
        defaultModel: subagentModelHint ?? resolvedDefault.model,
      });
      if (!params.loadGatewayModelCatalog) {
        if ("error" in configuredResolved) {
          return {
            ok: false,
            error: errorShape(ErrorCodes.UNAVAILABLE, "model catalog unavailable"),
          };
        }
        applyResolvedModelOverride({
          entry: next,
          resolved: configuredResolved.ref,
          resolvedDefault,
        });
      } else {
        const resolved =
          "error" in configuredResolved
            ? resolveAllowedModelRef({
                cfg,
                catalog: await params.loadGatewayModelCatalog(),
                raw: trimmed,
                defaultProvider: resolvedDefault.provider,
                defaultModel: subagentModelHint ?? resolvedDefault.model,
              })
            : configuredResolved;
        if ("error" in resolved) {
          return invalid(resolved.error);
        }
        applyResolvedModelOverride({
          entry: next,
          resolved: resolved.ref,
          resolvedDefault,
        });
      }
    }
  }

  if (next.thinkingLevel) {
    const effectiveProvider = next.providerOverride ?? resolvedDefault.provider;
    const effectiveModel = next.modelOverride ?? resolvedDefault.model;
    const thinkingLevel = normalizeThinkLevel(next.thinkingLevel);
    if (!thinkingLevel) {
      delete next.thinkingLevel;
    } else if (
      !isThinkingLevelSupported({
        provider: effectiveProvider,
        model: effectiveModel,
        level: thinkingLevel,
      })
    ) {
      if ("thinkingLevel" in patch) {
        return invalid(
          `thinkingLevel "${thinkingLevel}" is not supported for ${effectiveProvider}/${effectiveModel} (use ${formatThinkingLevels(effectiveProvider, effectiveModel, "|")})`,
        );
      }
      next.thinkingLevel = resolveSupportedThinkingLevel({
        provider: effectiveProvider,
        model: effectiveModel,
        level: thinkingLevel,
      });
    }
  }

  if ("sendPolicy" in patch) {
    const raw = patch.sendPolicy;
    if (raw === null) {
      delete next.sendPolicy;
    } else if (raw !== undefined) {
      const normalized = normalizeSendPolicy(raw);
      if (!normalized) {
        return invalid('invalid sendPolicy (use "allow"|"deny")');
      }
      next.sendPolicy = normalized;
    }
  }

  if ("groupActivation" in patch) {
    const raw = patch.groupActivation;
    if (raw === null) {
      delete next.groupActivation;
    } else if (raw !== undefined) {
      const normalized = normalizeGroupActivation(raw);
      if (!normalized) {
        return invalid('invalid groupActivation (use "mention"|"always")');
      }
      next.groupActivation = normalized;
    }
  }

  store[storeKey] = next;
  return { ok: true, entry: next };
}

import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SkillConfig } from "../../config/types.skills.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import {
  evaluateRuntimeEligibility,
  hasBinary,
  isConfigPathTruthyWithDefaults,
  resolveConfigPath,
  resolveRuntimePlatform,
} from "../../shared/config-eval.js";
import { normalizeStringEntries } from "../../shared/string-normalization.js";
import { resolveSkillKey } from "./frontmatter.js";
import { resolveSkillSource } from "./source.js";
import type { SkillEligibilityContext, SkillEntry } from "./types.js";

const DEFAULT_CONFIG_VALUES: Record<string, boolean> = {
  "browser.enabled": true,
  "browser.evaluateEnabled": true,
};

export { hasBinary, resolveConfigPath, resolveRuntimePlatform };

export function isConfigPathTruthy(config: OpenClawConfig | undefined, pathStr: string): boolean {
  return isConfigPathTruthyWithDefaults(config, pathStr, DEFAULT_CONFIG_VALUES);
}

export function resolveSkillConfig(
  config: OpenClawConfig | undefined,
  skillKey: string,
  opts?: {
    agentId?: string;
  },
): SkillConfig | undefined {
  const globalEntry = config?.skills?.entries?.[skillKey];
  const agentEntry = resolveAgentSkillConfigEntry(config, skillKey, opts?.agentId);
  return mergeSkillConfigEntries(globalEntry, agentEntry.defaultsEntry, agentEntry.agentEntry);
}

function mergeSkillConfigEntries(
  ...entries: Array<SkillConfig | undefined>
): SkillConfig | undefined {
  let next: SkillConfig | undefined;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    next = {
      ...(next ?? {}),
      ...entry,
      ...(entry.env ? { env: { ...(next?.env ?? {}), ...entry.env } } : {}),
      ...(entry.config ? { config: { ...(next?.config ?? {}), ...entry.config } } : {}),
    };
  }
  if (!next) {
    return undefined;
  }
  if (!next.env || Object.keys(next.env).length === 0) {
    delete next.env;
  }
  if (!next.config || Object.keys(next.config).length === 0) {
    delete next.config;
  }
  if (Object.keys(next).length === 0) {
    return undefined;
  }
  return next;
}

function resolveAgentSkillConfigEntry(
  config: OpenClawConfig | undefined,
  skillKey: string,
  agentId: string | undefined,
): {
  defaultsEntry?: SkillConfig;
  agentEntry?: SkillConfig;
} {
  if (!config || !agentId) {
    return {};
  }
  const normalizedAgentId = normalizeAgentId(agentId);
  const defaultsEntry = config.agents?.defaults?.skillSettings?.[skillKey];
  const agentEntry = config.agents?.list?.find(
    (entry) => normalizeAgentId(entry.id) === normalizedAgentId,
  )?.skillSettings?.[skillKey];
  return { defaultsEntry, agentEntry };
}

export function resolveScopedSkillSettings(
  config: OpenClawConfig | undefined,
  params: {
    agentId?: string;
  },
): Record<string, SkillConfig> | undefined {
  if (!config) {
    return undefined;
  }
  const next: Record<string, SkillConfig> = {};
  const globalEntries = config.skills?.entries ?? {};
  const defaultsEntries = params.agentId ? (config.agents?.defaults?.skillSettings ?? {}) : {};
  const normalizedAgentId = params.agentId ? normalizeAgentId(params.agentId) : "";
  const agentEntries = normalizedAgentId
    ? (config.agents?.list?.find((entry) => normalizeAgentId(entry.id) === normalizedAgentId)
        ?.skillSettings ?? {})
    : {};
  const keys = new Set<string>([
    ...Object.keys(globalEntries),
    ...Object.keys(defaultsEntries),
    ...Object.keys(agentEntries),
  ]);
  for (const key of keys) {
    const merged = mergeSkillConfigEntries(
      globalEntries[key],
      defaultsEntries[key],
      agentEntries[key],
    );
    if (merged) {
      next[key] = merged;
    }
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function normalizeAllowlist(input: unknown): string[] | undefined {
  if (!input) {
    return undefined;
  }
  if (!Array.isArray(input)) {
    return undefined;
  }
  const normalized = normalizeStringEntries(input);
  return normalized.length > 0 ? normalized : undefined;
}

const BUNDLED_SOURCES = new Set(["openclaw-bundled"]);

function isBundledSkill(entry: SkillEntry): boolean {
  return BUNDLED_SOURCES.has(resolveSkillSource(entry.skill));
}

export function resolveBundledAllowlist(config?: OpenClawConfig): string[] | undefined {
  return normalizeAllowlist(config?.skills?.allowBundled);
}

export function isBundledSkillAllowed(entry: SkillEntry, allowlist?: string[]): boolean {
  if (!allowlist || allowlist.length === 0) {
    return true;
  }
  if (!isBundledSkill(entry)) {
    return true;
  }
  const key = resolveSkillKey(entry.skill, entry);
  return allowlist.includes(key) || allowlist.includes(entry.skill.name);
}

export function shouldIncludeSkill(params: {
  entry: SkillEntry;
  config?: OpenClawConfig;
  eligibility?: SkillEligibilityContext;
  agentId?: string;
}): boolean {
  const { entry, config, eligibility } = params;
  const skillKey = resolveSkillKey(entry.skill, entry);
  const skillConfig = resolveSkillConfig(config, skillKey, {
    agentId: params.agentId,
  });
  const allowBundled = normalizeAllowlist(config?.skills?.allowBundled);

  if (skillConfig?.enabled === false) {
    return false;
  }
  if (!isBundledSkillAllowed(entry, allowBundled)) {
    return false;
  }
  return evaluateRuntimeEligibility({
    os: entry.metadata?.os,
    remotePlatforms: eligibility?.remote?.platforms,
    always: entry.metadata?.always,
    requires: entry.metadata?.requires,
    hasBin: hasBinary,
    hasRemoteBin: eligibility?.remote?.hasBin,
    hasAnyRemoteBin: eligibility?.remote?.hasAnyBin,
    hasEnv: (envName) =>
      Boolean(
        process.env[envName] ||
        skillConfig?.env?.[envName] ||
        (skillConfig?.apiKey && entry.metadata?.primaryEnv === envName),
      ),
    isConfigPathTruthy: (configPath) => isConfigPathTruthy(config, configPath),
  });
}

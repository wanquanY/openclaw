import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import { canExecRequestNode } from "../../agents/exec-defaults.js";
import {
  installSkillFromClawHub,
  searchSkillsFromClawHub,
  updateSkillsFromClawHub,
} from "../../agents/skills-clawhub.js";
import { installSkill } from "../../agents/skills-install.js";
import {
  formatWorkspaceSkillImportError,
  installWorkspaceSkillFromArchive,
  installWorkspaceSkillFromNpmSpec,
  uninstallWorkspaceSkill,
} from "../../agents/skills-manage.js";
import { buildWorkspaceSkillStatus } from "../../agents/skills-status.js";
import { loadWorkspaceSkillEntries, type SkillEntry } from "../../agents/skills.js";
import { listAgentWorkspaceDirs } from "../../agents/workspace-dirs.js";
import { loadConfig, writeConfigFile } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SkillConfig } from "../../config/types.skills.js";
import { fetchClawHubSkillDetail } from "../../infra/clawhub.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { getRemoteSkillEligibility } from "../../infra/skills-remote.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateSkillsBinsParams,
  validateSkillsDetailParams,
  validateSkillsImportParams,
  validateSkillsInstallParams,
  validateSkillsSearchParams,
  validateSkillsStatusParams,
  validateSkillsUninstallParams,
  validateSkillsUpdateParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

function cloneUnknown(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneUnknown(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        cloneUnknown(entry),
      ]),
    );
  }
  return value;
}

function cloneSkillConfigEntry(entry: SkillConfig | undefined): SkillConfig {
  return {
    ...entry,
    ...(entry?.env ? { env: { ...entry.env } } : {}),
    ...(entry?.config ? { config: cloneUnknown(entry.config) as Record<string, unknown> } : {}),
  };
}

function normalizeSkillConfigEntry(entry: SkillConfig): SkillConfig | undefined {
  const next = cloneSkillConfigEntry(entry);
  if (!next.env || Object.keys(next.env).length === 0) {
    delete next.env;
  }
  if (!next.config || Object.keys(next.config).length === 0) {
    delete next.config;
  }
  if (!Object.keys(next).length) {
    return undefined;
  }
  return next;
}

function applySkillConfigPatch(params: {
  current: SkillConfig | undefined;
  enabled?: boolean;
  apiKey?: string;
  env?: Record<string, string>;
  config?: Record<string, unknown>;
}): SkillConfig | undefined {
  const next = cloneSkillConfigEntry(params.current);
  if (typeof params.enabled === "boolean") {
    next.enabled = params.enabled;
  }
  if (typeof params.apiKey === "string") {
    const trimmed = normalizeSecretInput(params.apiKey);
    if (trimmed) {
      next.apiKey = trimmed;
    } else {
      delete next.apiKey;
    }
  }
  if (params.env && typeof params.env === "object") {
    const nextEnv = next.env ? { ...next.env } : {};
    for (const [key, value] of Object.entries(params.env)) {
      const trimmedKey = key.trim();
      if (!trimmedKey) {
        continue;
      }
      const trimmedValue = value.trim();
      if (!trimmedValue) {
        delete nextEnv[trimmedKey];
      } else {
        nextEnv[trimmedKey] = trimmedValue;
      }
    }
    next.env = nextEnv;
  }
  if (params.config && typeof params.config === "object") {
    const nextConfig = next.config ? { ...next.config } : {};
    for (const [key, value] of Object.entries(params.config)) {
      const trimmedKey = key.trim();
      if (!trimmedKey) {
        continue;
      }
      if (value === null || value === undefined) {
        delete nextConfig[trimmedKey];
      } else {
        nextConfig[trimmedKey] = cloneUnknown(value);
      }
    }
    next.config = nextConfig;
  }
  return normalizeSkillConfigEntry(next);
}

function resolveSkillScopeTarget(params: { cfg: OpenClawConfig; agentId?: string }):
  | {
      scope: "global";
    }
  | {
      scope: "agent-defaults";
      agentId: string;
    }
  | {
      scope: "agent";
      agentId: string;
      agentIndex: number;
    } {
  const agentIdRaw = normalizeOptionalString(params.agentId) ?? "";
  if (!agentIdRaw) {
    return { scope: "global" };
  }
  const agentId = normalizeAgentId(agentIdRaw);
  const agentEntries = Array.isArray(params.cfg.agents?.list) ? params.cfg.agents.list : [];
  const agentIndex = agentEntries.findIndex((entry) => normalizeAgentId(entry.id) === agentId);
  if (agentIndex >= 0) {
    return {
      scope: "agent",
      agentId,
      agentIndex,
    };
  }
  return {
    scope: "agent-defaults",
    agentId,
  };
}

function writeScopedSkillConfig(params: {
  cfg: OpenClawConfig;
  skillKey: string;
  agentId?: string;
  nextEntry: SkillConfig | undefined;
}): OpenClawConfig {
  const { skills: previousSkills, ...configWithoutSkills } = params.cfg;
  const target = resolveSkillScopeTarget({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  if (target.scope === "global") {
    const skills = previousSkills ? { ...previousSkills } : {};
    const entries = skills.entries ? { ...skills.entries } : {};
    if (params.nextEntry) {
      entries[params.skillKey] = params.nextEntry;
    } else {
      delete entries[params.skillKey];
    }
    if (Object.keys(entries).length > 0) {
      skills.entries = entries;
    } else {
      delete skills.entries;
    }
    return Object.keys(skills).length > 0
      ? { ...configWithoutSkills, skills }
      : configWithoutSkills;
  }

  const agents = params.cfg.agents ? { ...params.cfg.agents } : {};
  if (target.scope === "agent-defaults") {
    const defaults = agents.defaults ? { ...agents.defaults } : {};
    const skillSettings = defaults.skillSettings ? { ...defaults.skillSettings } : {};
    if (params.nextEntry) {
      skillSettings[params.skillKey] = params.nextEntry;
    } else {
      delete skillSettings[params.skillKey];
    }
    if (Object.keys(skillSettings).length > 0) {
      defaults.skillSettings = skillSettings;
    } else {
      delete defaults.skillSettings;
    }
    agents.defaults = defaults;
    return {
      ...params.cfg,
      agents,
    };
  }

  const list = Array.isArray(agents.list) ? [...agents.list] : [];
  const agentEntry = { ...list[target.agentIndex] };
  const skillSettings = agentEntry.skillSettings ? { ...agentEntry.skillSettings } : {};
  if (params.nextEntry) {
    skillSettings[params.skillKey] = params.nextEntry;
  } else {
    delete skillSettings[params.skillKey];
  }
  if (Object.keys(skillSettings).length > 0) {
    agentEntry.skillSettings = skillSettings;
  } else {
    delete agentEntry.skillSettings;
  }
  list[target.agentIndex] = agentEntry;
  agents.list = list;
  return {
    ...params.cfg,
    agents,
  };
}

function resolveAgentWorkspaceTarget(params: { cfg: OpenClawConfig; agentId?: string }):
  | {
      ok: true;
      agentId: string;
      workspaceDir: string;
    }
  | {
      ok: false;
      error: string;
    } {
  const requestedAgentId = normalizeOptionalString(params.agentId) ?? "";
  const agentId = requestedAgentId
    ? normalizeAgentId(requestedAgentId)
    : resolveDefaultAgentId(params.cfg);
  if (requestedAgentId) {
    const knownAgents = listAgentIds(params.cfg);
    if (!knownAgents.includes(agentId)) {
      return {
        ok: false,
        error: `unknown agent id "${requestedAgentId}"`,
      };
    }
  }
  return {
    ok: true,
    agentId,
    workspaceDir: resolveAgentWorkspaceDir(params.cfg, agentId),
  };
}

function collectSkillBins(entries: SkillEntry[]): string[] {
  const bins = new Set<string>();
  for (const entry of entries) {
    const required = entry.metadata?.requires?.bins ?? [];
    const anyBins = entry.metadata?.requires?.anyBins ?? [];
    const install = entry.metadata?.install ?? [];
    for (const bin of required) {
      const trimmed = bin.trim();
      if (trimmed) {
        bins.add(trimmed);
      }
    }
    for (const bin of anyBins) {
      const trimmed = bin.trim();
      if (trimmed) {
        bins.add(trimmed);
      }
    }
    for (const spec of install) {
      const specBins = spec?.bins ?? [];
      for (const bin of specBins) {
        const trimmed = normalizeOptionalString(bin) ?? "";
        if (trimmed) {
          bins.add(trimmed);
        }
      }
    }
  }
  return [...bins].toSorted();
}

export const skillsHandlers: GatewayRequestHandlers = {
  "skills.status": ({ params, respond }) => {
    if (!validateSkillsStatusParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.status params: ${formatValidationErrors(validateSkillsStatusParams.errors)}`,
        ),
      );
      return;
    }
    const cfg = loadConfig();
    const agentIdRaw = normalizeOptionalString(params?.agentId) ?? "";
    const agentId = agentIdRaw ? normalizeAgentId(agentIdRaw) : resolveDefaultAgentId(cfg);
    if (agentIdRaw) {
      const knownAgents = listAgentIds(cfg);
      if (!knownAgents.includes(agentId)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `unknown agent id "${agentIdRaw}"`),
        );
        return;
      }
    }
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const report = buildWorkspaceSkillStatus(workspaceDir, {
      config: cfg,
      agentId,
      eligibility: {
        remote: getRemoteSkillEligibility({
          advertiseExecNode: canExecRequestNode({
            cfg,
            agentId,
          }),
        }),
      },
    });
    respond(true, report, undefined);
  },
  "skills.bins": ({ params, respond }) => {
    if (!validateSkillsBinsParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.bins params: ${formatValidationErrors(validateSkillsBinsParams.errors)}`,
        ),
      );
      return;
    }
    const cfg = loadConfig();
    const workspaceDirs = listAgentWorkspaceDirs(cfg);
    const bins = new Set<string>();
    for (const workspaceDir of workspaceDirs) {
      const entries = loadWorkspaceSkillEntries(workspaceDir, { config: cfg });
      for (const bin of collectSkillBins(entries)) {
        bins.add(bin);
      }
    }
    respond(true, { bins: [...bins].toSorted() }, undefined);
  },
  "skills.search": async ({ params, respond }) => {
    if (!validateSkillsSearchParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.search params: ${formatValidationErrors(validateSkillsSearchParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const results = await searchSkillsFromClawHub({
        query: (params as { query?: string }).query,
        limit: (params as { limit?: number }).limit,
      });
      respond(true, { results }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(err)));
    }
  },
  "skills.detail": async ({ params, respond }) => {
    if (!validateSkillsDetailParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.detail params: ${formatValidationErrors(validateSkillsDetailParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const detail = await fetchClawHubSkillDetail({
        slug: (params as { slug: string }).slug,
      });
      respond(true, detail, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(err)));
    }
  },
  "skills.install": async ({ params, respond }) => {
    if (!validateSkillsInstallParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.install params: ${formatValidationErrors(validateSkillsInstallParams.errors)}`,
        ),
      );
      return;
    }
    const cfg = loadConfig();
    if (params && typeof params === "object" && "source" in params && params.source === "clawhub") {
      const p = params as {
        source: "clawhub";
        slug: string;
        version?: string;
        force?: boolean;
        agentId?: string;
      };
      const target = resolveAgentWorkspaceTarget({
        cfg,
        agentId: p.agentId,
      });
      if (!target.ok) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, target.error));
        return;
      }
      const result = await installSkillFromClawHub({
        workspaceDir: target.workspaceDir,
        slug: p.slug,
        version: p.version,
        force: Boolean(p.force),
      });
      respond(
        result.ok,
        result.ok
          ? {
              ok: true,
              message: `Installed ${result.slug}@${result.version}`,
              stdout: "",
              stderr: "",
              code: 0,
              slug: result.slug,
              version: result.version,
              targetDir: result.targetDir,
            }
          : result,
        result.ok ? undefined : errorShape(ErrorCodes.UNAVAILABLE, result.error),
      );
      return;
    }
    const p = params as {
      name: string;
      installId: string;
      dangerouslyForceUnsafeInstall?: boolean;
      agentId?: string;
      timeoutMs?: number;
    };
    const target = resolveAgentWorkspaceTarget({
      cfg,
      agentId: p.agentId,
    });
    if (!target.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, target.error));
      return;
    }
    const result = await installSkill({
      workspaceDir: target.workspaceDir,
      skillName: p.name,
      installId: p.installId,
      dangerouslyForceUnsafeInstall: p.dangerouslyForceUnsafeInstall,
      timeoutMs: p.timeoutMs,
      config: cfg,
    });
    respond(
      result.ok,
      result,
      result.ok ? undefined : errorShape(ErrorCodes.UNAVAILABLE, result.message),
    );
  },
  "skills.update": async ({ params, respond }) => {
    if (!validateSkillsUpdateParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.update params: ${formatValidationErrors(validateSkillsUpdateParams.errors)}`,
        ),
      );
      return;
    }
    if (params && typeof params === "object" && "source" in params && params.source === "clawhub") {
      const p = params as {
        source: "clawhub";
        slug?: string;
        all?: boolean;
        agentId?: string;
      };
      if (!p.slug && !p.all) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, 'clawhub skills.update requires "slug" or "all"'),
        );
        return;
      }
      if (p.slug && p.all) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            'clawhub skills.update accepts either "slug" or "all", not both',
          ),
        );
        return;
      }
      const cfg = loadConfig();
      const target = resolveAgentWorkspaceTarget({
        cfg,
        agentId: p.agentId,
      });
      if (!target.ok) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, target.error));
        return;
      }
      const results = await updateSkillsFromClawHub({
        workspaceDir: target.workspaceDir,
        slug: p.slug,
      });
      const errors = results.filter((result) => !result.ok);
      respond(
        errors.length === 0,
        {
          ok: errors.length === 0,
          skillKey: p.slug ?? "*",
          config: {
            source: "clawhub",
            results,
          },
        },
        errors.length === 0
          ? undefined
          : errorShape(ErrorCodes.UNAVAILABLE, errors.map((result) => result.error).join("; ")),
      );
      return;
    }
    const p = params as {
      skillKey: string;
      agentId?: string;
      enabled?: boolean;
      apiKey?: string;
      env?: Record<string, string>;
      config?: Record<string, unknown>;
    };
    const cfg = loadConfig();
    const scopedAgentId = normalizeOptionalString(p.agentId) ?? undefined;
    const target = scopedAgentId
      ? resolveAgentWorkspaceTarget({
          cfg,
          agentId: scopedAgentId,
        })
      : null;
    if (target && !target.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, target.error));
      return;
    }
    const current = scopedAgentId
      ? cloneSkillConfigEntry(
          cfg.agents?.list?.find(
            (entry) => normalizeAgentId(entry.id) === normalizeAgentId(scopedAgentId),
          )?.skillSettings?.[p.skillKey] ??
            (normalizeAgentId(scopedAgentId) === resolveDefaultAgentId(cfg)
              ? cfg.agents?.defaults?.skillSettings?.[p.skillKey]
              : undefined),
        )
      : cloneSkillConfigEntry(cfg.skills?.entries?.[p.skillKey]);
    const nextEntry = applySkillConfigPatch({
      current,
      enabled: p.enabled,
      apiKey: p.apiKey,
      env: p.env,
      config: p.config,
    });
    const nextConfig = writeScopedSkillConfig({
      cfg,
      skillKey: p.skillKey,
      agentId: scopedAgentId,
      nextEntry,
    });
    await writeConfigFile(nextConfig);
    respond(
      true,
      {
        ok: true,
        skillKey: p.skillKey,
        ...(target?.ok ? { agentId: target.agentId } : {}),
        config: nextEntry ?? {},
      },
      undefined,
    );
  },
  "skills.import": async ({ params, respond }) => {
    if (!validateSkillsImportParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.import params: ${formatValidationErrors(validateSkillsImportParams.errors)}`,
        ),
      );
      return;
    }
    const cfg = loadConfig();
    if (params.source === "remote" && normalizeOptionalString(params.registry)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "custom npm registry is not supported for workspace skill import yet",
        ),
      );
      return;
    }
    const target = resolveAgentWorkspaceTarget({
      cfg,
      agentId: "agentId" in params ? params.agentId : undefined,
    });
    if (!target.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, target.error));
      return;
    }
    try {
      const result =
        params.source === "file"
          ? await installWorkspaceSkillFromArchive({
              archivePath: params.filePath,
              workspaceDir: target.workspaceDir,
              force: params.force,
              timeoutMs: params.timeoutMs,
            })
          : await installWorkspaceSkillFromNpmSpec({
              spec: params.package,
              workspaceDir: target.workspaceDir,
              registry: params.registry,
              force: params.force,
              timeoutMs: params.timeoutMs,
            });
      respond(
        result.ok,
        result.ok ? result : undefined,
        result.ok ? undefined : errorShape(ErrorCodes.UNAVAILABLE, result.message),
      );
    } catch (error) {
      const result = formatWorkspaceSkillImportError(error);
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, result.message));
    }
  },
  "skills.uninstall": async ({ params, respond }) => {
    if (!validateSkillsUninstallParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.uninstall params: ${formatValidationErrors(validateSkillsUninstallParams.errors)}`,
        ),
      );
      return;
    }
    const cfg = loadConfig();
    const target = resolveAgentWorkspaceTarget({
      cfg,
      agentId: params.agentId,
    });
    if (!target.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, target.error));
      return;
    }
    try {
      const result = await uninstallWorkspaceSkill({
        workspaceDir: target.workspaceDir,
        skillKey: params.skillKey,
        config: cfg,
        agentId: target.agentId,
      });
      respond(
        result.ok,
        result.ok ? result : undefined,
        result.ok ? undefined : errorShape(ErrorCodes.UNAVAILABLE, result.message),
      );
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
    }
  },
};

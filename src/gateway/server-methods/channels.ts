import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import {
  buildChannelUiCatalog,
  listChannelPluginCatalogEntries,
  type ChannelPluginCatalogEntry,
} from "../../channels/plugins/catalog.js";
import { resolveChannelDefaultAccountId } from "../../channels/plugins/helpers.js";
import {
  type ChannelId,
  getChannelPlugin,
  listChannelPlugins,
  normalizeChannelId,
} from "../../channels/plugins/index.js";
import { buildChannelAccountSnapshot } from "../../channels/plugins/status.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { ChannelAccountSnapshot } from "../../channels/plugins/types.public.js";
import { isCatalogChannelInstalled } from "../../commands/channel-setup/discovery.js";
import {
  installChannelSetupPluginFromCatalogEntry,
  reloadChannelSetupPluginRegistryForChannel,
} from "../../commands/channel-setup/plugin-install.js";
import { loadConfig, readConfigFileSnapshot, replaceConfigFile } from "../../config/config.js";
import { applyPluginAutoEnable } from "../../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getChannelActivity } from "../../infra/channel-activity.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";
import { defaultRuntime } from "../../runtime.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { runTasksWithConcurrency } from "../../utils/run-with-concurrency.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateChannelsStartParams,
  validateChannelsLogoutParams,
  validateChannelsCatalogParams,
  validateChannelsInstallParams,
  validateChannelsStatusParams,
} from "../protocol/index.js";
import type { ChannelRuntimeSnapshot } from "../server-channel-runtime.types.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";

type ChannelLogoutPayload = {
  channel: ChannelId;
  accountId: string;
  cleared: boolean;
  [key: string]: unknown;
};

type ChannelStartPayload = {
  channel: ChannelId;
  accountId: string;
  started: boolean;
};

function resolveAllowedChannelIds(env: NodeJS.ProcessEnv = process.env): Set<string> | null {
  const raw = env.OPENCLAW_CHANNEL_ALLOWLIST?.trim();
  if (!raw) {
    return null;
  }
  const ids = raw
    .split(/[,\s;]+/u)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return ids.length > 0 ? new Set(ids) : null;
}

function isAllowedChannelId(channelId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const allowed = resolveAllowedChannelIds(env);
  return !allowed || allowed.has(channelId.toLowerCase());
}

function filterAllowedChannelPlugins(plugins: ChannelPlugin[]): ChannelPlugin[] {
  return plugins.filter((plugin) => isAllowedChannelId(plugin.id));
}

type ChannelCatalogPayloadEntry = {
  id: string;
  pluginId?: string;
  label: string;
  detailLabel: string;
  systemImage?: string;
  blurb?: string;
  docsPath?: string;
  installed: boolean;
  configured: boolean;
  install: {
    npmSpec: string;
    defaultChoice?: string;
    minHostVersion?: string;
    expectedIntegrity?: string;
  };
  installSource?: unknown;
};

function resolveChannelCatalogWorkspaceDir(cfg: OpenClawConfig): string | undefined {
  return resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
}

const CHANNEL_STATUS_MAX_TIMEOUT_MS = 30_000;
const CHANNEL_STATUS_PROBE_CONCURRENCY = 5;

function resolveChannelsStatusTimeoutMs(params: { probe: boolean; timeoutMsRaw: unknown }): number {
  const fallback = params.probe ? CHANNEL_STATUS_MAX_TIMEOUT_MS : 10_000;
  if (typeof params.timeoutMsRaw !== "number" || !Number.isFinite(params.timeoutMsRaw)) {
    return fallback;
  }
  return Math.min(Math.max(1000, params.timeoutMsRaw), CHANNEL_STATUS_MAX_TIMEOUT_MS);
}

function resolveRuntimeAccountSnapshot(params: {
  runtime: ChannelRuntimeSnapshot;
  channelId: ChannelId;
  accountId: string;
}): ChannelAccountSnapshot | undefined {
  const accounts = params.runtime.channelAccounts[params.channelId];
  const direct = accounts?.[params.accountId];
  if (direct) {
    return direct;
  }
  const fallback = params.runtime.channels[params.channelId];
  return fallback?.accountId === params.accountId ? fallback : undefined;
}

function resolveChannelGatewayAccountId(params: {
  plugin: ChannelPlugin;
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string {
  return (
    normalizeOptionalString(params.accountId) ||
    params.plugin.config.defaultAccountId?.(params.cfg) ||
    params.plugin.config.listAccountIds(params.cfg)[0] ||
    DEFAULT_ACCOUNT_ID
  );
}

function readApprovedPluginPermissions(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = Array.from(
    new Set(
      value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry === "process.exec"),
    ),
  );
  return normalized.length > 0 ? normalized : undefined;
}

function toCatalogPayloadEntry(params: {
  entry: ChannelPluginCatalogEntry;
  installed: boolean;
  configured: boolean;
}): ChannelCatalogPayloadEntry {
  const install = params.entry.install;
  const detailLabel =
    params.entry.meta.detailLabel ?? params.entry.meta.selectionLabel ?? params.entry.meta.label;
  return {
    id: params.entry.id,
    ...(params.entry.pluginId ? { pluginId: params.entry.pluginId } : {}),
    label: params.entry.meta.label,
    detailLabel,
    ...(params.entry.meta.systemImage ? { systemImage: params.entry.meta.systemImage } : {}),
    ...(params.entry.meta.blurb ? { blurb: params.entry.meta.blurb } : {}),
    ...(params.entry.meta.docsPath ? { docsPath: params.entry.meta.docsPath } : {}),
    installed: params.installed,
    configured: params.configured,
    install: {
      npmSpec: install.npmSpec,
      ...(install.defaultChoice ? { defaultChoice: install.defaultChoice } : {}),
      ...(install.minHostVersion ? { minHostVersion: install.minHostVersion } : {}),
      ...(install.expectedIntegrity ? { expectedIntegrity: install.expectedIntegrity } : {}),
    },
    ...(params.entry.installSource ? { installSource: params.entry.installSource } : {}),
  };
}

async function isCatalogChannelConfigured(params: {
  cfg: OpenClawConfig;
  plugins: readonly ChannelPlugin[];
  channelId: string;
}): Promise<boolean> {
  const plugin = params.plugins.find((entry) => entry.id === params.channelId);
  if (!plugin) {
    return false;
  }
  const accountIds = plugin.config.listAccountIds(params.cfg);
  for (const accountId of accountIds) {
    const account = plugin.config.resolveAccount(params.cfg, accountId);
    const configured = plugin.config.isConfigured
      ? await plugin.config.isConfigured(account, params.cfg)
      : true;
    if (configured) {
      return true;
    }
  }
  return false;
}

export async function logoutChannelAccount(params: {
  channelId: ChannelId;
  accountId?: string | null;
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  plugin: ChannelPlugin;
}): Promise<ChannelLogoutPayload> {
  const resolvedAccountId = resolveChannelGatewayAccountId(params);
  const account = params.plugin.config.resolveAccount(params.cfg, resolvedAccountId);
  await params.context.stopChannel(params.channelId, resolvedAccountId);
  const result = await params.plugin.gateway?.logoutAccount?.({
    cfg: params.cfg,
    accountId: resolvedAccountId,
    account,
    runtime: defaultRuntime,
  });
  if (!result) {
    throw new Error(`Channel ${params.channelId} does not support logout`);
  }
  const cleared = result.cleared;
  const loggedOut = typeof result.loggedOut === "boolean" ? result.loggedOut : cleared;
  if (loggedOut) {
    params.context.markChannelLoggedOut(params.channelId, true, resolvedAccountId);
  }
  return {
    channel: params.channelId,
    accountId: resolvedAccountId,
    ...result,
    cleared,
  };
}

export async function startChannelAccount(params: {
  channelId: ChannelId;
  accountId?: string | null;
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  plugin: ChannelPlugin;
}): Promise<ChannelStartPayload> {
  if (!params.plugin.gateway?.startAccount) {
    throw new Error(`Channel ${params.channelId} does not support runtime start`);
  }
  const resolvedAccountId = resolveChannelGatewayAccountId(params);
  await params.context.startChannel(params.channelId, resolvedAccountId);
  const runtime = params.context.getRuntimeSnapshot();
  const started =
    resolveRuntimeAccountSnapshot({
      runtime,
      channelId: params.channelId,
      accountId: resolvedAccountId,
    })?.running === true;
  return {
    channel: params.channelId,
    accountId: resolvedAccountId,
    started,
  };
}

export const channelsHandlers: GatewayRequestHandlers = {
  "channels.catalog": async ({ params, respond }) => {
    if (!validateChannelsCatalogParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid channels.catalog params: ${formatValidationErrors(validateChannelsCatalogParams.errors)}`,
        ),
      );
      return;
    }

    try {
      const snapshot = await readConfigFileSnapshot();
      if (!snapshot.valid) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "config invalid; fix it before listing channels"),
        );
        return;
      }
      const cfg = applyPluginAutoEnable({
        config: snapshot.sourceConfig ?? snapshot.config,
        env: process.env,
      }).config;
      const plugins = filterAllowedChannelPlugins(listChannelPlugins());
      const includeInstalled =
        (params as { includeInstalled?: boolean }).includeInstalled !== false;
      const includeInstallable =
        (params as { includeInstallable?: boolean }).includeInstallable !== false;

      const entries: ChannelCatalogPayloadEntry[] = [];
      const workspaceDir = resolveChannelCatalogWorkspaceDir(cfg);
      for (const entry of listChannelPluginCatalogEntries({ workspaceDir })) {
        if (!isAllowedChannelId(entry.id)) {
          continue;
        }
        const installed = isCatalogChannelInstalled({ cfg, entry, workspaceDir });
        if ((installed && !includeInstalled) || (!installed && !includeInstallable)) {
          continue;
        }
        const configured = await isCatalogChannelConfigured({
          cfg,
          plugins,
          channelId: entry.id,
        });
        entries.push(toCatalogPayloadEntry({ entry, installed, configured }));
      }

      respond(true, { ts: Date.now(), entries }, undefined);
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(error)));
    }
  },
  "channels.install": async ({ params, respond }) => {
    if (!validateChannelsInstallParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid channels.install params: ${formatValidationErrors(validateChannelsInstallParams.errors)}`,
        ),
      );
      return;
    }

    const channel = normalizeOptionalString((params as { channel?: unknown }).channel);
    if (!channel) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid channel"));
      return;
    }

    try {
      const snapshot = await readConfigFileSnapshot();
      if (!snapshot.valid) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "config invalid; fix it before installing channels",
          ),
        );
        return;
      }
      const cfg = snapshot.sourceConfig ?? snapshot.config;
      const workspaceDir = resolveChannelCatalogWorkspaceDir(cfg);
      const entry = listChannelPluginCatalogEntries({ workspaceDir }).find(
        (candidate) => candidate.id === channel && isAllowedChannelId(candidate.id),
      );
      if (!entry) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `unknown installable channel: ${channel}`),
        );
        return;
      }
      if (isCatalogChannelInstalled({ cfg, entry, workspaceDir })) {
        respond(
          true,
          {
            channel: entry.id,
            pluginId: entry.pluginId ?? entry.id,
            installed: false,
            alreadyInstalled: true,
          },
          undefined,
        );
        return;
      }

      const result = await installChannelSetupPluginFromCatalogEntry({
        cfg,
        entry,
        runtime: defaultRuntime,
        approvedPluginPermissions: readApprovedPluginPermissions(
          (params as { approvedPluginPermissions?: unknown }).approvedPluginPermissions,
        ),
        timeoutMs: (params as { timeoutMs?: number }).timeoutMs,
      });

      if (!result.ok) {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, result.error));
        return;
      }

      await replaceConfigFile({
        nextConfig: result.cfg,
        ...(snapshot.hash !== undefined ? { baseHash: snapshot.hash } : {}),
      });
      reloadChannelSetupPluginRegistryForChannel({
        cfg: result.cfg,
        runtime: defaultRuntime,
        channel: entry.id,
        pluginId: result.pluginId,
      });

      respond(
        true,
        {
          channel: entry.id,
          pluginId: result.pluginId,
          installed: result.installed,
          alreadyInstalled: false,
          ...(result.targetDir ? { targetDir: result.targetDir } : {}),
          ...(result.version ? { version: result.version } : {}),
          ...(result.approvedPermissions && result.approvedPermissions.length > 0
            ? { approvedPermissions: result.approvedPermissions }
            : {}),
        },
        undefined,
      );
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(error)));
    }
  },
  "channels.status": async ({ params, respond, context }) => {
    if (!validateChannelsStatusParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid channels.status params: ${formatValidationErrors(validateChannelsStatusParams.errors)}`,
        ),
      );
      return;
    }
    const probe = (params as { probe?: boolean }).probe === true;
    const timeoutMsRaw = (params as { timeoutMs?: unknown }).timeoutMs;
    const timeoutMs = resolveChannelsStatusTimeoutMs({ probe, timeoutMsRaw });
    const cfg = applyPluginAutoEnable({
      config: loadConfig(),
      env: process.env,
    }).config;
    const runtime = context.getRuntimeSnapshot();
    const plugins = filterAllowedChannelPlugins(listChannelPlugins());
    const pluginMap = new Map<ChannelId, ChannelPlugin>(
      plugins.map((plugin) => [plugin.id, plugin]),
    );

    const resolveRuntimeSnapshot = (
      channelId: ChannelId,
      accountId: string,
      defaultAccountId: string,
    ): ChannelAccountSnapshot | undefined => {
      const accounts = runtime.channelAccounts[channelId];
      const defaultRuntime = runtime.channels[channelId];
      const raw =
        accounts?.[accountId] ?? (accountId === defaultAccountId ? defaultRuntime : undefined);
      if (!raw) {
        return undefined;
      }
      return raw;
    };

    const isAccountEnabled = (plugin: ChannelPlugin, account: unknown) =>
      plugin.config.isEnabled
        ? plugin.config.isEnabled(account, cfg)
        : !account ||
          typeof account !== "object" ||
          (account as { enabled?: boolean }).enabled !== false;

    const buildAccountSnapshot = async (
      channelId: ChannelId,
      plugin: ChannelPlugin,
      accountId: string,
      defaultAccountId: string,
    ) => {
      const account = plugin.config.resolveAccount(cfg, accountId);
      const enabled = isAccountEnabled(plugin, account);
      let probeResult: unknown;
      let lastProbeAt: number | null = null;
      if (probe && enabled && plugin.status?.probeAccount) {
        let configured = true;
        if (plugin.config.isConfigured) {
          configured = await plugin.config.isConfigured(account, cfg);
        }
        if (configured) {
          probeResult = await plugin.status.probeAccount({
            account,
            timeoutMs,
            cfg,
          });
          lastProbeAt = Date.now();
        }
      }
      let auditResult: unknown;
      if (probe && enabled && plugin.status?.auditAccount) {
        let configured = true;
        if (plugin.config.isConfigured) {
          configured = await plugin.config.isConfigured(account, cfg);
        }
        if (configured) {
          auditResult = await plugin.status.auditAccount({
            account,
            timeoutMs,
            cfg,
            probe: probeResult,
          });
        }
      }
      const runtimeSnapshot = resolveRuntimeSnapshot(channelId, accountId, defaultAccountId);
      const snapshot = await buildChannelAccountSnapshot({
        plugin,
        cfg,
        accountId,
        runtime: runtimeSnapshot,
        probe: probeResult,
        audit: auditResult,
      });
      if (lastProbeAt) {
        snapshot.lastProbeAt = lastProbeAt;
      }
      const activity = getChannelActivity({
        channel: channelId as never,
        accountId,
      });
      if (snapshot.lastInboundAt == null) {
        snapshot.lastInboundAt = activity.inboundAt;
      }
      if (snapshot.lastOutboundAt == null) {
        snapshot.lastOutboundAt = activity.outboundAt;
      }
      return { accountId: accountId, account, snapshot };
    };

    const buildChannelAccounts = async (channelId: ChannelId) => {
      const plugin = pluginMap.get(channelId);
      if (!plugin) {
        return {
          accounts: [] as ChannelAccountSnapshot[],
          defaultAccountId: DEFAULT_ACCOUNT_ID,
          defaultAccount: undefined as ChannelAccountSnapshot | undefined,
          resolvedAccounts: {} as Record<string, unknown>,
        };
      }
      const accountIds = plugin.config.listAccountIds(cfg);
      const defaultAccountId = resolveChannelDefaultAccountId({
        plugin,
        cfg,
        accountIds,
      });
      const resolvedAccounts: Record<string, unknown> = {};
      const { results } = await runTasksWithConcurrency({
        tasks: accountIds.map(
          (accountId) => async () =>
            await buildAccountSnapshot(channelId, plugin, accountId, defaultAccountId),
        ),
        limit: probe ? CHANNEL_STATUS_PROBE_CONCURRENCY : accountIds.length || 1,
      });
      const accounts: ChannelAccountSnapshot[] = [];
      for (const result of results) {
        if (result) {
          resolvedAccounts[result.accountId] = result.account;
          accounts.push(result.snapshot);
        }
      }
      const defaultAccount =
        accounts.find((entry) => entry.accountId === defaultAccountId) ?? accounts[0];
      return { accounts, defaultAccountId, defaultAccount, resolvedAccounts };
    };

    const uiCatalog = buildChannelUiCatalog(plugins);
    const payload: Record<string, unknown> = {
      ts: Date.now(),
      channelOrder: uiCatalog.order,
      channelLabels: uiCatalog.labels,
      channelDetailLabels: uiCatalog.detailLabels,
      channelSystemImages: uiCatalog.systemImages,
      channelMeta: uiCatalog.entries,
      channels: {} as Record<string, unknown>,
      channelAccounts: {} as Record<string, unknown>,
      channelDefaultAccountId: {} as Record<string, unknown>,
    };
    const channelsMap = payload.channels as Record<string, unknown>;
    const accountsMap = payload.channelAccounts as Record<string, unknown>;
    const defaultAccountIdMap = payload.channelDefaultAccountId as Record<string, unknown>;
    const { results: channelResults } = await runTasksWithConcurrency({
      tasks: plugins.map((plugin) => async () => {
        const { accounts, defaultAccountId, defaultAccount, resolvedAccounts } =
          await buildChannelAccounts(plugin.id);
        const fallbackAccount =
          resolvedAccounts[defaultAccountId] ?? plugin.config.resolveAccount(cfg, defaultAccountId);
        const summary = plugin.status?.buildChannelSummary
          ? await plugin.status.buildChannelSummary({
              account: fallbackAccount,
              cfg,
              defaultAccountId,
              snapshot:
                defaultAccount ??
                ({
                  accountId: defaultAccountId,
                } as ChannelAccountSnapshot),
            })
          : {
              configured: defaultAccount?.configured ?? false,
            };
        return { pluginId: plugin.id, summary, accounts, defaultAccountId };
      }),
      limit: probe ? CHANNEL_STATUS_PROBE_CONCURRENCY : plugins.length || 1,
    });
    for (const result of channelResults) {
      if (result) {
        channelsMap[result.pluginId] = result.summary;
        accountsMap[result.pluginId] = result.accounts;
        defaultAccountIdMap[result.pluginId] = result.defaultAccountId;
      }
    }

    respond(true, payload, undefined);
  },
  "channels.start": async ({ params, respond, context }) => {
    if (!validateChannelsStartParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid channels.start params: ${formatValidationErrors(validateChannelsStartParams.errors)}`,
        ),
      );
      return;
    }
    const rawChannel = (params as { channel?: unknown }).channel;
    const channelId = typeof rawChannel === "string" ? normalizeChannelId(rawChannel) : null;
    if (!channelId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid channels.start channel"),
      );
      return;
    }
    const plugin = getChannelPlugin(channelId);
    if (!plugin) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `unknown channel: ${formatForLog(rawChannel)}`),
      );
      return;
    }
    if (!plugin.gateway?.startAccount) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `channel ${channelId} does not support start`),
      );
      return;
    }
    try {
      const cfg = applyPluginAutoEnable({
        config: loadConfig(),
        env: process.env,
      }).config;
      const payload = await startChannelAccount({
        channelId,
        accountId: (params as { accountId?: string | null }).accountId,
        cfg,
        context,
        plugin,
      });
      respond(true, payload, undefined);
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(error)));
    }
  },
  "channels.logout": async ({ params, respond, context }) => {
    if (!validateChannelsLogoutParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid channels.logout params: ${formatValidationErrors(validateChannelsLogoutParams.errors)}`,
        ),
      );
      return;
    }
    const rawChannel = (params as { channel?: unknown }).channel;
    const channelId = typeof rawChannel === "string" ? normalizeChannelId(rawChannel) : null;
    if (!channelId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid channels.logout channel"),
      );
      return;
    }
    const plugin = getChannelPlugin(channelId);
    if (!plugin?.gateway?.logoutAccount) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `channel ${channelId} does not support logout`),
      );
      return;
    }
    const accountIdRaw = (params as { accountId?: unknown }).accountId;
    const accountId = normalizeOptionalString(accountIdRaw);
    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.valid) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "config invalid; fix it before logging out"),
      );
      return;
    }
    try {
      const payload = await logoutChannelAccount({
        channelId,
        accountId,
        cfg: snapshot.config ?? {},
        context,
        plugin,
      });
      respond(true, payload, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
};

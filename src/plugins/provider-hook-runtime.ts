import { normalizeProviderId } from "../agents/provider-id.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizePluginIdScope, serializePluginIdScope } from "./plugin-scope.js";
import { isPluginProvidersLoadInFlight, resolvePluginProviders } from "./providers.runtime.js";
import { resolvePluginCacheInputs } from "./roots.js";
import { getActivePluginRegistryWorkspaceDirFromState } from "./runtime-state.js";
import { getActivePluginRegistry } from "./runtime.js";
import type {
  ProviderPlugin,
  ProviderExtraParamsForTransportContext,
  ProviderPrepareExtraParamsContext,
  ProviderResolveAuthProfileIdContext,
  ProviderFollowupFallbackRouteContext,
  ProviderFollowupFallbackRouteResult,
  ProviderWrapStreamFnContext,
} from "./types.js";

function matchesProviderId(provider: ProviderPlugin, providerId: string): boolean {
  const normalized = normalizeProviderId(providerId);
  if (!normalized) {
    return false;
  }
  if (normalizeProviderId(provider.id) === normalized) {
    return true;
  }
  return [...(provider.aliases ?? []), ...(provider.hookAliases ?? [])].some(
    (alias) => normalizeProviderId(alias) === normalized,
  );
}

function resolveActiveProviderPlugin(params: {
  provider: string;
  workspaceDir?: string;
}): ProviderPlugin | undefined {
  const activeWorkspaceDir = getActivePluginRegistryWorkspaceDirFromState();
  if (params.workspaceDir && activeWorkspaceDir && params.workspaceDir !== activeWorkspaceDir) {
    return undefined;
  }
  if (params.workspaceDir && !activeWorkspaceDir) {
    return undefined;
  }
  return getActivePluginRegistry()
    ?.providers.map((entry) => Object.assign({}, entry.provider, { pluginId: entry.pluginId }))
    .find((candidate) => matchesProviderId(candidate, params.provider));
}

let cachedHookProvidersWithoutConfig = new WeakMap<
  NodeJS.ProcessEnv,
  Map<string, ProviderPlugin[]>
>();
let cachedHookProvidersByConfig = new WeakMap<
  OpenClawConfig,
  WeakMap<NodeJS.ProcessEnv, Map<string, ProviderPlugin[]>>
>();

function resolveHookProviderCacheBucket(params: {
  config?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}) {
  if (!params.config) {
    let bucket = cachedHookProvidersWithoutConfig.get(params.env);
    if (!bucket) {
      bucket = new Map<string, ProviderPlugin[]>();
      cachedHookProvidersWithoutConfig.set(params.env, bucket);
    }
    return bucket;
  }

  let envBuckets = cachedHookProvidersByConfig.get(params.config);
  if (!envBuckets) {
    envBuckets = new WeakMap<NodeJS.ProcessEnv, Map<string, ProviderPlugin[]>>();
    cachedHookProvidersByConfig.set(params.config, envBuckets);
  }
  let bucket = envBuckets.get(params.env);
  if (!bucket) {
    bucket = new Map<string, ProviderPlugin[]>();
    envBuckets.set(params.env, bucket);
  }
  return bucket;
}

function buildHookProviderCacheKey(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  onlyPluginIds?: string[];
  providerRefs?: readonly string[];
  modelRefs?: readonly string[];
  env?: NodeJS.ProcessEnv;
}) {
  const { roots } = resolvePluginCacheInputs({
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  const onlyPluginIds = normalizePluginIdScope(params.onlyPluginIds);
  return `${roots.workspace ?? ""}::${roots.global}::${roots.stock ?? ""}::${JSON.stringify(params.config ?? null)}::${serializePluginIdScope(onlyPluginIds)}::${JSON.stringify(params.providerRefs ?? [])}::${JSON.stringify(params.modelRefs ?? [])}`;
}

export function clearProviderRuntimeHookCache(): void {
  cachedHookProvidersWithoutConfig = new WeakMap<
    NodeJS.ProcessEnv,
    Map<string, ProviderPlugin[]>
  >();
  cachedHookProvidersByConfig = new WeakMap<
    OpenClawConfig,
    WeakMap<NodeJS.ProcessEnv, Map<string, ProviderPlugin[]>>
  >();
}

export function resetProviderRuntimeHookCacheForTest(): void {
  clearProviderRuntimeHookCache();
}

export const __testing = {
  buildHookProviderCacheKey,
} as const;

export function resolveProviderPluginsForHooks(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  onlyPluginIds?: string[];
  providerRefs?: readonly string[];
  modelRefs?: readonly string[];
}): ProviderPlugin[] {
  const env = params.env ?? process.env;
  const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromState();
  const cacheBucket = resolveHookProviderCacheBucket({
    config: params.config,
    env,
  });
  const cacheKey = buildHookProviderCacheKey({
    config: params.config,
    workspaceDir,
    onlyPluginIds: params.onlyPluginIds,
    providerRefs: params.providerRefs,
    modelRefs: params.modelRefs,
    env,
  });
  const cached = cacheBucket.get(cacheKey);
  if (cached) {
    return cached;
  }
  if (
    isPluginProvidersLoadInFlight({
      ...params,
      workspaceDir,
      env,
      activate: false,
      cache: false,
      bundledProviderAllowlistCompat: true,
      bundledProviderVitestCompat: true,
    })
  ) {
    return [];
  }
  const resolved = resolvePluginProviders({
    ...params,
    workspaceDir,
    env,
    activate: false,
    cache: false,
    bundledProviderAllowlistCompat: true,
    bundledProviderVitestCompat: true,
  });
  cacheBucket.set(cacheKey, resolved);
  return resolved;
}

export function resolveProviderRuntimePlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): ProviderPlugin | undefined {
  const activeProvider = resolveActiveProviderPlugin({
    provider: params.provider,
    workspaceDir: params.workspaceDir,
  });
  if (activeProvider) {
    return activeProvider;
  }
  return resolveProviderPluginsForHooks({
    config: params.config,
    workspaceDir: params.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromState(),
    env: params.env,
    providerRefs: [params.provider],
  }).find((plugin) => matchesProviderId(plugin, params.provider));
}

function dedupeProviderPlugins(plugins: Array<ProviderPlugin | undefined>): ProviderPlugin[] {
  const seen = new Set<string>();
  const deduped: ProviderPlugin[] = [];
  for (const plugin of plugins) {
    if (!plugin) {
      continue;
    }
    const key = `${plugin.pluginId ?? ""}:${plugin.id}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(plugin);
  }
  return deduped;
}

export function resolveProviderScopedHookPlugins(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): ProviderPlugin[] {
  const activeProvider = resolveActiveProviderPlugin({
    provider: params.provider,
    workspaceDir: params.workspaceDir,
  });
  const runtimeProviders = resolveProviderPluginsForHooks({
    config: params.config,
    workspaceDir: params.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromState(),
    env: params.env,
    providerRefs: [params.provider],
  }).filter((plugin) => matchesProviderId(plugin, params.provider));
  return dedupeProviderPlugins([activeProvider, ...runtimeProviders]);
}

export function resolveProviderHookPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): ProviderPlugin | undefined {
  return resolveProviderScopedHookPlugins(params)[0];
}

export function prepareProviderExtraParams(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderPrepareExtraParamsContext;
}) {
  return resolveProviderRuntimePlugin(params)?.prepareExtraParams?.(params.context) ?? undefined;
}

export function resolveProviderExtraParamsForTransport(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderExtraParamsForTransportContext;
}) {
  return resolveProviderHookPlugin(params)?.extraParamsForTransport?.(params.context) ?? undefined;
}

export function resolveProviderAuthProfileId(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderResolveAuthProfileIdContext;
}): string | undefined {
  const resolved = resolveProviderHookPlugin(params)?.resolveAuthProfileId?.(params.context);
  return typeof resolved === "string" && resolved.trim() ? resolved.trim() : undefined;
}

export function resolveProviderFollowupFallbackRoute(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderFollowupFallbackRouteContext;
}): ProviderFollowupFallbackRouteResult | undefined {
  return resolveProviderHookPlugin(params)?.followupFallbackRoute?.(params.context) ?? undefined;
}

export function wrapProviderStreamFn(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderWrapStreamFnContext;
}) {
  return resolveProviderHookPlugin(params)?.wrapStreamFn?.(params.context) ?? undefined;
}

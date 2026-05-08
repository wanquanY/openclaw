import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { loadPluginManifestRegistry } from "../plugins/manifest-registry.js";
import {
  collectChannelSchemaMetadata,
  collectPluginSchemaMetadata,
} from "./channel-config-metadata.js";
import { loadConfig, readConfigFileSnapshot } from "./config.js";
import type { OpenClawConfig } from "./config.js";
import { buildConfigSchema, type ConfigSchemaResponse } from "./schema.js";

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

function filterChannelSchemaMetadata<T extends { id: string }>(
  channels: T[],
  env: NodeJS.ProcessEnv = process.env,
): T[] {
  const allowed = resolveAllowedChannelIds(env);
  if (!allowed) {
    return channels;
  }
  return channels.filter((channel) => allowed.has(channel.id.toLowerCase()));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pruneConfigSchemaChannels(
  response: ConfigSchemaResponse,
  env: NodeJS.ProcessEnv = process.env,
): ConfigSchemaResponse {
  const allowed = resolveAllowedChannelIds(env);
  if (!allowed) {
    return response;
  }
  const next = structuredClone(response) as ConfigSchemaResponse;
  const root = isRecord(next.schema) ? next.schema : null;
  const properties = isRecord(root?.properties) ? root.properties : null;
  const channels = isRecord(properties?.channels) ? properties.channels : null;
  const channelProperties = isRecord(channels?.properties) ? channels.properties : null;
  if (channelProperties) {
    for (const channelId of Object.keys(channelProperties)) {
      if (!allowed.has(channelId.toLowerCase())) {
        delete channelProperties[channelId];
      }
    }
  }
  return next;
}

function loadManifestRegistry(config: OpenClawConfig, env?: NodeJS.ProcessEnv) {
  const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
  return loadPluginManifestRegistry({
    config,
    cache: false,
    env,
    workspaceDir,
  });
}

export function loadGatewayRuntimeConfigSchema(): ConfigSchemaResponse {
  const config = loadConfig();
  const registry = loadManifestRegistry(config);
  return pruneConfigSchemaChannels(
    buildConfigSchema({
      plugins: collectPluginSchemaMetadata(registry),
      channels: filterChannelSchemaMetadata(collectChannelSchemaMetadata(registry)),
    }),
  );
}

export async function readBestEffortRuntimeConfigSchema(): Promise<ConfigSchemaResponse> {
  const snapshot = await readConfigFileSnapshot();
  const config = snapshot.valid ? snapshot.config : { plugins: { enabled: true } };
  const registry = loadManifestRegistry(config);
  return pruneConfigSchemaChannels(
    buildConfigSchema({
      plugins: snapshot.valid ? collectPluginSchemaMetadata(registry) : [],
      channels: filterChannelSchemaMetadata(collectChannelSchemaMetadata(registry)),
    }),
  );
}

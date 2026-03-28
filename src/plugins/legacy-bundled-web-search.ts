const LEGACY_BUNDLED_WEB_SEARCH_PLUGIN_IDS = ["serper"] as const;

const LEGACY_BUNDLED_WEB_SEARCH_PROVIDER_PLUGIN_IDS = {
  serper: "serper",
} as const;

export function listLegacyBundledWebSearchPluginIds(): string[] {
  return [...LEGACY_BUNDLED_WEB_SEARCH_PLUGIN_IDS];
}

export function resolveLegacyBundledWebSearchPluginId(
  providerId: string | undefined,
): string | undefined {
  if (!providerId) {
    return undefined;
  }
  const normalizedProviderId = providerId.trim().toLowerCase();
  return LEGACY_BUNDLED_WEB_SEARCH_PROVIDER_PLUGIN_IDS[
    normalizedProviderId as keyof typeof LEGACY_BUNDLED_WEB_SEARCH_PROVIDER_PLUGIN_IDS
  ];
}

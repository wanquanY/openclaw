import { listBundledWebSearchProviderEntries } from "../bundled-web-search.entries.js";
import { resolveLegacyBundledWebSearchPluginId } from "./legacy-bundled-web-search.js";

export const BUNDLED_WEB_SEARCH_PROVIDER_PLUGIN_IDS = Object.fromEntries(
  listBundledWebSearchProviderEntries()
    .map((entry) => [entry.id, entry.pluginId] as const)
    .toSorted(([left], [right]) => left.localeCompare(right)),
) as Readonly<Record<string, string>>;

export function resolveBundledWebSearchPluginId(
  providerId: string | undefined,
): string | undefined {
  if (!providerId) {
    return undefined;
  }
  const normalizedProviderId = providerId.trim().toLowerCase();
  if (!(normalizedProviderId in BUNDLED_WEB_SEARCH_PROVIDER_PLUGIN_IDS)) {
    return resolveLegacyBundledWebSearchPluginId(normalizedProviderId);
  }
  return BUNDLED_WEB_SEARCH_PROVIDER_PLUGIN_IDS[normalizedProviderId];
}

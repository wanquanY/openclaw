import { listBundledWebSearchProviderEntries } from "../bundled-web-search.entries.js";
import { listLegacyBundledWebSearchPluginIds } from "./legacy-bundled-web-search.js";

const BUNDLED_WEB_SEARCH_PLUGIN_IDS_FROM_METADATA =
  listBundledWebSearchProviderEntries().map(({ pluginId }) => pluginId);

export const BUNDLED_WEB_SEARCH_PLUGIN_IDS = [
  ...new Set([
    ...BUNDLED_WEB_SEARCH_PLUGIN_IDS_FROM_METADATA,
    ...listLegacyBundledWebSearchPluginIds(),
  ]),
].toSorted((left, right) => left.localeCompare(right));

export function listBundledWebSearchPluginIds(): string[] {
  return [...BUNDLED_WEB_SEARCH_PLUGIN_IDS];
}

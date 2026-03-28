import { BUNDLED_WEB_SEARCH_PLUGIN_IDS as BUNDLED_WEB_SEARCH_PLUGIN_IDS_FROM_METADATA } from "./bundled-capability-metadata.js";
import { listLegacyBundledWebSearchPluginIds } from "./legacy-bundled-web-search.js";

export const BUNDLED_WEB_SEARCH_PLUGIN_IDS = [
  ...new Set([
    ...BUNDLED_WEB_SEARCH_PLUGIN_IDS_FROM_METADATA,
    ...listLegacyBundledWebSearchPluginIds(),
  ]),
].toSorted((left, right) => left.localeCompare(right));

export function listBundledWebSearchPluginIds(): string[] {
  return [...BUNDLED_WEB_SEARCH_PLUGIN_IDS];
}

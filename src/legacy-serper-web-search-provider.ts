import type { OpenClawConfig } from "./config/config.js";
import type { PluginWebSearchProviderEntry } from "./plugins/types.js";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ensureRecord(target: JsonRecord, key: string): JsonRecord {
  const current = target[key];
  if (isRecord(current)) {
    return current;
  }
  const next: JsonRecord = {};
  target[key] = next;
  return next;
}

function readTopLevelSerperApiKey(config?: OpenClawConfig): unknown {
  const search = config?.tools?.web?.search;
  if (!search || typeof search !== "object") {
    return undefined;
  }
  const serper = "serper" in search ? search.serper : undefined;
  if (!serper || typeof serper !== "object" || Array.isArray(serper)) {
    return undefined;
  }
  return (serper as { apiKey?: unknown }).apiKey;
}

function writeTopLevelSerperApiKey(configTarget: OpenClawConfig, value: unknown): void {
  const tools = ensureRecord(configTarget as JsonRecord, "tools");
  const web = ensureRecord(tools, "web");
  const search = ensureRecord(web, "search");
  const serper = ensureRecord(search, "serper");
  serper.apiKey = value;
}

export function createLegacySerperWebSearchProviderEntry(): PluginWebSearchProviderEntry {
  return {
    pluginId: "serper",
    id: "serper",
    label: "Serper",
    hint: "Requires Serper API key · Google Search API",
    credentialLabel: "Serper API key",
    envVars: ["SERPER_API_KEY"],
    placeholder: "serper-...",
    signupUrl: "https://serper.dev/",
    docsUrl: "https://docs.openclaw.ai/tools/web",
    autoDetectOrder: 15,
    credentialPath: "tools.web.search.serper.apiKey",
    inactiveSecretPaths: ["tools.web.search.serper.apiKey"],
    getCredentialValue: (searchConfig) => {
      const serper = searchConfig?.serper;
      if (!serper || typeof serper !== "object" || Array.isArray(serper)) {
        return undefined;
      }
      return (serper as { apiKey?: unknown }).apiKey;
    },
    setCredentialValue: (searchConfigTarget, value) => {
      const serper = ensureRecord(searchConfigTarget, "serper");
      serper.apiKey = value;
    },
    getConfiguredCredentialValue: (config) => readTopLevelSerperApiKey(config),
    setConfiguredCredentialValue: (configTarget, value) => {
      writeTopLevelSerperApiKey(configTarget, value);
    },
    // Serper still uses the legacy built-in execution path, so selecting it
    // should not synthesize a plugin enablement entry.
    applySelectionConfig: (config) => config,
    createTool: () => null,
  };
}

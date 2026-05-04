import {
  readClaudeCliCredentialsCached,
  readCodexCliCredentialsCached,
  readMiniMaxCliCredentialsCached,
} from "../cli-credentials.js";
import { normalizeProviderId } from "../provider-id.js";
import {
  CLAUDE_CLI_PROFILE_ID,
  EXTERNAL_CLI_SYNC_TTL_MS,
  MINIMAX_CLI_PROFILE_ID,
  OPENAI_CODEX_DEFAULT_PROFILE_ID,
} from "./constants.js";
import { log } from "./constants.js";
import {
  areOAuthCredentialsEquivalent,
  hasUsableOAuthCredential,
  isSafeToAdoptBootstrapOAuthIdentity,
  isSafeToOverwriteStoredOAuthIdentity,
  shouldBootstrapFromExternalCliCredential,
  shouldReplaceStoredOAuthCredential,
} from "./oauth-shared.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

export {
  areOAuthCredentialsEquivalent,
  hasUsableOAuthCredential,
  isSafeToAdoptBootstrapOAuthIdentity,
  isSafeToOverwriteStoredOAuthIdentity,
  shouldBootstrapFromExternalCliCredential,
  shouldReplaceStoredOAuthCredential,
} from "./oauth-shared.js";

export type ExternalCliResolvedProfile = {
  profileId: string;
  credential: OAuthCredential;
};

type ExternalCliSyncProvider = {
  profileId: string;
  provider: string;
  providerRefs: readonly string[];
  readCredentials: (options?: ExternalCliAuthProfileResolutionOptions) => OAuthCredential | null;
  // bootstrapOnly providers adopt the external CLI credential only to
  // seed an empty slot; once a local OAuth credential exists for the
  // profile, the local refresh token is treated as canonical and the
  // CLI state must not replace or shadow it. Codex requires this to
  // avoid clobbering a locally refreshed token with stale CLI state.
  bootstrapOnly?: boolean;
};

export type ExternalCliAuthProfileResolutionOptions = {
  providerRefs?: readonly string[];
  allowKeychainPrompt?: boolean;
};

function normalizeAuthIdentityToken(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeAuthEmailToken(value: string | undefined): string | undefined {
  return normalizeAuthIdentityToken(value)?.toLowerCase();
}

// Keep this gate aligned with the canonical identity-copy rule in oauth.ts.
export function isSafeToUseExternalCliCredential(
  existing: OAuthCredential | undefined,
  imported: OAuthCredential,
): boolean {
  if (!existing) {
    return true;
  }
  if (existing.provider !== imported.provider) {
    return false;
  }

  const existingAccountId = normalizeAuthIdentityToken(existing.accountId);
  const importedAccountId = normalizeAuthIdentityToken(imported.accountId);
  const existingEmail = normalizeAuthEmailToken(existing.email);
  const importedEmail = normalizeAuthEmailToken(imported.email);

  if (existingAccountId !== undefined && importedAccountId !== undefined) {
    return existingAccountId === importedAccountId;
  }
  if (existingEmail !== undefined && importedEmail !== undefined) {
    return existingEmail === importedEmail;
  }

  const existingHasIdentity = existingAccountId !== undefined || existingEmail !== undefined;
  if (existingHasIdentity) {
    return false;
  }
  return true;
}

const EXTERNAL_CLI_SYNC_PROVIDERS: ExternalCliSyncProvider[] = [
  {
    profileId: OPENAI_CODEX_DEFAULT_PROFILE_ID,
    provider: "openai-codex",
    providerRefs: ["openai-codex", "codex-cli"],
    readCredentials: (options) =>
      readCodexCliCredentialsCached({
        ttlMs: EXTERNAL_CLI_SYNC_TTL_MS,
        allowKeychainPrompt: options?.allowKeychainPrompt,
      }),
    bootstrapOnly: true,
  },
  {
    profileId: CLAUDE_CLI_PROFILE_ID,
    provider: "claude-cli",
    providerRefs: ["anthropic", "claude-cli"],
    readCredentials: (options) => {
      const credential = readClaudeCliCredentialsCached({
        ttlMs: EXTERNAL_CLI_SYNC_TTL_MS,
        allowKeychainPrompt: options?.allowKeychainPrompt,
      });
      if (credential?.type !== "oauth") {
        return null;
      }
      return { ...credential, provider: "claude-cli" };
    },
  },
  {
    profileId: MINIMAX_CLI_PROFILE_ID,
    provider: "minimax-portal",
    providerRefs: ["minimax-portal", "minimax"],
    readCredentials: () => readMiniMaxCliCredentialsCached({ ttlMs: EXTERNAL_CLI_SYNC_TTL_MS }),
  },
];

function providerRefSet(providerRefs: readonly string[] | undefined): Set<string> | undefined {
  if (!providerRefs) {
    return undefined;
  }
  const normalized = new Set<string>();
  for (const providerRef of providerRefs) {
    const provider = normalizeProviderId(providerRef);
    if (provider) {
      normalized.add(provider);
    }
  }
  return normalized;
}

function shouldReadExternalCliProvider(
  providerConfig: ExternalCliSyncProvider,
  refs: Set<string> | undefined,
): boolean {
  if (!refs) {
    return true;
  }
  if (refs.size === 0) {
    return false;
  }
  const profileProvider = providerConfig.profileId.split(":", 1)[0] ?? "";
  const candidates = [providerConfig.provider, profileProvider, ...providerConfig.providerRefs].map(
    (value) => normalizeProviderId(value),
  );
  return candidates.some((candidate) => candidate && refs.has(candidate));
}

function resolveExternalCliSyncProvider(params: {
  profileId: string;
  credential?: OAuthCredential;
}): ExternalCliSyncProvider | null {
  const provider = EXTERNAL_CLI_SYNC_PROVIDERS.find(
    (entry) => entry.profileId === params.profileId,
  );
  if (!provider) {
    return null;
  }
  if (params.credential && provider.provider !== params.credential.provider) {
    return null;
  }
  return provider;
}

export function readExternalCliBootstrapCredential(params: {
  profileId: string;
  credential: OAuthCredential;
}): OAuthCredential | null {
  const provider = resolveExternalCliSyncProvider(params);
  if (!provider) {
    return null;
  }
  // bootstrapOnly providers must not replace an existing local credential
  // during runtime refresh. The oauth-manager only calls this hook when a
  // local credential is already present, so returning null here keeps the
  // locally stored refresh token canonical.
  if (provider.bootstrapOnly) {
    return null;
  }
  return provider.readCredentials();
}

export const readManagedExternalCliCredential = readExternalCliBootstrapCredential;

export function resolveExternalCliAuthProfiles(
  store: AuthProfileStore,
  options?: ExternalCliAuthProfileResolutionOptions,
): ExternalCliResolvedProfile[] {
  const profiles: ExternalCliResolvedProfile[] = [];
  const now = Date.now();
  const refs = providerRefSet(options?.providerRefs);
  for (const providerConfig of EXTERNAL_CLI_SYNC_PROVIDERS) {
    if (!shouldReadExternalCliProvider(providerConfig, refs)) {
      continue;
    }
    const creds = providerConfig.readCredentials(options);
    if (!creds) {
      continue;
    }
    const existing = store.profiles[providerConfig.profileId];
    const existingOAuth =
      existing?.type === "oauth" && existing.provider === providerConfig.provider
        ? existing
        : undefined;
    if (existing && !existingOAuth) {
      log.debug("kept explicit local auth over external cli bootstrap", {
        profileId: providerConfig.profileId,
        provider: providerConfig.provider,
        localType: existing.type,
        localProvider: existing.provider,
      });
      continue;
    }
    if (providerConfig.bootstrapOnly && existingOAuth) {
      log.debug("kept local oauth over external cli bootstrap-only provider", {
        profileId: providerConfig.profileId,
        provider: providerConfig.provider,
      });
      continue;
    }
    if (existingOAuth && !isSafeToUseExternalCliCredential(existingOAuth, creds)) {
      log.warn("refused external cli oauth bootstrap: identity mismatch", {
        profileId: providerConfig.profileId,
        provider: providerConfig.provider,
      });
      continue;
    }
    if (
      existingOAuth &&
      !isSafeToAdoptBootstrapOAuthIdentity(existingOAuth, creds) &&
      !areOAuthCredentialsEquivalent(existingOAuth, creds)
    ) {
      log.warn("refused external cli oauth bootstrap: identity mismatch or missing binding", {
        profileId: providerConfig.profileId,
        provider: providerConfig.provider,
      });
      continue;
    }
    if (
      !shouldBootstrapFromExternalCliCredential({
        existing: existingOAuth,
        imported: creds,
        now,
      })
    ) {
      if (existingOAuth) {
        log.debug("kept usable local oauth over external cli bootstrap", {
          profileId: providerConfig.profileId,
          provider: providerConfig.provider,
          localExpires: existingOAuth.expires,
          externalExpires: creds.expires,
        });
      }
      continue;
    }
    log.debug("used external cli oauth bootstrap because local oauth was missing or unusable", {
      profileId: providerConfig.profileId,
      provider: providerConfig.provider,
      localExpires: existingOAuth?.expires,
      externalExpires: creds.expires,
    });
    profiles.push({
      profileId: providerConfig.profileId,
      credential: creds,
    });
  }
  return profiles;
}

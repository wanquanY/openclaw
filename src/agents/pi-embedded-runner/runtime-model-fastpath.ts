export function shouldResolveRuntimeModelBeforePiCatalog(params: {
  provider: string;
  pluginHarnessOwnsTransport: boolean;
}): boolean {
  if (params.pluginHarnessOwnsTransport) {
    return false;
  }
  // The native video-workflow provider is registered by the host runtime. PI's
  // models.json catalog is only a compatibility fallback for it, and cold
  // catalog generation can dominate the first user turn.
  return params.provider.trim().toLowerCase() === "video-workflow";
}

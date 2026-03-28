import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../../config/config.js";
import { createAnthropicVertexStreamFnForModel } from "../../anthropic-vertex-stream.js";
import { createOpenAIWebSocketStreamFn } from "../../openai-ws-stream.js";
import { registerProviderStreamForModel } from "../../provider-stream.js";
import { shouldUseOpenAIWebSocketTransport } from "./attempt.thread-helpers.js";

type AuthStorageLike = {
  getApiKey(provider: string): Promise<string | undefined>;
};

type LogLike = {
  warn(message: string): void;
};

type StreamSelectionDeps = {
  registerProviderStreamForModel: typeof registerProviderStreamForModel;
  shouldUseOpenAIWebSocketTransport: typeof shouldUseOpenAIWebSocketTransport;
  createOpenAIWebSocketStreamFn: typeof createOpenAIWebSocketStreamFn;
  createAnthropicVertexStreamFnForModel: typeof createAnthropicVertexStreamFnForModel;
};

const defaultStreamSelectionDeps: StreamSelectionDeps = {
  registerProviderStreamForModel,
  shouldUseOpenAIWebSocketTransport,
  createOpenAIWebSocketStreamFn,
  createAnthropicVertexStreamFnForModel,
};

export async function resolveEmbeddedRunStreamFn(params: {
  currentStreamFn: StreamFn;
  model: Model<Api>;
  provider: string;
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  sessionId: string;
  authStorage: AuthStorageLike;
  abortSignal?: AbortSignal;
  log: LogLike;
  deps?: Partial<StreamSelectionDeps>;
}): Promise<StreamFn> {
  const deps: StreamSelectionDeps = {
    ...defaultStreamSelectionDeps,
    ...params.deps,
  };

  const providerStreamFn = deps.registerProviderStreamForModel({
    model: params.model,
    cfg: params.config,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
  });
  if (providerStreamFn) {
    return providerStreamFn;
  }

  if (
    deps.shouldUseOpenAIWebSocketTransport({
      provider: params.provider,
      modelApi: params.model.api,
    })
  ) {
    const wsApiKey = await params.authStorage.getApiKey(params.provider);
    if (wsApiKey) {
      return deps.createOpenAIWebSocketStreamFn(wsApiKey, params.sessionId, {
        signal: params.abortSignal,
        fallbackStreamFn: params.currentStreamFn,
      });
    }
    params.log.warn(
      `[ws-stream] no API key for provider=${params.provider}; using default authenticated transport`,
    );
    return params.currentStreamFn;
  }

  if (params.model.provider === "anthropic-vertex") {
    return deps.createAnthropicVertexStreamFnForModel(params.model);
  }

  return params.currentStreamFn;
}

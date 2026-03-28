import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { resolveEmbeddedRunStreamFn } from "./stream-selection.js";

function makeModel(overrides?: Partial<Model<Api>>): Model<Api> {
  return {
    id: "MiniMax-M2.5",
    name: "MiniMax M2.5",
    provider: "video-workflow",
    api: "openai-completions",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
    ...overrides,
  };
}

describe("resolveEmbeddedRunStreamFn", () => {
  it("preserves the current authenticated stream for the default path", async () => {
    const currentStreamFn = vi.fn() as unknown as StreamFn;
    const providerStreamFn = vi.fn() as unknown as StreamFn;
    const result = await resolveEmbeddedRunStreamFn({
      currentStreamFn,
      model: makeModel(),
      provider: "video-workflow",
      sessionId: "sess-default",
      authStorage: {
        getApiKey: vi.fn(async () => "should-not-be-used"),
      },
      log: { warn: vi.fn() },
      deps: {
        registerProviderStreamForModel: vi.fn(() => undefined),
        shouldUseOpenAIWebSocketTransport: vi.fn(() => false),
        createOpenAIWebSocketStreamFn: vi.fn(() => providerStreamFn),
        createAnthropicVertexStreamFnForModel: vi.fn(() => providerStreamFn),
      },
    });

    expect(result).toBe(currentStreamFn);
  });

  it("threads the current authenticated stream into websocket fallback", async () => {
    const currentStreamFn = vi.fn() as unknown as StreamFn;
    const wsStreamFn = vi.fn() as unknown as StreamFn;
    const createWsStreamFn = vi.fn(() => wsStreamFn);
    const abortSignal = new AbortController().signal;

    const result = await resolveEmbeddedRunStreamFn({
      currentStreamFn,
      model: makeModel({
        provider: "openai",
        api: "openai-responses",
      }),
      provider: "openai",
      sessionId: "sess-ws",
      authStorage: {
        getApiKey: vi.fn(async () => "sk-test"),
      },
      abortSignal,
      log: { warn: vi.fn() },
      deps: {
        registerProviderStreamForModel: vi.fn(() => undefined),
        shouldUseOpenAIWebSocketTransport: vi.fn(() => true),
        createOpenAIWebSocketStreamFn: createWsStreamFn,
        createAnthropicVertexStreamFnForModel: vi.fn(() => currentStreamFn),
      },
    });

    expect(result).toBe(wsStreamFn);
    expect(createWsStreamFn).toHaveBeenCalledWith("sk-test", "sess-ws", {
      signal: abortSignal,
      fallbackStreamFn: currentStreamFn,
    });
  });

  it("falls back to the current authenticated stream when websocket auth is missing", async () => {
    const currentStreamFn = vi.fn() as unknown as StreamFn;
    const warn = vi.fn();
    const createWsStreamFn = vi.fn();

    const result = await resolveEmbeddedRunStreamFn({
      currentStreamFn,
      model: makeModel({
        provider: "openai",
        api: "openai-responses",
      }),
      provider: "openai",
      sessionId: "sess-ws-missing-auth",
      authStorage: {
        getApiKey: vi.fn(async () => undefined),
      },
      log: { warn },
      deps: {
        registerProviderStreamForModel: vi.fn(() => undefined),
        shouldUseOpenAIWebSocketTransport: vi.fn(() => true),
        createOpenAIWebSocketStreamFn: createWsStreamFn,
        createAnthropicVertexStreamFnForModel: vi.fn(() => currentStreamFn),
      },
    });

    expect(result).toBe(currentStreamFn);
    expect(createWsStreamFn).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "[ws-stream] no API key for provider=openai; using default authenticated transport",
    );
  });
});

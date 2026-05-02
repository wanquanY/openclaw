import { describe, expect, it } from "vitest";
import { shouldResolveRuntimeModelBeforePiCatalog } from "./runtime-model-fastpath.js";

describe("shouldResolveRuntimeModelBeforePiCatalog", () => {
  it("prefers runtime model resolution for the native video-workflow provider", () => {
    expect(
      shouldResolveRuntimeModelBeforePiCatalog({
        provider: "video-workflow",
        pluginHarnessOwnsTransport: false,
      }),
    ).toBe(true);
  });

  it("keeps plugin-owned transports on their existing PI-discovery skip path", () => {
    expect(
      shouldResolveRuntimeModelBeforePiCatalog({
        provider: "video-workflow",
        pluginHarnessOwnsTransport: true,
      }),
    ).toBe(false);
  });

  it("leaves ordinary PI providers on models.json catalog resolution", () => {
    expect(
      shouldResolveRuntimeModelBeforePiCatalog({
        provider: "openai",
        pluginHarnessOwnsTransport: false,
      }),
    ).toBe(false);
  });
});

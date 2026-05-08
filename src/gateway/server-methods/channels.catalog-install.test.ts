import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
  replaceConfigFile: vi.fn(),
  applyPluginAutoEnable: vi.fn(),
  listChannelPlugins: vi.fn(),
  listChannelPluginCatalogEntries: vi.fn(),
  isCatalogChannelInstalled: vi.fn(),
  installChannelSetupPluginFromCatalogEntry: vi.fn(),
  reloadChannelSetupPluginRegistryForChannel: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: vi.fn(() => ({})),
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
  replaceConfigFile: mocks.replaceConfigFile,
}));

vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: mocks.applyPluginAutoEnable,
}));

vi.mock("../../channels/plugins/index.js", () => ({
  listChannelPlugins: mocks.listChannelPlugins,
  getChannelPlugin: vi.fn(),
  normalizeChannelId: (value: string) => value,
}));

vi.mock("../../channels/plugins/catalog.js", () => ({
  buildChannelUiCatalog: vi.fn(() => ({
    order: [],
    labels: {},
    detailLabels: {},
    systemImages: {},
    entries: [],
  })),
  listChannelPluginCatalogEntries: mocks.listChannelPluginCatalogEntries,
}));

vi.mock("../../commands/channel-setup/discovery.js", () => ({
  isCatalogChannelInstalled: mocks.isCatalogChannelInstalled,
}));

vi.mock("../../commands/channel-setup/plugin-install.js", () => ({
  installChannelSetupPluginFromCatalogEntry: mocks.installChannelSetupPluginFromCatalogEntry,
  reloadChannelSetupPluginRegistryForChannel: mocks.reloadChannelSetupPluginRegistryForChannel,
}));

vi.mock("../../infra/channel-activity.js", () => ({
  getChannelActivity: vi.fn(() => ({
    inboundAt: null,
    outboundAt: null,
  })),
}));

import { channelsHandlers } from "./channels.js";

function createOptions(
  method: string,
  params: Record<string, unknown>,
  respond = vi.fn(),
): GatewayRequestHandlerOptions {
  return {
    req: { type: "req", id: "req-1", method, params },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond,
    context: {
      getRuntimeSnapshot: () => ({
        channels: {},
        channelAccounts: {},
      }),
    },
  } as unknown as GatewayRequestHandlerOptions;
}

function catalogEntry() {
  return {
    id: "openclaw-weixin",
    pluginId: "openclaw-weixin",
    meta: {
      id: "openclaw-weixin",
      label: "WeChat",
      selectionLabel: "WeChat",
      detailLabel: "WeChat",
      docsPath: "/channels/wechat",
      blurb: "Connect WeChat.",
    },
    install: {
      npmSpec: "@tencent-weixin/openclaw-weixin@2.1.1",
      defaultChoice: "npm",
    },
  };
}

describe("channelsHandlers channel catalog and install", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readConfigFileSnapshot.mockResolvedValue({
      valid: true,
      hash: "base-hash",
      sourceConfig: { plugins: {} },
      config: { plugins: {} },
    });
    mocks.applyPluginAutoEnable.mockImplementation(({ config }) => ({ config, changes: [] }));
    mocks.listChannelPluginCatalogEntries.mockReturnValue([catalogEntry()]);
    mocks.listChannelPlugins.mockReturnValue([
      {
        id: "openclaw-weixin",
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({}),
          isConfigured: async () => true,
        },
      },
    ]);
    mocks.isCatalogChannelInstalled.mockReturnValue(false);
    mocks.installChannelSetupPluginFromCatalogEntry.mockResolvedValue({
      ok: true,
      cfg: { plugins: { installs: {} } },
      pluginId: "openclaw-weixin",
      installed: true,
      targetDir: "/tmp/openclaw-weixin",
      version: "2.1.1",
      approvedPermissions: ["process.exec"],
    });
  });

  it("returns installable channel catalog entries with installed and configured state", async () => {
    const respond = vi.fn();

    await channelsHandlers["channels.catalog"](
      createOptions("channels.catalog", { includeInstallable: true }, respond),
    );

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        entries: [
          expect.objectContaining({
            id: "openclaw-weixin",
            label: "WeChat",
            installed: false,
            configured: true,
            install: expect.objectContaining({
              npmSpec: "@tencent-weixin/openclaw-weixin@2.1.1",
            }),
          }),
        ],
      }),
      undefined,
    );
  });

  it("installs a channel plugin through the catalog and persists approved permissions", async () => {
    const respond = vi.fn();

    await channelsHandlers["channels.install"](
      createOptions(
        "channels.install",
        {
          channel: "openclaw-weixin",
          approvedPluginPermissions: ["process.exec", "ignored"],
        },
        respond,
      ),
    );

    expect(mocks.installChannelSetupPluginFromCatalogEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({ id: "openclaw-weixin" }),
        approvedPluginPermissions: ["process.exec"],
      }),
    );
    expect(mocks.replaceConfigFile).toHaveBeenCalledWith({
      nextConfig: { plugins: { installs: {} } },
      baseHash: "base-hash",
    });
    expect(mocks.reloadChannelSetupPluginRegistryForChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "openclaw-weixin",
        pluginId: "openclaw-weixin",
      }),
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        channel: "openclaw-weixin",
        pluginId: "openclaw-weixin",
        installed: true,
        alreadyInstalled: false,
        approvedPermissions: ["process.exec"],
      }),
      undefined,
    );
  });
});

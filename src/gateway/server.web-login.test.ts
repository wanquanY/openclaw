import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";
import { setRegistry } from "./server.agent.gateway-server-agent.mocks.js";
import { createRegistry } from "./server.e2e-registry-helpers.js";
import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

function createWebLoginPlugin(params: {
  id: ChannelPlugin["id"];
  label: string;
  connected?: boolean;
}) {
  const loginWithQrStart = vi.fn(async () => ({
    provider: params.id,
    phase: "start",
    message: "started",
  }));
  const loginWithQrWait = vi.fn(async () => ({
    provider: params.id,
    connected: params.connected ?? false,
    message: "waiting",
  }));
  const plugin: ChannelPlugin = {
    ...createChannelTestPluginBase({
      id: params.id,
      label: params.label,
      config: { isConfigured: async () => false },
    }),
    gatewayMethods: ["web.login.start", "web.login.wait"],
    gateway: {
      loginWithQrStart,
      loginWithQrWait,
    },
  };
  return { plugin, loginWithQrStart, loginWithQrWait };
}

const whatsapp = createWebLoginPlugin({
  id: "whatsapp",
  label: "WhatsApp",
  connected: true,
});
const telegram = createWebLoginPlugin({
  id: "telegram",
  label: "Telegram",
  connected: true,
});
const signal: ChannelPlugin = {
  ...createChannelTestPluginBase({
    id: "signal",
    label: "Signal",
    config: { isConfigured: async () => false },
  }),
};

const defaultRegistry = createRegistry([
  {
    pluginId: "whatsapp",
    source: "test",
    plugin: whatsapp.plugin,
  },
  {
    pluginId: "telegram",
    source: "test",
    plugin: telegram.plugin,
  },
  {
    pluginId: "signal",
    source: "test",
    plugin: signal,
  },
]);

let server: Awaited<ReturnType<typeof startServerWithClient>>["server"];
let ws: Awaited<ReturnType<typeof startServerWithClient>>["ws"];

beforeAll(async () => {
  setRegistry(defaultRegistry);
  const started = await startServerWithClient();
  server = started.server;
  ws = started.ws;
  await connectOk(ws);
});

beforeEach(() => {
  vi.clearAllMocks();
  setRegistry(defaultRegistry);
});

afterAll(async () => {
  ws.close();
  await server.close();
});

describe("gateway server web login", () => {
  test("web.login.start routes to requested channel", async () => {
    const res = await rpcReq<Record<string, unknown>>(ws, "web.login.start", {
      channel: "telegram",
      force: true,
    });
    expect(res.ok).toBe(true);
    expect(res.payload?.provider).toBe("telegram");
    expect(telegram.loginWithQrStart).toHaveBeenCalledTimes(1);
    expect(whatsapp.loginWithQrStart).not.toHaveBeenCalled();
  });

  test("web.login.wait routes to requested channel", async () => {
    const res = await rpcReq<Record<string, unknown>>(ws, "web.login.wait", {
      channel: "whatsapp",
      timeoutMs: 3_000,
    });
    expect(res.ok).toBe(true);
    expect(res.payload?.provider).toBe("whatsapp");
    expect(whatsapp.loginWithQrWait).toHaveBeenCalledTimes(1);
    expect(telegram.loginWithQrWait).not.toHaveBeenCalled();
  });

  test("web.login.start reports unavailable channel", async () => {
    const res = await rpcReq<Record<string, unknown>>(ws, "web.login.start", {
      channel: "discord",
    });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("INVALID_REQUEST");
    expect(res.error?.message).toContain("not available for channel discord");
  });

  test("web.login.start reports unsupported provider", async () => {
    const res = await rpcReq<Record<string, unknown>>(ws, "web.login.start", {
      channel: "signal",
    });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("INVALID_REQUEST");
    expect(res.error?.message).toContain("provider signal");
  });
});

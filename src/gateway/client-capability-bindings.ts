import type { SessionClientCapabilityBinding, SessionEntry } from "../config/sessions/types.js";
import type { GatewayClient } from "./server-methods/types.js";

export function buildSessionClientCapabilityBindingFromClient(params: {
  client: GatewayClient | null;
  capability: string;
}): SessionClientCapabilityBinding | undefined {
  const deviceId =
    typeof params.client?.connect?.device?.id === "string"
      ? params.client.connect.device.id.trim()
      : "";
  if (!deviceId) {
    return undefined;
  }
  const capability = params.capability.trim();
  const caps = Array.isArray(params.client?.connect?.caps) ? params.client.connect.caps : [];
  if (!caps.includes(capability)) {
    return undefined;
  }
  const commands = Array.isArray(params.client?.connect?.commands)
    ? params.client.connect.commands.map((value) => value.trim()).filter(Boolean)
    : [];
  return {
    deviceId,
    clientId: params.client?.connect?.client?.id,
    clientMode: params.client?.connect?.client?.mode,
    displayName: params.client?.connect?.client?.displayName,
    platform: params.client?.connect?.client?.platform,
    ...(commands.length > 0 ? { commands: Array.from(new Set(commands)) } : {}),
    boundAt: Date.now(),
  };
}

export function applySessionClientCapabilityBinding(params: {
  entry: SessionEntry;
  capability: string;
  binding?: SessionClientCapabilityBinding;
  enabled: boolean;
}): SessionEntry {
  const capability = params.capability.trim();
  const existing = params.entry.clientCapabilityBindings;
  if (!params.enabled || !params.binding) {
    if (!existing || !(capability in existing)) {
      return params.entry;
    }
    const nextBindings = { ...existing };
    delete nextBindings[capability];
    const nextEntry = { ...params.entry };
    if (Object.keys(nextBindings).length > 0) {
      nextEntry.clientCapabilityBindings = nextBindings;
    } else {
      delete nextEntry.clientCapabilityBindings;
    }
    return nextEntry;
  }
  const nextBindings = { ...existing, [capability]: params.binding };
  return {
    ...params.entry,
    clientCapabilityBindings: nextBindings,
  };
}

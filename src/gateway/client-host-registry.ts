import { randomUUID } from "node:crypto";
import type { GatewayWsClient } from "./server/ws-types.js";

export type ClientHostSession = {
  hostId: string;
  deviceId?: string;
  connId: string;
  client: GatewayWsClient;
  clientId?: string;
  clientMode?: string;
  displayName?: string;
  platform?: string;
  version?: string;
  caps: string[];
  commands: string[];
  permissions?: Record<string, boolean>;
  connectedAtMs: number;
};

type PendingInvoke = {
  connId: string;
  hostId: string;
  command: string;
  resolve: (value: ClientInvokeResult) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type ClientInvokeResult = {
  ok: boolean;
  payload?: unknown;
  payloadJSON?: string | null;
  error?: { code?: string; message?: string } | null;
};

export class ClientHostRegistry {
  private hostsByConn = new Map<string, ClientHostSession>();
  private connIdByDeviceId = new Map<string, string>();
  private pendingInvokes = new Map<string, PendingInvoke>();

  register(client: GatewayWsClient): ClientHostSession {
    const connect = client.connect;
    const deviceId =
      typeof connect.device?.id === "string" && connect.device.id.trim()
        ? connect.device.id.trim()
        : undefined;
    const hostId = deviceId ?? client.connId;
    const caps = Array.isArray(connect.caps) ? connect.caps : [];
    const commands = Array.isArray(connect.commands) ? connect.commands : [];
    const permissions =
      typeof connect.permissions === "object" && connect.permissions
        ? connect.permissions
        : undefined;
    const session: ClientHostSession = {
      hostId,
      ...(deviceId ? { deviceId } : {}),
      connId: client.connId,
      client,
      clientId: connect.client.id,
      clientMode: connect.client.mode,
      displayName: connect.client.displayName,
      platform: connect.client.platform,
      version: connect.client.version,
      caps,
      commands,
      permissions,
      connectedAtMs: Date.now(),
    };
    this.hostsByConn.set(client.connId, session);
    if (deviceId) {
      this.connIdByDeviceId.set(deviceId, client.connId);
    }
    return session;
  }

  unregister(connId: string): ClientHostSession | null {
    const session = this.hostsByConn.get(connId);
    if (!session) {
      return null;
    }
    this.hostsByConn.delete(connId);
    if (session.deviceId) {
      const mappedConnId = this.connIdByDeviceId.get(session.deviceId);
      if (mappedConnId === connId) {
        this.connIdByDeviceId.delete(session.deviceId);
      }
    }
    for (const [id, pending] of this.pendingInvokes.entries()) {
      if (pending.connId !== connId) {
        continue;
      }
      clearTimeout(pending.timer);
      pending.reject(new Error(`client host disconnected (${pending.command})`));
      this.pendingInvokes.delete(id);
    }
    return session;
  }

  getByConn(connId: string): ClientHostSession | undefined {
    return this.hostsByConn.get(connId);
  }

  getByDeviceId(deviceId: string): ClientHostSession | undefined {
    const connId = this.connIdByDeviceId.get(deviceId);
    return connId ? this.hostsByConn.get(connId) : undefined;
  }

  async invoke(params: {
    connId?: string;
    deviceId?: string;
    capability?: string;
    command: string;
    invokeParams?: unknown;
    timeoutMs?: number;
    idempotencyKey?: string;
  }): Promise<ClientInvokeResult> {
    const target = params.connId
      ? this.getByConn(params.connId)
      : params.deviceId
        ? this.getByDeviceId(params.deviceId)
        : undefined;
    if (!target) {
      return {
        ok: false,
        error: { code: "NOT_CONNECTED", message: "client host not connected" },
      };
    }
    if (params.capability && !target.caps.includes(params.capability)) {
      return {
        ok: false,
        error: {
          code: "CAPABILITY_UNAVAILABLE",
          message: `client host missing capability ${params.capability}`,
        },
      };
    }
    if (!target.commands.includes(params.command)) {
      return {
        ok: false,
        error: {
          code: "COMMAND_UNAVAILABLE",
          message: `client host does not allow command ${params.command}`,
        },
      };
    }

    const requestId = randomUUID();
    const payload = {
      id: requestId,
      connId: target.connId,
      hostId: target.hostId,
      deviceId: target.deviceId,
      capability: params.capability,
      command: params.command,
      paramsJSON:
        "invokeParams" in params && params.invokeParams !== undefined
          ? JSON.stringify(params.invokeParams)
          : null,
      timeoutMs: params.timeoutMs,
      idempotencyKey: params.idempotencyKey,
    };
    const ok = this.sendEventToSession(target, "client.invoke.request", payload);
    if (!ok) {
      return {
        ok: false,
        error: { code: "UNAVAILABLE", message: "failed to send invoke to client host" },
      };
    }

    const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : 30_000;
    return await new Promise<ClientInvokeResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingInvokes.delete(requestId);
        resolve({
          ok: false,
          error: { code: "TIMEOUT", message: "client host invoke timed out" },
        });
      }, timeoutMs);
      this.pendingInvokes.set(requestId, {
        connId: target.connId,
        hostId: target.hostId,
        command: params.command,
        resolve,
        reject,
        timer,
      });
    });
  }

  handleInvokeResult(params: {
    id: string;
    connId: string;
    ok: boolean;
    payload?: unknown;
    payloadJSON?: string | null;
    error?: { code?: string; message?: string } | null;
  }): boolean {
    const pending = this.pendingInvokes.get(params.id);
    if (!pending) {
      return false;
    }
    if (pending.connId !== params.connId) {
      return false;
    }
    clearTimeout(pending.timer);
    this.pendingInvokes.delete(params.id);
    pending.resolve({
      ok: params.ok,
      payload: params.payload,
      payloadJSON: params.payloadJSON ?? null,
      error: params.error ?? null,
    });
    return true;
  }

  private sendEventToSession(session: ClientHostSession, event: string, payload: unknown): boolean {
    try {
      session.client.socket.send(
        JSON.stringify({
          type: "event",
          event,
          payload,
        }),
      );
      return true;
    } catch {
      return false;
    }
  }
}

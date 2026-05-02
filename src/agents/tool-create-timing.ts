import { createSubsystemLogger } from "../logging/subsystem.js";

export const TOOL_CREATE_TIMING_LOG_THRESHOLD_MS = 50;

const toolTimingLog = createSubsystemLogger("agent/tools");

export type ToolCreateTimingMap = Record<string, number>;

export function recordToolCreateTiming<T>(
  timings: ToolCreateTimingMap,
  key: string,
  create: () => T,
): T {
  const startedAt = Date.now();
  try {
    return create();
  } finally {
    timings[key] = (timings[key] ?? 0) + (Date.now() - startedAt);
  }
}

export function logToolCreateTiming(params: {
  label: string;
  timings: ToolCreateTimingMap;
  totalMs: number;
  sessionKey?: string;
  toolCount?: number;
  thresholdMs?: number;
}) {
  const thresholdMs = params.thresholdMs ?? TOOL_CREATE_TIMING_LOG_THRESHOLD_MS;
  if (params.totalMs < thresholdMs) {
    return;
  }

  const payload = {
    sessionKey: params.sessionKey,
    totalMs: params.totalMs,
    toolCount: params.toolCount,
    timings: params.timings,
  };
  toolTimingLog.info(`${params.label} timing ${JSON.stringify(payload)}`, payload);
}

import crypto from "node:crypto";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
import type { BrowserUseSessionConfig } from "../../browser-use/types.js";
import { normalizeBrowserUseSessionConfig } from "../../browser-use/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { stringEnum } from "../schema/typebox.js";
import {
  type AnyAgentTool,
  ToolInputError,
  asToolParamsRecord,
  readNumberParam,
  readStringParam,
  textResult,
} from "./common.js";
import { callGatewayTool } from "./gateway.js";

const log = createSubsystemLogger("agents/tools/browser-use");

const BROWSER_USE_ACTIONS = [
  "status",
  "sessions",
  "navigate",
  "observe",
  "click",
  "double_click",
  "type",
  "scroll",
  "wait",
  "close",
] as const;

type BrowserUseToolAction = (typeof BROWSER_USE_ACTIONS)[number];

type BrowserUseToolPayload = {
  kind: "browser_use/v1";
  action: BrowserUseToolAction;
  status: "success" | "error";
  activation?: BrowserUseSessionConfig["activation"];
  source?: BrowserUseSessionConfig["source"];
  command?: string;
  summary: string;
  result?: unknown;
  error?: string;
};

type BrowserUseResultStatus = "success" | "failed" | "approval_required" | "error";

type BrowserUseResultClassification = {
  ok: boolean;
  status?: BrowserUseResultStatus;
  errorMessage?: string;
  errorCode?: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function trimText(value: unknown, limit = 1200): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, limit);
}

function summarizeElements(value: unknown, limit = 24): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, limit).flatMap((item, index) => {
    const record = asRecord(item);
    if (!record) return [];
    const ref = trimText(record.ref, 80);
    const role = trimText(record.role, 40);
    const name = trimText(record.name, 140) || trimText(record.text, 140);
    const tag = trimText(record.tagName, 30);
    const label = [ref || `#${index + 1}`, role || tag, name].filter(Boolean).join(" · ");
    return label ? [label] : [];
  });
}

function formatObservationForModel(observation: unknown): string {
  const record = asRecord(observation);
  if (!record) return "";
  const title = trimText(record.title, 200);
  const url = trimText(record.url, 500);
  const pageText = trimText(record.pageText, 3000);
  const elements = summarizeElements(record.elements);
  const lines = [
    title ? `Title: ${title}` : "",
    url ? `URL: ${url}` : "",
    pageText ? `Readable text:\n${pageText}` : "",
    elements.length > 0
      ? `Visible elements:\n${elements.map((item) => `- ${item}`).join("\n")}`
      : "",
  ].filter(Boolean);
  return lines.join("\n");
}

function resolveObservationLike(result: unknown): unknown {
  const record = asRecord(result);
  if (!record) return undefined;
  const payload = asRecord(record.payload);
  if (payload) {
    return resolveObservationLike(payload);
  }
  if (record.kind === "browser_use/v1" && Array.isArray(record.elements)) return record;
  const postActionObservation = record.postActionObservation;
  if (postActionObservation) return postActionObservation;
  const postNavigationObservation = record.postNavigationObservation;
  if (postNavigationObservation) return postNavigationObservation;
  const nestedResult = asRecord(record.result);
  const nestedPayload = asRecord(nestedResult?.payload);
  if (nestedPayload) {
    return resolveObservationLike(nestedPayload);
  }
  if (nestedResult?.postActionObservation) return nestedResult.postActionObservation;
  if (nestedResult?.postNavigationObservation) return nestedResult.postNavigationObservation;
  return undefined;
}

function formatBrowserUseToolText(
  action: BrowserUseToolAction,
  summary: string,
  result: unknown,
): string {
  const observationText = formatObservationForModel(resolveObservationLike(result));
  if (observationText) {
    return `${summary}\n\n${observationText}`;
  }

  const record = unwrapGatewayPayloadRecord(result);
  if (action === "status" || action === "sessions") {
    const sessions = Array.isArray(record?.sessions)
      ? record.sessions
      : Array.isArray(result)
        ? result
        : [];
    if (sessions.length > 0) {
      return `${summary}\n\nSessions:\n${sessions
        .slice(0, 8)
        .map((session) => {
          const item = asRecord(session) ?? {};
          const id = trimText(item.browserSessionId, 120);
          const tabs = Array.isArray(item.tabs) ? item.tabs : [];
          const activeTab = tabs.find((tab) => asRecord(tab)?.active === true) ?? tabs[0];
          const tab = asRecord(activeTab) ?? {};
          return `- ${id || "browser"} ${trimText(tab.title, 120)} ${trimText(tab.url, 300)}`.trim();
        })
        .join("\n")}`;
    }
  }
  return summary;
}

function readBrowserUseStatus(value: unknown): BrowserUseResultStatus | undefined {
  const status = normalizeOptionalString(value);
  if (
    status === "success" ||
    status === "failed" ||
    status === "approval_required" ||
    status === "error"
  ) {
    return status;
  }
  return undefined;
}

function unwrapGatewayPayloadRecord(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value);
  if (!record) return null;
  const payload = asRecord(record.payload);
  return payload ?? record;
}

function unwrapGatewayPayload(value: unknown): unknown {
  const record = asRecord(value);
  if (!record) return value;
  return asRecord(record.payload) ?? value;
}

function readBrowserUseErrorMessage(record: Record<string, unknown>): {
  message?: string;
  code?: string;
} {
  const errorRecord = asRecord(record.error);
  const message =
    normalizeOptionalString(errorRecord?.message) ??
    normalizeOptionalString(record.message) ??
    normalizeOptionalString(record.fallbackReason) ??
    normalizeOptionalString(record.error);
  const code =
    normalizeOptionalString(errorRecord?.code) ??
    normalizeOptionalString(record.errorCode) ??
    normalizeOptionalString(record.fallbackReason);
  return { message, code };
}

function classifyBrowserUseResult(result: unknown): BrowserUseResultClassification {
  const record = unwrapGatewayPayloadRecord(result);
  if (!record) return { ok: true };

  const status = readBrowserUseStatus(record.status);
  if (!status) return { ok: true };
  if (status === "success") return { ok: true, status };

  const { message, code } = readBrowserUseErrorMessage(record);
  return {
    ok: false,
    status,
    errorMessage: message ?? `browser_use returned ${status}`,
    errorCode: code,
  };
}

const BrowserUseToolSchema = Type.Object({
  action: stringEnum(BROWSER_USE_ACTIONS, {
    description:
      "Browser operation. Use status/sessions to inspect available in-app browser sessions, navigate to open a URL, observe to get DOM element refs, and click/type/scroll to operate the visible browser.",
  }),
  url: Type.Optional(Type.String({ description: "URL for action=navigate." })),
  browserSessionId: Type.Optional(
    Type.String({ description: "Browser session id from status/sessions/observe." }),
  ),
  tabId: Type.Optional(Type.String({ description: "Tab id from status/sessions/observe." })),
  ref: Type.Optional(
    Type.String({ description: "Stable element ref from observe, for example @b1." }),
  ),
  selector: Type.Optional(
    Type.String({ description: "CSS selector fallback for element actions." }),
  ),
  text: Type.Optional(Type.String({ description: "Text for action=type." })),
  deltaX: Type.Optional(Type.Number({ description: "Horizontal scroll delta." })),
  deltaY: Type.Optional(Type.Number({ description: "Vertical scroll delta." })),
  maxNodes: Type.Optional(Type.Number({ minimum: 1 })),
  timeoutMs: Type.Optional(Type.Number({ minimum: 0 })),
});

function summarizeResult(action: BrowserUseToolAction, result: unknown): string {
  const classification = classifyBrowserUseResult(result);
  if (!classification.ok) {
    const suffix = classification.errorMessage ? `: ${classification.errorMessage}` : "";
    return `browser_use ${action} failed${suffix}`;
  }
  const record = unwrapGatewayPayloadRecord(result);
  if (record) {
    const url = normalizeOptionalString(record.url);
    const title = normalizeOptionalString(record.title);
    const sessionId =
      normalizeOptionalString(record.browserSessionId) ??
      normalizeOptionalString(record.activeBrowserSessionId);
    const elementCount = Array.isArray(record.elements) ? record.elements.length : undefined;
    if (action === "observe" && typeof elementCount === "number") {
      return `browser_use observe complete (${elementCount} elements)${url ? ` ${url}` : ""}`;
    }
    if (action === "navigate") {
      return `browser_use navigate complete${title ? `: ${title}` : url ? `: ${url}` : ""}`;
    }
    if (sessionId) {
      return `browser_use ${action} complete (${sessionId})`;
    }
  }
  return `browser_use ${action} complete`;
}

async function invokeBrowserClientCommand(params: {
  sessionKey?: string;
  command: string;
  commandParams?: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<unknown> {
  return await callGatewayTool(
    "client.invoke",
    {},
    {
      sessionKey: params.sessionKey,
      capability: "browser_use",
      command: params.command,
      params: params.commandParams ?? {},
      timeoutMs: params.timeoutMs,
      idempotencyKey: crypto.randomUUID(),
    },
  );
}

function readActionParams(params: Record<string, unknown>) {
  const browserSessionId = readStringParam(params, "browserSessionId");
  const tabId = readStringParam(params, "tabId");
  const ref = readStringParam(params, "ref");
  const selector = readStringParam(params, "selector");
  const text = readStringParam(params, "text", { allowEmpty: true });
  const deltaX = readNumberParam(params, "deltaX");
  const deltaY = readNumberParam(params, "deltaY");

  return {
    ...(browserSessionId ? { browserSessionId } : {}),
    ...(tabId ? { tabId } : {}),
    ...(ref ? { ref } : {}),
    ...(selector ? { selector } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(deltaX !== undefined ? { deltaX } : {}),
    ...(deltaY !== undefined ? { deltaY } : {}),
  };
}

function buildBrowserSessionCommandParams(
  sessionKey: string | undefined,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const browserSessionId = readStringParam(params, "browserSessionId");
  return {
    ...(browserSessionId ? { browserSessionId } : {}),
    ...(!browserSessionId && sessionKey ? { ownerSessionKey: sessionKey } : {}),
  };
}

async function executeBrowserUseAction(params: {
  sessionKey?: string;
  action: BrowserUseToolAction;
  toolParams: Record<string, unknown>;
  timeoutMs?: number;
}) {
  const actionParams = readActionParams(params.toolParams);
  if (params.action === "type" && actionParams.text === undefined) {
    throw new ToolInputError("text required for browser_use action=type");
  }
  if (
    (params.action === "click" || params.action === "double_click" || params.action === "type") &&
    !actionParams.ref &&
    !actionParams.selector
  ) {
    throw new ToolInputError("ref or selector required for browser element action");
  }
  return await invokeBrowserClientCommand({
    sessionKey: params.sessionKey,
    command: "browser.action",
    timeoutMs: params.timeoutMs,
    commandParams: {
      ...buildBrowserSessionCommandParams(params.sessionKey, params.toolParams),
      action: params.action,
      ...actionParams,
    },
  });
}

export function createBrowserUseTool(options: {
  sessionConfig: BrowserUseSessionConfig;
  sessionKey?: string;
  agentId?: string;
  config?: OpenClawConfig;
}): AnyAgentTool {
  const sessionConfig =
    normalizeBrowserUseSessionConfig(options.sessionConfig) ?? options.sessionConfig;
  const activation = sessionConfig.activation;
  const invocationMetadata = {
    activation,
    ...(sessionConfig.source ? { source: sessionConfig.source } : {}),
  };
  const activationInstruction =
    activation === "required"
      ? "The user explicitly selected Browser Use for this turn; use this tool to complete the browser-facing part of the request unless it is impossible or unsafe."
      : "Use this tool only when operating or inspecting the visible browser is materially useful for the user's task.";
  return {
    label: "Browser Use",
    name: "browser_use",
    description: `Control the Doxie in-app Browser Use panel. ${activationInstruction} Use it to open a website, inspect the current browser page, click links/buttons, fill forms, or combine manual browsing with agent automation.`,
    parameters: BrowserUseToolSchema,
    async execute(_toolCallId, rawParams, signal): Promise<AgentToolResult<BrowserUseToolPayload>> {
      const sessionConfig = normalizeBrowserUseSessionConfig(options.sessionConfig);
      if (!sessionConfig?.enabled) {
        throw new ToolInputError("browser_use is disabled for this session");
      }
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error("browser_use aborted");
      }

      const params = asToolParamsRecord(rawParams);
      const action = readStringParam(params, "action", { required: true }) as BrowserUseToolAction;
      if (!BROWSER_USE_ACTIONS.includes(action)) {
        throw new ToolInputError(`unsupported browser_use action: ${action}`);
      }
      const timeoutMs = readNumberParam(params, "timeoutMs", { integer: true }) ?? 30_000;

      try {
        let command = "browser.status";
        let result: unknown;
        if (action === "status") {
          command = "browser.status";
          result = await invokeBrowserClientCommand({
            sessionKey: options.sessionKey,
            command,
            timeoutMs,
          });
        } else if (action === "sessions") {
          command = "browser.sessions";
          result = await invokeBrowserClientCommand({
            sessionKey: options.sessionKey,
            command,
            timeoutMs,
          });
        } else if (action === "navigate") {
          const url = readStringParam(params, "url", { required: true });
          command = "browser.navigate";
          result = await invokeBrowserClientCommand({
            sessionKey: options.sessionKey,
            command,
            timeoutMs,
            commandParams: {
              ...buildBrowserSessionCommandParams(options.sessionKey, params),
              url,
            },
          });
        } else if (action === "observe") {
          command = "browser.observe";
          result = await invokeBrowserClientCommand({
            sessionKey: options.sessionKey,
            command,
            timeoutMs,
            commandParams: {
              ...buildBrowserSessionCommandParams(options.sessionKey, params),
              tabId: readStringParam(params, "tabId"),
              maxNodes: readNumberParam(params, "maxNodes", { integer: true }),
            },
          });
        } else if (action === "wait") {
          const waitMs = Math.min(
            Math.max(0, readNumberParam(params, "timeoutMs", { integer: true }) ?? 1_000),
            30_000,
          );
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          command = "browser.status";
          result = await invokeBrowserClientCommand({
            sessionKey: options.sessionKey,
            command,
            timeoutMs,
          });
        } else if (action === "close") {
          command = "browser.close";
          result = await invokeBrowserClientCommand({
            sessionKey: options.sessionKey,
            command,
            timeoutMs,
            commandParams: {
              ...buildBrowserSessionCommandParams(options.sessionKey, params),
            },
          });
        } else {
          command = "browser.action";
          result = await executeBrowserUseAction({
            sessionKey: options.sessionKey,
            action,
            toolParams: params,
            timeoutMs,
          });
        }

        const summary = summarizeResult(action, result);
        const classification = classifyBrowserUseResult(result);
        const toolResultPayload = unwrapGatewayPayload(result);
        if (!classification.ok) {
          log.warn(summary, {
            sessionKey: options.sessionKey,
            agentId: options.agentId,
            action,
            command,
            status: classification.status,
            errorCode: classification.errorCode,
          });
          return textResult(formatBrowserUseToolText(action, summary, result), {
            kind: "browser_use/v1",
            action,
            status: "error",
            ...invocationMetadata,
            command,
            summary,
            result: toolResultPayload,
            error: classification.errorMessage ?? summary,
          });
        }

        log.info(summary, {
          sessionKey: options.sessionKey,
          agentId: options.agentId,
          action,
          command,
        });
        return textResult(formatBrowserUseToolText(action, summary, result), {
          kind: "browser_use/v1",
          action,
          status: "success",
          ...invocationMetadata,
          command,
          summary,
          result: toolResultPayload,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.warn("browser_use tool failed", {
          sessionKey: options.sessionKey,
          agentId: options.agentId,
          action,
          error: message,
        });
        return textResult(`browser_use ${action} failed: ${message}`, {
          kind: "browser_use/v1",
          action,
          status: "error",
          ...invocationMetadata,
          summary: `browser_use ${action} failed`,
          error: message,
        });
      }
    },
  };
}

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
  command?: string;
  summary: string;
  result?: unknown;
  error?: string;
};

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
  if (result && typeof result === "object") {
    const record = result as Record<string, unknown>;
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
  return {
    browserSessionId: readStringParam(params, "browserSessionId"),
    tabId: readStringParam(params, "tabId"),
    ref: readStringParam(params, "ref"),
    selector: readStringParam(params, "selector"),
    text: readStringParam(params, "text", { allowEmpty: true }),
    deltaX: readNumberParam(params, "deltaX"),
    deltaY: readNumberParam(params, "deltaY"),
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
  const activation = normalizeBrowserUseSessionConfig(options.sessionConfig)?.activation ?? "auto";
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
              url,
              browserSessionId: readStringParam(params, "browserSessionId"),
            },
          });
        } else if (action === "observe") {
          command = "browser.observe";
          result = await invokeBrowserClientCommand({
            sessionKey: options.sessionKey,
            command,
            timeoutMs,
            commandParams: {
              browserSessionId: readStringParam(params, "browserSessionId"),
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
              browserSessionId: readStringParam(params, "browserSessionId"),
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
        log.info(summary, {
          sessionKey: options.sessionKey,
          agentId: options.agentId,
          action,
          command,
        });
        return textResult(summary, {
          kind: "browser_use/v1",
          action,
          status: "success",
          command,
          summary,
          result,
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
          summary: `browser_use ${action} failed`,
          error: message,
        });
      }
    },
  };
}

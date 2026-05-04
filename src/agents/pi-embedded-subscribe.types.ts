import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { ReasoningLevel, VerboseLevel } from "../auto-reply/thinking.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HookRunner } from "../plugins/hooks.js";
import type { AgentInternalEvent } from "./internal-events.js";
import type { BlockReplyChunking } from "./pi-embedded-block-chunker.js";
import type { BlockReplyPayload } from "./pi-embedded-payloads.js";
import type { EmbeddedRunReplayState } from "./pi-embedded-runner/replay-state.js";

export type ToolResultFormat = "markdown" | "plain";

export type SubscribeEmbeddedPiSessionParams = {
  session: AgentSession;
  runId: string;
  agentId?: string;
  sessionKey?: string;
  /**
   * OpenClaw logical session identifier (may differ from AgentSession.id in ephemeral runs).
   */
  sessionId?: string;
  hookRunner?: HookRunner;
  internalEvents?: AgentInternalEvent[];
  initialReplayState?: EmbeddedRunReplayState;
  verboseLevel?: VerboseLevel;
  reasoningMode?: ReasoningLevel;
  toolResultFormat?: ToolResultFormat;
  silentExpected?: boolean;
  shouldEmitToolResult?: () => boolean;
  shouldEmitToolOutput?: () => boolean;
  onToolResult?: (payload: ReplyPayload) => void | Promise<void>;
  onReasoningStream?: (payload: { text?: string; mediaUrls?: string[] }) => void | Promise<void>;
  /** Called when a thinking/reasoning block ends (</think> tag processed). */
  onReasoningEnd?: () => void | Promise<void>;
  onBlockReply?: (payload: BlockReplyPayload) => void | Promise<void>;
  /** Flush pending block replies (e.g., before tool execution to preserve message boundaries). */
  onBlockReplyFlush?: () => void | Promise<void>;
  blockReplyBreak?: "text_end" | "message_end";
  blockReplyChunking?: BlockReplyChunking;
  onPartialReply?: (payload: { text?: string; mediaUrls?: string[] }) => void | Promise<void>;
  onAssistantMessageStart?: () => void | Promise<void>;
  onAgentEvent?: (evt: { stream: string; data: Record<string, unknown> }) => void | Promise<void>;
  /** Best-effort hook invoked immediately before the terminal lifecycle event is emitted. */
  onBeforeLifecycleTerminal?: () => void | Promise<void>;
  enforceFinalTag?: boolean;
  config?: OpenClawConfig;
  /**
   * Exact raw names of non-plugin OpenClaw tools registered for this run.
   * When provided, MEDIA: passthrough requires an exact match instead of only
   * a normalized-name collision with a trusted built-in.
   */
  builtinToolNames?: ReadonlySet<string>;
};

export type { BlockReplyChunking } from "./pi-embedded-block-chunker.js";

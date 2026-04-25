import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CURRENT_SESSION_VERSION, SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createActiveRun,
  createChatAbortContext,
  invokeChatAbortHandler,
} from "./chat.abort.test-helpers.js";

type TranscriptLine = {
  message?: Record<string, unknown>;
};

type AppendMessageArg = Parameters<SessionManager["appendMessage"]>[0];

const sessionEntryState = vi.hoisted(() => ({
  transcriptPath: "",
  sessionId: "",
}));

const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

vi.mock("../session-utils.js", async () => {
  const original =
    await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...original,
    loadSessionEntry: () => ({
      cfg: {},
      storePath: path.join(path.dirname(sessionEntryState.transcriptPath), "sessions.json"),
      entry: {
        sessionId: sessionEntryState.sessionId,
        sessionFile: sessionEntryState.transcriptPath,
      },
      canonicalKey: "main",
    }),
  };
});

const { chatHandlers } = await import("./chat.js");

async function writeTranscriptHeader(transcriptPath: string, sessionId: string) {
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: sessionId,
    timestamp: new Date(0).toISOString(),
    cwd: "/tmp",
  };
  await fs.writeFile(transcriptPath, `${JSON.stringify(header)}\n`, "utf-8");
}

async function readTranscriptLines(transcriptPath: string): Promise<TranscriptLine[]> {
  const raw = await fs.readFile(transcriptPath, "utf-8");
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as TranscriptLine;
      } catch {
        return {};
      }
    });
}

function appendTranscriptMessage(transcriptPath: string, message: AppendMessageArg) {
  const session = SessionManager.open(transcriptPath);
  session.appendMessage(message);
}

function extractPersistedText(message: Record<string, unknown> | undefined): string | undefined {
  const content = message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const parts = content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return undefined;
      }
      const text = (block as { text?: unknown }).text;
      return typeof text === "string" ? text : undefined;
    })
    .filter((text): text is string => typeof text === "string");
  return parts.length > 0 ? parts.join("") : undefined;
}

function setMockSessionEntry(transcriptPath: string, sessionId: string) {
  sessionEntryState.transcriptPath = transcriptPath;
  sessionEntryState.sessionId = sessionId;
}

async function createTranscriptFixture(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const sessionId = "sess-main";
  const transcriptPath = path.join(dir, `${sessionId}.jsonl`);
  await writeTranscriptHeader(transcriptPath, sessionId);
  setMockSessionEntry(transcriptPath, sessionId);
  return { transcriptPath, sessionId };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("chat abort transcript persistence", () => {
  it("persists run-scoped abort partial with rpc metadata and idempotency", async () => {
    const { transcriptPath, sessionId } = await createTranscriptFixture("openclaw-chat-abort-run-");
    const runId = "idem-abort-run-1";
    const respond = vi.fn();
    const context = createChatAbortContext({
      chatAbortControllers: new Map([[runId, createActiveRun("main", { sessionId })]]),
      chatRunBuffers: new Map([[runId, "Partial from run abort"]]),
      chatDeltaSentAt: new Map([[runId, Date.now()]]),
      removeChatRun: vi
        .fn()
        .mockReturnValue({ sessionKey: "main", clientRunId: "client-idem-abort-run-1" }),
      agentRunSeq: new Map<string, number>([
        [runId, 2],
        ["client-idem-abort-run-1", 3],
      ]),
      broadcast: vi.fn(),
      nodeSendToSession: vi.fn(),
      logGateway: { warn: vi.fn() },
    });

    await invokeChatAbortHandler({
      handler: chatHandlers["chat.abort"],
      context,
      request: { sessionKey: "main", runId },
      respond,
    });

    const [ok1, payload1] = respond.mock.calls.at(-1) ?? [];
    expect(ok1).toBe(true);
    expect(payload1).toMatchObject({ aborted: true, runIds: [runId] });

    context.chatAbortControllers.set(runId, createActiveRun("main", { sessionId }));
    context.chatRunBuffers.set(runId, "Partial from run abort");
    context.chatDeltaSentAt.set(runId, Date.now());

    await invokeChatAbortHandler({
      handler: chatHandlers["chat.abort"],
      context,
      request: { sessionKey: "main", runId },
      respond,
    });

    const lines = await readTranscriptLines(transcriptPath);
    const persisted = lines
      .map((line) => line.message)
      .filter(
        (message): message is Record<string, unknown> =>
          Boolean(message) && message?.idempotencyKey === `${runId}:assistant`,
      );

    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      stopReason: "stop",
      idempotencyKey: `${runId}:assistant`,
      openclawAbort: {
        aborted: true,
        origin: "rpc",
        runId,
      },
    });
  });

  it("persists session-scoped abort partials with rpc metadata", async () => {
    const { transcriptPath, sessionId } = await createTranscriptFixture(
      "openclaw-chat-abort-session-",
    );
    const respond = vi.fn();
    const context = createChatAbortContext({
      chatAbortControllers: new Map([
        ["run-a", createActiveRun("main", { sessionId })],
        ["run-b", createActiveRun("main", { sessionId })],
      ]),
      chatRunBuffers: new Map([
        ["run-a", "Session abort partial"],
        ["run-b", "   "],
      ]),
      chatDeltaSentAt: new Map([
        ["run-a", Date.now()],
        ["run-b", Date.now()],
      ]),
    });

    await invokeChatAbortHandler({
      handler: chatHandlers["chat.abort"],
      context,
      request: { sessionKey: "main" },
      respond,
    });

    const [ok, payload] = respond.mock.calls.at(-1) ?? [];
    expect(ok).toBe(true);
    expect(payload).toMatchObject({ aborted: true });
    expect(payload.runIds).toEqual(expect.arrayContaining(["run-a", "run-b"]));

    const lines = await readTranscriptLines(transcriptPath);
    const runAPersisted = lines
      .map((line) => line.message)
      .find((message) => message?.idempotencyKey === "run-a:assistant");
    const runBPersisted = lines
      .map((line) => line.message)
      .find((message) => message?.idempotencyKey === "run-b:assistant");

    expect(runAPersisted).toMatchObject({
      idempotencyKey: "run-a:assistant",
      openclawAbort: {
        aborted: true,
        origin: "rpc",
        runId: "run-a",
      },
    });
    expect(runBPersisted).toBeUndefined();
  });

  it("does not persist an abort aggregate when current-run assistant segments already cover it", async () => {
    const { transcriptPath, sessionId } = await createTranscriptFixture(
      "openclaw-chat-abort-dedupe-",
    );
    const runId = "idem-abort-dedupe-run";
    appendTranscriptMessage(transcriptPath, {
      role: "user",
      content: [
        {
          type: "text",
          text: `Conversation info:\n${runId}\n\nsend a message`,
        },
      ],
      timestamp: Date.now(),
    });
    appendTranscriptMessage(transcriptPath, {
      role: "assistant",
      content: [
        { type: "text", text: "我直接用电脑界面操作飞书发出去。" },
        { type: "toolCall", id: "call_1", name: "computer_use", arguments: { action: "observe" } },
      ],
      api: "openai-completions",
      provider: "video-workflow",
      model: "gpt-5.4",
      usage: zeroUsage,
      timestamp: Date.now() + 1,
      stopReason: "toolUse",
    });
    appendTranscriptMessage(transcriptPath, {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "computer_use",
      content: [{ type: "text", text: "ok" }],
      isError: false,
      timestamp: Date.now() + 2,
    });
    appendTranscriptMessage(transcriptPath, {
      role: "assistant",
      content: [
        { type: "text", text: "我先在飞书里搜索“杨万权”，切到正确会话后发送。" },
        { type: "toolCall", id: "call_2", name: "computer_use", arguments: { action: "click" } },
      ],
      api: "openai-completions",
      provider: "video-workflow",
      model: "gpt-5.4",
      usage: zeroUsage,
      timestamp: Date.now() + 3,
      stopReason: "toolUse",
    });

    const respond = vi.fn();
    const context = createChatAbortContext({
      chatAbortControllers: new Map([[runId, createActiveRun("main", { sessionId })]]),
      chatRunBuffers: new Map([
        [runId, "我直接用电脑界面操作飞书发出去。我先在飞书里搜索“杨万权”，切到正确会话后发送。"],
      ]),
      chatDeltaSentAt: new Map([[runId, Date.now()]]),
    });

    await invokeChatAbortHandler({
      handler: chatHandlers["chat.abort"],
      context,
      request: { sessionKey: "main", runId },
      respond,
    });

    const lines = await readTranscriptLines(transcriptPath);
    const persisted = lines
      .map((line) => line.message)
      .find((message) => message?.idempotencyKey === `${runId}:assistant`);
    expect(persisted).toBeUndefined();
  });

  it("persists only the missing abort suffix when current-run transcript covers a prefix", async () => {
    const { transcriptPath, sessionId } = await createTranscriptFixture(
      "openclaw-chat-abort-suffix-",
    );
    const runId = "idem-abort-suffix-run";
    appendTranscriptMessage(transcriptPath, {
      role: "user",
      content: `Conversation info: ${runId}`,
      timestamp: Date.now(),
    });
    appendTranscriptMessage(transcriptPath, {
      role: "assistant",
      content: [{ type: "text", text: "已写入的前半段。" }],
      api: "openai-completions",
      provider: "video-workflow",
      model: "gpt-5.4",
      usage: zeroUsage,
      timestamp: Date.now() + 1,
      stopReason: "toolUse",
    });

    const respond = vi.fn();
    const context = createChatAbortContext({
      chatAbortControllers: new Map([[runId, createActiveRun("main", { sessionId })]]),
      chatRunBuffers: new Map([[runId, "已写入的前半段。还没有落盘的尾巴。"]]),
      chatDeltaSentAt: new Map([[runId, Date.now()]]),
    });

    await invokeChatAbortHandler({
      handler: chatHandlers["chat.abort"],
      context,
      request: { sessionKey: "main", runId },
      respond,
    });

    const lines = await readTranscriptLines(transcriptPath);
    const persisted = lines
      .map((line) => line.message)
      .find((message) => message?.idempotencyKey === `${runId}:assistant`);
    expect(extractPersistedText(persisted)).toBe("还没有落盘的尾巴。");
    expect(persisted).toMatchObject({
      openclawAbort: {
        aborted: true,
        origin: "rpc",
        runId,
      },
    });
  });

  it("persists /stop partials with stop-command metadata", async () => {
    const { transcriptPath, sessionId } = await createTranscriptFixture("openclaw-chat-stop-");
    const respond = vi.fn();
    const context = createChatAbortContext({
      chatAbortControllers: new Map([["run-stop-1", createActiveRun("main", { sessionId })]]),
      chatRunBuffers: new Map([["run-stop-1", "Partial from /stop"]]),
      chatDeltaSentAt: new Map([["run-stop-1", Date.now()]]),
      removeChatRun: vi.fn().mockReturnValue({ sessionKey: "main", clientRunId: "client-stop-1" }),
      agentRunSeq: new Map<string, number>([["run-stop-1", 1]]),
      dedupe: {
        get: vi.fn(),
      },
    });

    await chatHandlers["chat.send"]({
      params: {
        sessionKey: "main",
        message: "/stop",
        idempotencyKey: "idem-stop-req",
      },
      respond,
      context: context as never,
      req: {} as never,
      client: null,
      isWebchatConnect: () => false,
    });

    const [ok, payload] = respond.mock.calls.at(-1) ?? [];
    expect(ok).toBe(true);
    expect(payload).toMatchObject({ aborted: true, runIds: ["run-stop-1"] });

    const lines = await readTranscriptLines(transcriptPath);
    const persisted = lines
      .map((line) => line.message)
      .find((message) => message?.idempotencyKey === "run-stop-1:assistant");

    expect(persisted).toMatchObject({
      idempotencyKey: "run-stop-1:assistant",
      openclawAbort: {
        aborted: true,
        origin: "stop-command",
        runId: "run-stop-1",
      },
    });
  });

  it("skips run-scoped transcript persistence when partial text is blank", async () => {
    const { transcriptPath, sessionId } = await createTranscriptFixture(
      "openclaw-chat-abort-run-blank-",
    );
    const runId = "idem-abort-run-blank";
    const respond = vi.fn();
    const context = createChatAbortContext({
      chatAbortControllers: new Map([[runId, createActiveRun("main", { sessionId })]]),
      chatRunBuffers: new Map([[runId, "  \n\t  "]]),
      chatDeltaSentAt: new Map([[runId, Date.now()]]),
    });

    await invokeChatAbortHandler({
      handler: chatHandlers["chat.abort"],
      context,
      request: { sessionKey: "main", runId },
      respond,
    });

    const [ok, payload] = respond.mock.calls.at(-1) ?? [];
    expect(ok).toBe(true);
    expect(payload).toMatchObject({ aborted: true, runIds: [runId] });

    const lines = await readTranscriptLines(transcriptPath);
    const persisted = lines
      .map((line) => line.message)
      .find((message) => message?.idempotencyKey === `${runId}:assistant`);
    expect(persisted).toBeUndefined();
  });
});

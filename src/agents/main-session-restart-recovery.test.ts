import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSessionStore, type SessionEntry } from "../config/sessions.js";
import { callGateway } from "../gateway/call.js";
import { readSessionMessages } from "../gateway/session-utils.fs.js";
import {
  markRestartAbortedMainSessionsFromLocks,
  recoverRestartAbortedMainSessions,
} from "./main-session-restart-recovery.js";
import type { SessionLockInspection } from "./session-write-lock.js";

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async () => ({ runId: "run-resumed" })),
}));

let tmpDir: string;

beforeEach(async () => {
  vi.clearAllMocks();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-main-restart-recovery-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function makeSessionsDir(agentId = "main"): Promise<string> {
  const sessionsDir = path.join(tmpDir, "agents", agentId, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  return sessionsDir;
}

async function writeStore(sessionsDir: string, store: Record<string, SessionEntry>): Promise<void> {
  await fs.writeFile(path.join(sessionsDir, "sessions.json"), JSON.stringify(store, null, 2));
}

async function writeTranscript(
  sessionsDir: string,
  sessionId: string,
  messages: unknown[],
): Promise<void> {
  const lines = messages.map((message) => JSON.stringify({ message })).join("\n");
  await fs.writeFile(path.join(sessionsDir, `${sessionId}.jsonl`), `${lines}\n`);
}

function writeSessionManagerTranscript(
  sessionsDir: string,
  sessionId: string,
  messages: Parameters<SessionManager["appendMessage"]>[0][],
): void {
  const session = SessionManager.open(path.join(sessionsDir, `${sessionId}.jsonl`));
  for (const message of messages) {
    session.appendMessage(message);
  }
}

function cleanedLock(sessionsDir: string, sessionId: string): SessionLockInspection {
  return {
    lockPath: path.join(sessionsDir, `${sessionId}.jsonl.lock`),
    pid: 999_999,
    pidAlive: false,
    createdAt: new Date(Date.now() - 1_000).toISOString(),
    ageMs: 1_000,
    stale: true,
    staleReasons: ["dead-pid"],
    removed: true,
  };
}

describe("main-session-restart-recovery", () => {
  it("marks only main running sessions whose transcript lock was cleaned", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
      },
      "agent:main:subagent:child": {
        sessionId: "child-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        spawnDepth: 1,
      },
      "agent:main:other": {
        sessionId: "other-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
      },
    });

    const result = await markRestartAbortedMainSessionsFromLocks({
      sessionsDir,
      cleanedLocks: [
        cleanedLock(sessionsDir, "main-session"),
        cleanedLock(sessionsDir, "child-session"),
      ],
    });

    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(result).toEqual({ marked: 1, skipped: 1 });
    expect(store["agent:main:main"]?.abortedLastRun).toBe(true);
    expect(store["agent:main:subagent:child"]?.abortedLastRun).toBeUndefined();
    expect(store["agent:main:other"]?.abortedLastRun).toBeUndefined();
  });

  it("resumes marked sessions with a tool-result transcript tail", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "run the tool" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "exec" }] },
      { role: "toolResult", content: "done" },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 1, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    expect(vi.mocked(callGateway).mock.calls[0]?.[0].params).toMatchObject({
      sessionKey: "agent:main:main",
      deliver: false,
      lane: "main",
    });
    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.abortedLastRun).toBe(false);
  });

  it("repairs an interrupted assistant tool-call tail before resuming", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
      },
    });
    writeSessionManagerTranscript(sessionsDir, "main-session", [
      { role: "user", content: "inspect history", timestamp: Date.now() },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "sessions_history", arguments: {} }],
        api: "openai-completions",
        provider: "doxie",
        model: "gpt-5.4",
        stopReason: "toolUse",
        timestamp: Date.now(),
        usage: {
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
        },
      },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 1, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    const messages = readSessionMessages("main-session", path.join(sessionsDir, "sessions.json"));
    const repaired = messages.at(-1);
    expect(repaired).toMatchObject({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "sessions_history",
      isError: true,
    });
    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.abortedLastRun).toBe(false);
  });

  it("does not scan ordinary running sessions without the restart-aborted marker", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "current process owns this" },
      { role: "toolResult", content: "done" },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 0, failed: 0, skipped: 0 });
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("fails marked sessions whose transcript tail cannot be resumed", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "hello" },
      { role: "assistant", content: "partial answer" },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 0, failed: 1, skipped: 0 });
    expect(callGateway).not.toHaveBeenCalled();
    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.status).toBe("failed");
    expect(store["agent:main:main"]?.abortedLastRun).toBe(true);
  });
});

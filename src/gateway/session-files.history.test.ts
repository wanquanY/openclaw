import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { clearSessionStoreCacheForTest } from "../config/sessions.js";
import { listSessionFilesForGateway } from "./session-files.js";

function writeTranscript(params: {
  transcriptPath: string;
  sessionId: string;
  filePath: string;
  toolCallId: string;
  timestamp: string;
}): void {
  const lines = [
    {
      type: "session",
      version: 3,
      id: params.sessionId,
      timestamp: params.timestamp,
      cwd: path.dirname(params.filePath),
    },
    {
      type: "message",
      timestamp: params.timestamp,
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: params.toolCallId,
            name: "write",
            arguments: {
              file_path: params.filePath,
            },
          },
        ],
      },
    },
    {
      type: "message",
      timestamp: params.timestamp,
      message: {
        role: "toolResult",
        toolCallId: params.toolCallId,
        toolName: "write",
        details: {
          status: "completed",
        },
        content: [{ type: "text", text: "ok" }],
      },
    },
  ];
  fs.writeFileSync(
    params.transcriptPath,
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    "utf-8",
  );
}

describe("listSessionFilesForGateway history aggregation", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    clearSessionStoreCacheForTest();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("includes previous session files by default for the same session key", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-files-history-"));
    tempDirs.push(root);
    const sessionsDir = path.join(root, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    const workspaceDir = path.join(root, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });

    const key = "agent:main:webchat-history-test";
    const currentSessionId = "sess-current";
    const previousSessionId = "sess-previous";
    const currentFile = path.join(workspaceDir, "current.md");
    const previousFile = path.join(workspaceDir, "previous.md");
    fs.writeFileSync(currentFile, "current", "utf-8");
    fs.writeFileSync(previousFile, "previous", "utf-8");

    writeTranscript({
      transcriptPath: path.join(sessionsDir, `${previousSessionId}.jsonl`),
      sessionId: previousSessionId,
      filePath: previousFile,
      toolCallId: "tool-prev",
      timestamp: "2026-02-28T07:00:00.000Z",
    });
    writeTranscript({
      transcriptPath: path.join(sessionsDir, `${currentSessionId}.jsonl`),
      sessionId: currentSessionId,
      filePath: currentFile,
      toolCallId: "tool-current",
      timestamp: "2026-03-01T12:00:00.000Z",
    });

    const storePath = path.join(sessionsDir, "sessions.json");
    fs.writeFileSync(
      storePath,
      JSON.stringify(
        {
          [key]: {
            sessionId: currentSessionId,
            updatedAt: Date.parse("2026-03-01T12:00:00.000Z"),
            previousSessions: [
              {
                sessionId: previousSessionId,
                updatedAt: Date.parse("2026-02-28T07:00:00.000Z"),
              },
            ],
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const cfg = {
      session: {
        store: storePath,
      },
    } as OpenClawConfig;

    const result = listSessionFilesForGateway({
      cfg,
      key,
      opts: {
        key,
        scope: "changed",
        includeMissing: false,
        limit: 500,
      },
    });

    expect(result.status).toBe("ok");
    expect(result.files.map((item) => item.path).toSorted()).toEqual(
      [currentFile, previousFile].toSorted(),
    );
  });

  it("can disable historical aggregation via includeHistory=false", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-files-no-history-"));
    tempDirs.push(root);
    const sessionsDir = path.join(root, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    const workspaceDir = path.join(root, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });

    const key = "agent:main:webchat-history-disabled";
    const currentSessionId = "sess-current-only";
    const previousSessionId = "sess-previous-only";
    const currentFile = path.join(workspaceDir, "only-current.md");
    const previousFile = path.join(workspaceDir, "should-not-show.md");
    fs.writeFileSync(currentFile, "current", "utf-8");
    fs.writeFileSync(previousFile, "previous", "utf-8");

    writeTranscript({
      transcriptPath: path.join(sessionsDir, `${previousSessionId}.jsonl`),
      sessionId: previousSessionId,
      filePath: previousFile,
      toolCallId: "tool-prev-only",
      timestamp: "2026-02-28T07:00:00.000Z",
    });
    writeTranscript({
      transcriptPath: path.join(sessionsDir, `${currentSessionId}.jsonl`),
      sessionId: currentSessionId,
      filePath: currentFile,
      toolCallId: "tool-current-only",
      timestamp: "2026-03-01T12:00:00.000Z",
    });

    const storePath = path.join(sessionsDir, "sessions.json");
    fs.writeFileSync(
      storePath,
      JSON.stringify(
        {
          [key]: {
            sessionId: currentSessionId,
            updatedAt: Date.parse("2026-03-01T12:00:00.000Z"),
            previousSessions: [
              {
                sessionId: previousSessionId,
                updatedAt: Date.parse("2026-02-28T07:00:00.000Z"),
              },
            ],
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const cfg = {
      session: {
        store: storePath,
      },
    } as OpenClawConfig;

    const result = listSessionFilesForGateway({
      cfg,
      key,
      opts: {
        key,
        scope: "changed",
        includeMissing: false,
        includeHistory: false,
        limit: 500,
      },
    });

    expect(result.status).toBe("ok");
    expect(result.files.map((item) => item.path)).toEqual([currentFile]);
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { __setMaxChatHistoryMessagesBytesForTest } from "./server-constants.js";
import {
  connectOk,
  getReplyFromConfig,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
  startServerWithClient,
  testState,
  writeSessionStore,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

async function waitFor(condition: () => boolean, timeoutMs = 1_500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timeout waiting for condition");
}

const sendReq = (
  ws: { send: (payload: string) => void },
  id: string,
  method: string,
  params: unknown,
) => {
  ws.send(
    JSON.stringify({
      type: "req",
      id,
      method,
      params,
    }),
  );
};

describe("gateway server chat", () => {
  test("smoke: caps history payload and preserves routing metadata", async () => {
    const tempDirs: string[] = [];
    const { server, ws } = await startServerWithClient();
    try {
      const historyMaxBytes = 192 * 1024;
      __setMaxChatHistoryMessagesBytesForTest(historyMaxBytes);
      await connectOk(ws);

      const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
      tempDirs.push(sessionDir);
      testState.sessionStorePath = path.join(sessionDir, "sessions.json");

      await writeSessionStore({
        entries: {
          main: { sessionId: "sess-main", updatedAt: Date.now() },
        },
      });

      const bigText = "x".repeat(4_000);
      const historyLines: string[] = [];
      for (let i = 0; i < 60; i += 1) {
        historyLines.push(
          JSON.stringify({
            message: {
              role: "user",
              content: [{ type: "text", text: `${i}:${bigText}` }],
              timestamp: Date.now() + i,
            },
          }),
        );
      }
      await fs.writeFile(
        path.join(sessionDir, "sess-main.jsonl"),
        historyLines.join("\n"),
        "utf-8",
      );

      const historyRes = await rpcReq<{ messages?: unknown[] }>(ws, "chat.history", {
        sessionKey: "main",
        limit: 1000,
      });
      expect(historyRes.ok).toBe(true);
      const messages = historyRes.payload?.messages ?? [];
      const bytes = Buffer.byteLength(JSON.stringify(messages), "utf8");
      expect(bytes).toBeLessThanOrEqual(historyMaxBytes);
      expect(messages.length).toBeLessThan(60);

      await writeSessionStore({
        entries: {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
            lastChannel: "whatsapp",
            lastTo: "+1555",
          },
        },
      });

      const sendRes = await rpcReq(ws, "chat.send", {
        sessionKey: "main",
        message: "hello",
        idempotencyKey: "idem-route",
      });
      expect(sendRes.ok).toBe(true);

      const stored = JSON.parse(await fs.readFile(testState.sessionStorePath, "utf-8")) as Record<
        string,
        { lastChannel?: string; lastTo?: string } | undefined
      >;
      expect(stored["agent:main:main"]?.lastChannel).toBe("whatsapp");
      expect(stored["agent:main:main"]?.lastTo).toBe("+1555");
    } finally {
      __setMaxChatHistoryMessagesBytesForTest();
      testState.sessionStorePath = undefined;
      ws.close();
      await server.close();
      await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    }
  });

  test("chat.history paginates across archived session segments", async () => {
    const tempDirs: string[] = [];
    const { server, ws } = await startServerWithClient();
    try {
      await connectOk(ws);

      const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
      tempDirs.push(sessionDir);
      testState.sessionStorePath = path.join(sessionDir, "sessions.json");

      const archivedFile = path.join(sessionDir, "sess-old.jsonl.reset.2026-02-15T12-00-00.000Z");
      await writeSessionStore({
        entries: {
          main: {
            sessionId: "sess-main",
            sessionFile: path.join(sessionDir, "sess-main.jsonl"),
            updatedAt: Date.now(),
            historySegments: [
              {
                sessionId: "sess-old",
                archivedFiles: [archivedFile],
                endedAt: Date.now() - 1_000,
              },
            ],
          },
        },
      });

      const makeLines = (prefix: string, count: number) =>
        Array.from({ length: count }, (_, index) =>
          JSON.stringify({
            message: {
              role: "user",
              content: [{ type: "text", text: `${prefix}${index + 1}` }],
              timestamp: Date.now() + index,
            },
          }),
        ).join("\n");

      await fs.writeFile(archivedFile, makeLines("o", 3), "utf-8");
      await fs.writeFile(path.join(sessionDir, "sess-main.jsonl"), makeLines("c", 2), "utf-8");

      const firstPage = await rpcReq<{
        messages?: unknown[];
        hasMore?: boolean;
        nextBefore?: string;
      }>(ws, "chat.history", {
        sessionKey: "main",
        limit: 2,
      });
      expect(firstPage.ok).toBe(true);
      expect(firstPage.payload?.hasMore).toBe(true);
      expect(typeof firstPage.payload?.nextBefore).toBe("string");

      const textOf = (message: unknown): string | undefined => {
        if (!message || typeof message !== "object") {
          return undefined;
        }
        const content = (message as { content?: unknown }).content;
        if (!Array.isArray(content) || content.length === 0) {
          return undefined;
        }
        const first = content[0];
        if (!first || typeof first !== "object") {
          return undefined;
        }
        const text = (first as { text?: unknown }).text;
        return typeof text === "string" ? text : undefined;
      };

      expect((firstPage.payload?.messages ?? []).map(textOf)).toEqual(["c1", "c2"]);

      const secondPage = await rpcReq<{
        messages?: unknown[];
        hasMore?: boolean;
        nextBefore?: string;
      }>(ws, "chat.history", {
        sessionKey: "main",
        limit: 2,
        before: firstPage.payload?.nextBefore,
      });
      expect(secondPage.ok).toBe(true);
      expect((secondPage.payload?.messages ?? []).map(textOf)).toEqual(["o2", "o3"]);
      expect(secondPage.payload?.hasMore).toBe(true);

      const thirdPage = await rpcReq<{
        messages?: unknown[];
        hasMore?: boolean;
      }>(ws, "chat.history", {
        sessionKey: "main",
        limit: 2,
        before: secondPage.payload?.nextBefore,
      });
      expect(thirdPage.ok).toBe(true);
      expect((thirdPage.payload?.messages ?? []).map(textOf)).toEqual(["o1"]);
      expect(thirdPage.payload?.hasMore).toBe(false);
    } finally {
      testState.sessionStorePath = undefined;
      ws.close();
      await server.close();
      await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    }
  });

  test("smoke: supports abort and idempotent completion", async () => {
    const tempDirs: string[] = [];
    const { server, ws } = await startServerWithClient();
    const spy = vi.mocked(getReplyFromConfig);
    let aborted = false;

    try {
      await connectOk(ws);

      const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
      tempDirs.push(sessionDir);
      testState.sessionStorePath = path.join(sessionDir, "sessions.json");

      await writeSessionStore({
        entries: {
          main: { sessionId: "sess-main", updatedAt: Date.now() },
        },
      });

      spy.mockReset();
      spy.mockImplementationOnce(async (_ctx, opts) => {
        opts?.onAgentRunStart?.(opts.runId ?? "idem-abort-1");
        const signal = opts?.abortSignal;
        await new Promise<void>((resolve) => {
          if (!signal || signal.aborted) {
            aborted = Boolean(signal?.aborted);
            resolve();
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          );
        });
      });

      const sendResP = onceMessage(ws, (o) => o.type === "res" && o.id === "send-abort-1", 8_000);
      sendReq(ws, "send-abort-1", "chat.send", {
        sessionKey: "main",
        message: "hello",
        idempotencyKey: "idem-abort-1",
        timeoutMs: 30_000,
      });

      const sendRes = await sendResP;
      expect(sendRes.ok).toBe(true);
      await waitFor(() => spy.mock.calls.length > 0, 2_000);

      const inFlight = await rpcReq<{ status?: string }>(ws, "chat.send", {
        sessionKey: "main",
        message: "hello",
        idempotencyKey: "idem-abort-1",
      });
      expect(inFlight.ok).toBe(true);
      expect(["started", "in_flight", "ok"]).toContain(inFlight.payload?.status ?? "");

      const abortRes = await rpcReq<{ aborted?: boolean }>(ws, "chat.abort", {
        sessionKey: "main",
        runId: "idem-abort-1",
      });
      expect(abortRes.ok).toBe(true);
      expect(abortRes.payload?.aborted).toBe(true);
      await waitFor(() => aborted, 2_000);

      spy.mockReset();
      spy.mockResolvedValueOnce(undefined);

      const completeRes = await rpcReq<{ status?: string }>(ws, "chat.send", {
        sessionKey: "main",
        message: "hello",
        idempotencyKey: "idem-complete-1",
      });
      expect(completeRes.ok).toBe(true);

      let completed = false;
      for (let i = 0; i < 20; i += 1) {
        const again = await rpcReq<{ status?: string }>(ws, "chat.send", {
          sessionKey: "main",
          message: "hello",
          idempotencyKey: "idem-complete-1",
        });
        if (again.ok && again.payload?.status === "ok") {
          completed = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(completed).toBe(true);
    } finally {
      __setMaxChatHistoryMessagesBytesForTest();
      testState.sessionStorePath = undefined;
      ws.close();
      await server.close();
      await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    }
  });
});

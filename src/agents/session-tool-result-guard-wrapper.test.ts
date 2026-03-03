import { SessionManager } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { guardSessionManager } from "./session-tool-result-guard-wrapper.js";

describe("guardSessionManager", () => {
  it("applies custom message transform before transcript persistence", () => {
    const sessionManager = SessionManager.inMemory();
    guardSessionManager(sessionManager, {
      transformMessageForPersistence: (message) => {
        if ((message as { role?: unknown }).role !== "user") {
          return message;
        }
        return {
          ...(message as unknown as Record<string, unknown>),
          content: [{ type: "text", text: "transformed" }],
        } as typeof message;
      },
    });

    sessionManager.appendMessage({
      role: "user",
      content: "hello",
      timestamp: Date.now(),
    });

    const entries = sessionManager
      .getEntries()
      .filter((entry) => entry.type === "message") as Array<{ message: { content?: unknown } }>;
    expect(entries.length).toBe(1);
    expect(entries[0]?.message?.content).toEqual([{ type: "text", text: "transformed" }]);
  });
});

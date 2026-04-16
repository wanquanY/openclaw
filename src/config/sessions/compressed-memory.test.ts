import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../types.openclaw.js";
import type { SessionEntry } from "./types.js";
import {
  buildCompressedSessionMemoryPrompt,
  persistCompressedSessionMemory,
} from "./compressed-memory.js";

async function writeSessionStore(
  storePath: string,
  sessionKey: string,
  entry: SessionEntry,
): Promise<void> {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify({ [sessionKey]: entry }, null, 2), "utf8");
}

describe("compressed session memory", () => {
  let rootDir = "";

  afterEach(async () => {
    if (rootDir) {
      await fs.rm(rootDir, { recursive: true, force: true });
      rootDir = "";
    }
  });

  it("persists the latest compaction summary onto the session entry", async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compressed-memory-"));
    const storePath = path.join(rootDir, "sessions.json");
    const sessionKey = "agent:main:main";
    const entry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 1,
    };
    await writeSessionStore(storePath, sessionKey, entry);

    const cfg: OpenClawConfig = {
      session: {
        store: storePath,
      },
    };

    const persisted = await persistCompressedSessionMemory({
      cfg,
      sessionKey,
      summary: "User wants a complete 2.5 plan; product listing before launch is already correct.",
      updatedAt: 123,
      tokensBefore: 80_000,
      tokensAfter: 12_000,
    });

    expect(persisted).toMatchObject({
      updatedAt: 123,
      tokensBefore: 80_000,
      tokensAfter: 12_000,
    });

    const saved = JSON.parse(await fs.readFile(storePath, "utf8")) as Record<string, SessionEntry>;
    expect(saved[sessionKey]?.compressedSessionMemory?.summary).toContain("2.5 plan");
    expect(saved[sessionKey]?.compressedSessionMemory?.tokensAfter).toBe(12_000);
  });

  it("formats compressed memory as a system prompt block", () => {
    const prompt = buildCompressedSessionMemoryPrompt({
      compressedSessionMemory: {
        summary: "Current task: rebuild only the post-launch half. Constraint: do not change pre-launch flow.",
        updatedAt: 1_700_000_000_000,
        compactionCount: 3,
        tokensBefore: 90_000,
        tokensAfter: 14_000,
      },
    });

    expect(prompt).toContain("[Session compressed memory]");
    expect(prompt).toContain("Current task: rebuild only the post-launch half");
    expect(prompt).toContain("Compaction count: 3");
    expect(prompt).toContain("Tokens after compaction: 14000");
  });
});

import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  getHoisted,
  resetEmbeddedAttemptHarness,
} from "./attempt.spawn-workspace.test-support.js";

const hoisted = getHoisted();

describe("runEmbeddedAttempt tool registration", () => {
  const tempPaths: string[] = [];

  afterEach(async () => {
    await cleanupTempPaths(tempPaths);
  });

  it("passes OpenClaw-managed custom tools as Pi's session tool allowlist", async () => {
    resetEmbeddedAttemptHarness();

    await createContextEngineAttemptRunner({
      sessionKey: "agent:main:webchat-tool-registration",
      tempPaths,
      contextEngine: {
        assemble: async ({ messages }) => ({
          messages,
          estimatedTokens: 1,
        }),
      },
    });

    const createSessionOptions = hoisted.createAgentSessionMock.mock.calls[0]?.[0] as
      | { tools?: string[]; customTools?: Array<{ name?: string }> }
      | undefined;

    const customToolNames = createSessionOptions?.customTools
      ?.map((tool) => tool.name)
      .filter((name): name is string => typeof name === "string");

    expect(createSessionOptions).toBeDefined();
    expect(customToolNames).toContain("sessions_spawn");
    expect(createSessionOptions?.tools).toEqual(customToolNames?.toSorted());
    expect(createSessionOptions?.tools).not.toEqual([]);
  });
});

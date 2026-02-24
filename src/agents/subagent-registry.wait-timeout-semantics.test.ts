import { afterEach, describe, expect, it, vi } from "vitest";

const noop = () => {};

const state = vi.hoisted(() => ({
  waitCalls: 0,
  waitResponses: [] as Array<Record<string, unknown>>,
}));

const callGatewayMock = vi.hoisted(() =>
  vi.fn(async (opts: unknown) => {
    const request = opts as { method?: string };
    if (request.method !== "agent.wait") {
      return {};
    }
    state.waitCalls += 1;
    const next = state.waitResponses.shift();
    if (next) {
      return next;
    }
    return { status: "ok", startedAt: 1, endedAt: 2 };
  }),
);

const announceSpy = vi.hoisted(() => vi.fn(async () => true));

vi.mock("../gateway/call.js", () => ({
  callGateway: callGatewayMock,
}));

vi.mock("../infra/agent-events.js", () => ({
  onAgentEvent: vi.fn(() => noop),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(() => ({
    agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
  })),
}));

vi.mock("./subagent-announce.js", () => ({
  runSubagentAnnounceFlow: announceSpy,
}));

vi.mock("./subagent-registry.store.js", () => ({
  loadSubagentRegistryFromDisk: vi.fn(() => new Map()),
  saveSubagentRegistryToDisk: vi.fn(() => {}),
}));

const flushAsync = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
};

describe("subagent registry wait timeout semantics", () => {
  afterEach(async () => {
    state.waitCalls = 0;
    state.waitResponses = [];
    callGatewayMock.mockClear();
    announceSpy.mockClear();
    const mod = await import("./subagent-registry.js");
    mod.resetSubagentRegistryForTests({ persist: false });
  });

  it("keeps waiting when agent.wait returns observer timeout without lifecycle timestamps", async () => {
    const mod = await import("./subagent-registry.js");
    state.waitResponses = [{ status: "timeout" }, { status: "ok", startedAt: 10, endedAt: 20 }];

    mod.registerSubagentRun({
      runId: "run-observer-timeout",
      childSessionKey: "agent:main:subagent:observer-timeout",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "observer timeout",
      cleanup: "keep",
      expectsCompletionMessage: true,
    });

    await flushAsync();

    expect(state.waitCalls).toBe(2);
    expect(announceSpy).toHaveBeenCalledTimes(1);
    const announce = (announceSpy.mock.calls[0]?.[0] ?? {}) as {
      outcome?: { status?: string };
    };
    expect(announce.outcome?.status).toBe("ok");
  });

  it("treats timeout as terminal when lifecycle timestamps are present", async () => {
    const mod = await import("./subagent-registry.js");
    state.waitResponses = [{ status: "timeout", startedAt: 30, endedAt: 40 }];

    mod.registerSubagentRun({
      runId: "run-terminal-timeout",
      childSessionKey: "agent:main:subagent:terminal-timeout",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "terminal timeout",
      cleanup: "keep",
      expectsCompletionMessage: true,
    });

    await flushAsync();

    expect(state.waitCalls).toBe(1);
    expect(announceSpy).toHaveBeenCalledTimes(1);
    const announce = (announceSpy.mock.calls[0]?.[0] ?? {}) as {
      outcome?: { status?: string };
    };
    expect(announce.outcome?.status).toBe("timeout");
  });
});

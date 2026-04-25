import { describe, expect, it, vi } from "vitest";

let writtenConfig: unknown = null;
let loadedConfig: Record<string, unknown> = {
  skills: {
    entries: {},
  },
};

vi.mock("../../config/config.js", () => {
  return {
    loadConfig: () => loadedConfig,
    writeConfigFile: async (cfg: unknown) => {
      writtenConfig = cfg;
    },
  };
});

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentIds: () => ["main", "writer"],
  resolveDefaultAgentId: () => "main",
  resolveAgentWorkspaceDir: (_cfg: unknown, agentId: string) => `/tmp/${agentId}`,
}));

const { skillsHandlers } = await import("./skills.js");

describe("skills.update", () => {
  it("strips embedded CR/LF from apiKey", async () => {
    writtenConfig = null;
    loadedConfig = {
      skills: {
        entries: {},
      },
    };

    let ok: boolean | null = null;
    let error: unknown = null;
    await skillsHandlers["skills.update"]({
      params: {
        skillKey: "brave-search",
        apiKey: "abc\r\ndef",
      },
      req: {} as never,
      client: null as never,
      isWebchatConnect: () => false,
      context: {} as never,
      respond: (success, _result, err) => {
        ok = success;
        error = err;
      },
    });

    expect(ok).toBe(true);
    expect(error).toBeUndefined();
    expect(writtenConfig).toMatchObject({
      skills: {
        entries: {
          "brave-search": {
            apiKey: "abcdef",
          },
        },
      },
    });
  });

  it("writes scoped settings under the requested agent", async () => {
    writtenConfig = null;
    loadedConfig = {
      agents: {
        list: [
          {
            id: "writer",
            workspace: "/tmp/writer",
          },
        ],
      },
    };

    let ok: boolean | null = null;
    let error: unknown = null;
    await skillsHandlers["skills.update"]({
      params: {
        agentId: "writer",
        skillKey: "brave-search",
        enabled: false,
        apiKey: "writer\r\nsecret",
        env: {
          BRAVE_SEARCH_KEY: "writer-env",
        },
      },
      req: {} as never,
      client: null as never,
      isWebchatConnect: () => false,
      context: {} as never,
      respond: (success, _result, err) => {
        ok = success;
        error = err;
      },
    });

    expect(ok).toBe(true);
    expect(error).toBeUndefined();
    expect(writtenConfig).toMatchObject({
      agents: {
        list: [
          {
            id: "writer",
            skillSettings: {
              "brave-search": {
                enabled: false,
                apiKey: "writersecret",
                env: {
                  BRAVE_SEARCH_KEY: "writer-env",
                },
              },
            },
          },
        ],
      },
    });
  });
});

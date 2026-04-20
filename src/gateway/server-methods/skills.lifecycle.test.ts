import { beforeEach, describe, expect, it, vi } from "vitest";

const loadConfigMock = vi.fn(() => ({}));
const installWorkspaceSkillFromArchiveMock = vi.fn();
const installWorkspaceSkillFromNpmSpecMock = vi.fn();
const uninstallWorkspaceSkillMock = vi.fn();

vi.mock("../../config/config.js", () => ({
  loadConfig: () => loadConfigMock(),
  writeConfigFile: vi.fn(),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentIds: () => ["main", "writer"],
  resolveDefaultAgentId: () => "main",
  resolveAgentWorkspaceDir: (_cfg: unknown, agentId: string) =>
    agentId === "writer" ? "/tmp/writer-workspace" : "/tmp/main-workspace",
}));

vi.mock("../../agents/skills-manage.js", () => ({
  installWorkspaceSkillFromArchive: (...args: unknown[]) =>
    installWorkspaceSkillFromArchiveMock(...args),
  installWorkspaceSkillFromNpmSpec: (...args: unknown[]) =>
    installWorkspaceSkillFromNpmSpecMock(...args),
  uninstallWorkspaceSkill: (...args: unknown[]) => uninstallWorkspaceSkillMock(...args),
  formatWorkspaceSkillImportError: (error: unknown) => ({
    ok: false,
    message: error instanceof Error ? error.message : String(error),
    warnings: [],
  }),
}));

const { skillsHandlers } = await import("./skills.js");

describe("skills import/uninstall handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadConfigMock.mockReturnValue({});
  });

  it("imports a local archive into the requested agent workspace", async () => {
    installWorkspaceSkillFromArchiveMock.mockResolvedValue({
      ok: true,
      skillName: "calendar",
      skillKey: "calendar",
      message: "Installed calendar",
      warnings: [],
      installedPath: "/tmp/writer-workspace/skills/calendar",
    });

    let ok: boolean | null = null;
    let response: unknown;
    await skillsHandlers["skills.import"]({
      params: {
        source: "file",
        filePath: "/tmp/calendar.skill",
        force: true,
        agentId: "writer",
      },
      req: {} as never,
      client: null as never,
      isWebchatConnect: () => false,
      context: {} as never,
      respond: (success, result) => {
        ok = success;
        response = result;
      },
    });

    expect(installWorkspaceSkillFromArchiveMock).toHaveBeenCalledWith({
      archivePath: "/tmp/calendar.skill",
      workspaceDir: "/tmp/writer-workspace",
      force: true,
      timeoutMs: undefined,
    });
    expect(ok).toBe(true);
    expect(response).toMatchObject({
      ok: true,
      skillName: "calendar",
      installedPath: "/tmp/writer-workspace/skills/calendar",
    });
  });

  it("imports a remote package into the requested agent workspace", async () => {
    installWorkspaceSkillFromNpmSpecMock.mockResolvedValue({
      ok: true,
      skillName: "calendar",
      skillKey: "calendar",
      message: "Installed calendar",
      warnings: [],
      installedPath: "/tmp/writer-workspace/skills/calendar",
    });

    await skillsHandlers["skills.import"]({
      params: {
        source: "remote",
        package: "@openclaw/calendar-skill",
        agentId: "writer",
      },
      req: {} as never,
      client: null as never,
      isWebchatConnect: () => false,
      context: {} as never,
      respond: () => undefined,
    });

    expect(installWorkspaceSkillFromNpmSpecMock).toHaveBeenCalledWith({
      spec: "@openclaw/calendar-skill",
      workspaceDir: "/tmp/writer-workspace",
      registry: undefined,
      force: undefined,
      timeoutMs: undefined,
    });
  });

  it("rejects custom npm registries for remote workspace imports", async () => {
    let ok: boolean | null = null;
    let error: { message?: string } | undefined;

    await skillsHandlers["skills.import"]({
      params: {
        source: "remote",
        package: "@openclaw/calendar-skill",
        registry: "https://registry.example.com",
      },
      req: {} as never,
      client: null as never,
      isWebchatConnect: () => false,
      context: {} as never,
      respond: (success, _result, err) => {
        ok = success;
        error = err as { message?: string } | undefined;
      },
    });

    expect(ok).toBe(false);
    expect(error?.message).toContain("custom npm registry is not supported");
    expect(installWorkspaceSkillFromNpmSpecMock).not.toHaveBeenCalled();
  });

  it("uninstalls a managed workspace skill from the requested agent workspace", async () => {
    uninstallWorkspaceSkillMock.mockResolvedValue({
      ok: true,
      skillKey: "calendar",
      skillName: "Calendar",
      removedPath: "/tmp/writer-workspace/skills/calendar",
    });

    let ok: boolean | null = null;
    let response: unknown;
    await skillsHandlers["skills.uninstall"]({
      params: {
        skillKey: "calendar",
        agentId: "writer",
      },
      req: {} as never,
      client: null as never,
      isWebchatConnect: () => false,
      context: {} as never,
      respond: (success, result) => {
        ok = success;
        response = result;
      },
    });

    expect(uninstallWorkspaceSkillMock).toHaveBeenCalledWith({
      workspaceDir: "/tmp/writer-workspace",
      skillKey: "calendar",
      config: {},
      agentId: "writer",
    });
    expect(ok).toBe(true);
    expect(response).toMatchObject({
      ok: true,
      skillKey: "calendar",
    });
  });
});

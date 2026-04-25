import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildWorkspaceSkillStatus } from "./skills-status.js";
import { createCanonicalFixtureSkill } from "./skills.test-helpers.js";
import type { SkillEntry } from "./skills/types.js";

describe("buildWorkspaceSkillStatus", () => {
  it("does not surface install options for OS-scoped skills on unsupported platforms", () => {
    if (process.platform === "win32") {
      // Keep this simple; win32 platform naming is already explicitly handled elsewhere.
      return;
    }

    const mismatchedOs = process.platform === "darwin" ? "linux" : "darwin";

    const entry: SkillEntry = {
      skill: createFixtureSkill({
        name: "os-scoped",
        description: "test",
        filePath: "/tmp/os-scoped",
        baseDir: "/tmp",
        source: "test",
      }),
      frontmatter: {},
      metadata: {
        os: [mismatchedOs],
        requires: { bins: ["fakebin"] },
        install: [
          {
            id: "brew",
            kind: "brew",
            formula: "fake",
            bins: ["fakebin"],
            label: "Install fake (brew)",
          },
        ],
      },
    };

    const report = buildWorkspaceSkillStatus("/tmp/ws", { entries: [entry] });
    expect(report.skills).toHaveLength(1);
    expect(report.skills[0]?.install).toEqual([]);
  });

  it("does not expose raw config values in config checks", () => {
    const secret = "discord-token-secret-abc"; // pragma: allowlist secret
    const entry: SkillEntry = {
      skill: createFixtureSkill({
        name: "discord",
        description: "test",
        filePath: "/tmp/discord/SKILL.md",
        baseDir: "/tmp/discord",
        source: "test",
      }),
      frontmatter: {},
      metadata: {
        requires: { config: ["channels.discord.token"] },
      },
    };

    const report = buildWorkspaceSkillStatus("/tmp/ws", {
      entries: [entry],
      config: {
        channels: {
          discord: {
            token: secret,
          },
        },
      },
    });

    expect(JSON.stringify(report)).not.toContain(secret);
    const discord = report.skills.find((skill) => skill.name === "discord");
    const check = discord?.configChecks.find((entry) => entry.path === "channels.discord.token");
    expect(check).toEqual({ path: "channels.discord.token", satisfied: true });
    expect(check && "value" in check).toBe(false);
  });

  it("marks workspace-managed installs and preserves their install origin", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-skill-status-"));
    const skillDir = path.join(root, "calendar");
    fs.mkdirSync(path.join(skillDir, ".openclaw"), { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, ".openclaw", "origin.json"),
      JSON.stringify({
        version: 1,
        source: "remote-npm",
        installedAt: Date.now(),
        requestedSpecifier: "@openclaw/calendar-skill",
      }),
    );

    try {
      const entry: SkillEntry = {
        skill: createFixtureSkill({
          name: "calendar",
          description: "test",
          filePath: path.join(skillDir, "SKILL.md"),
          baseDir: skillDir,
          source: "openclaw-workspace",
        }),
        frontmatter: {},
        metadata: {},
      };

      const report = buildWorkspaceSkillStatus(root, { entries: [entry] });
      expect(report.skills[0]).toMatchObject({
        managedInstall: true,
        installOrigin: "remote-npm",
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("merges global, agent-default, and agent-specific skill settings for the target agent", () => {
    const entry: SkillEntry = {
      skill: createFixtureSkill({
        name: "calendar",
        description: "test",
        filePath: "/tmp/calendar/SKILL.md",
        baseDir: "/tmp/calendar",
        source: "test",
      }),
      frontmatter: {},
      metadata: {
        primaryEnv: "CALENDAR_TOKEN",
      },
    };

    const report = buildWorkspaceSkillStatus("/tmp/ws", {
      entries: [entry],
      agentId: "writer",
      config: {
        skills: {
          entries: {
            calendar: {
              enabled: true,
              env: {
                CALENDAR_TOKEN: "global-token",
              },
            },
          },
        },
        agents: {
          defaults: {
            skillSettings: {
              calendar: {
                enabled: true,
                env: {
                  CALENDAR_TOKEN: "defaults-token",
                },
              },
            },
          },
          list: [
            {
              id: "writer",
              skillSettings: {
                calendar: {
                  enabled: false,
                  env: {
                    CALENDAR_TOKEN: "writer-token",
                  },
                },
              },
            },
          ],
        },
      },
    });

    expect(report.skills[0]).toMatchObject({
      disabled: true,
    });
    expect(report.skills[0]?.missing.env).toEqual([]);
  });
});

function createFixtureSkill(params: {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  source: string;
}): SkillEntry["skill"] {
  return createCanonicalFixtureSkill(params);
}

import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { writeBuildStamp } from "../../scripts/build-stamp.mjs";
import { withTempDir } from "../test-helpers/temp-dir.js";

describe("build-stamp script", () => {
  it("writes dist/.buildstamp with the current git head", async () => {
    await withTempDir({ prefix: "openclaw-build-stamp-" }, async (tmp) => {
      const stampPath = writeBuildStamp({
        cwd: tmp,
        now: () => 1_700_000_000_000,
        spawnSync: (cmd: string, args: string[]) => {
          if (cmd === "git" && args[0] === "rev-parse") {
            return { status: 0, stdout: "abc123\n" };
          }
          return { status: 1, stdout: "" };
        },
      });

      await expect(fs.readFile(stampPath, "utf8")).resolves.toBe(
        '{"builtAt":1700000000000,"head":"abc123"}\n',
      );
    });
  });

  it("records the run-node build input fingerprint when source inputs exist", async () => {
    await withTempDir({ prefix: "openclaw-build-stamp-" }, async (tmp) => {
      await fs.mkdir(`${tmp}/src`, { recursive: true });
      await fs.writeFile(`${tmp}/src/index.ts`, "export const value = 1;\n", "utf8");
      await fs.writeFile(`${tmp}/package.json`, '{"name":"openclaw-test"}\n', "utf8");
      await fs.writeFile(`${tmp}/tsconfig.json`, "{}\n", "utf8");
      await fs.writeFile(`${tmp}/tsdown.config.ts`, "export default {};\n", "utf8");

      const stampPath = writeBuildStamp({
        cwd: tmp,
        now: () => 1_700_000_000_000,
        spawnSync: (cmd: string, args: string[]) => {
          if (cmd === "git" && args[0] === "rev-parse") {
            return { status: 0, stdout: "abc123\n" };
          }
          return { status: 1, stdout: "" };
        },
      });

      const stamp = JSON.parse(await fs.readFile(stampPath, "utf8"));
      expect(stamp).toEqual({
        builtAt: 1_700_000_000_000,
        head: "abc123",
        inputFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
    });
  });
});

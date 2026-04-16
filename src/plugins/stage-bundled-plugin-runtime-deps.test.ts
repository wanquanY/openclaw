import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

type StageRuntimeDepsInstallParams = {
  packageJson: Record<string, unknown>;
};

type StageBundledPluginRuntimeDeps = (params?: {
  cwd?: string;
  repoRoot?: string;
  installAttempts?: number;
  installPluginRuntimeDepsImpl?: (params: StageRuntimeDepsInstallParams) => void;
}) => void;

async function loadStageBundledPluginRuntimeDeps(): Promise<StageBundledPluginRuntimeDeps> {
  const moduleUrl = new URL("../../scripts/stage-bundled-plugin-runtime-deps.mjs", import.meta.url);
  const loaded = (await import(moduleUrl.href)) as {
    stageBundledPluginRuntimeDeps: StageBundledPluginRuntimeDeps;
  };
  return loaded.stageBundledPluginRuntimeDeps;
}

async function loadFreshStageBundledPluginRuntimeDeps(
  cacheKey: string,
): Promise<StageBundledPluginRuntimeDeps> {
  const moduleUrl = new URL(
    `../../scripts/stage-bundled-plugin-runtime-deps.mjs?${cacheKey}`,
    import.meta.url,
  );
  const loaded = (await import(moduleUrl.href)) as {
    stageBundledPluginRuntimeDeps: StageBundledPluginRuntimeDeps;
  };
  return loaded.stageBundledPluginRuntimeDeps;
}

async function loadPostinstallBundledPluginsModule(): Promise<{
  applyBaileysEncryptedStreamFinishHotfix: (params?: {
    chmodSync?: (path: string, mode: number) => void;
    packageRoot?: string;
    createTempPath?: (targetPath: string) => string;
    writeFileSync?: (pathOrFd: string | number, value: string, encoding?: string) => void;
  }) => {
    applied: boolean;
    reason: string;
    targetPath?: string;
    error?: string;
  };
}> {
  const moduleUrl = new URL("../../scripts/postinstall-bundled-plugins.mjs", import.meta.url);
  return (await import(moduleUrl.href)) as {
    applyBaileysEncryptedStreamFinishHotfix: (params?: {
      chmodSync?: (path: string, mode: number) => void;
      packageRoot?: string;
      createTempPath?: (targetPath: string) => string;
      writeFileSync?: (pathOrFd: string | number, value: string, encoding?: string) => void;
    }) => {
      applied: boolean;
      reason: string;
      targetPath?: string;
      error?: string;
    };
  };
}

const tempDirs: string[] = [];

function makeRepoRoot(prefix: string): string {
  return makeTrackedTempDir(prefix, tempDirs);
}

function writeRepoFile(repoRoot: string, relativePath: string, value: string) {
  const fullPath = path.join(repoRoot, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, value, "utf8");
}

function createBaileysMessagesMediaSource(params?: {
  dispatcherPatched?: boolean;
  dispatcherHeaderDrifted?: boolean;
  encryptedStreamPatched?: boolean;
  encryptedStreamPatchedSequentially?: boolean;
  encryptedStreamPatchedSequentiallyWithComments?: boolean;
  encryptedStreamUnrecognized?: boolean;
}) {
  const encryptedLines = params?.encryptedStreamUnrecognized
    ? [
        "        encFileWriteStream.write(mac);",
        "        logger?.debug('encrypted data changed upstream');",
      ]
    : params?.encryptedStreamPatchedSequentiallyWithComments
      ? [
          "        encFileWriteStream.write(mac);",
          "        const encFinishPromise = once(encFileWriteStream, 'finish');",
          "        const originalFinishPromise = originalFileStream ? once(originalFileStream, 'finish') : Promise.resolve();",
          "        encFileWriteStream.end();",
          "        originalFileStream?.end?.();",
          "        stream.destroy();",
          "        // Wait for write streams to fully flush to disk before returning encFilePath.",
          "        // Without this await, the caller may open a read stream on the file before",
          "        // the OS has created it, causing a race-condition ENOENT crash.",
          "        await encFinishPromise;",
          "        await originalFinishPromise;",
          "        logger?.debug('encrypted data successfully');",
        ]
      : params?.encryptedStreamPatchedSequentially
        ? [
            "        encFileWriteStream.write(mac);",
            "        const encFinishPromise = once(encFileWriteStream, 'finish');",
            "        const originalFinishPromise = originalFileStream ? once(originalFileStream, 'finish') : Promise.resolve();",
            "        encFileWriteStream.end();",
            "        originalFileStream?.end?.();",
            "        stream.destroy();",
            "        await encFinishPromise;",
            "        await originalFinishPromise;",
            "        logger?.debug('encrypted data successfully');",
          ]
        : params?.encryptedStreamPatched
          ? [
              "        encFileWriteStream.write(mac);",
              "        const encFinishPromise = once(encFileWriteStream, 'finish');",
              "        const originalFinishPromise = originalFileStream ? once(originalFileStream, 'finish') : Promise.resolve();",
              "        encFileWriteStream.end();",
              "        originalFileStream?.end?.();",
              "        stream.destroy();",
              "        await Promise.all([encFinishPromise, originalFinishPromise]);",
              "        logger?.debug('encrypted data successfully');",
            ]
          : [
              "        encFileWriteStream.write(mac);",
              "        encFileWriteStream.end();",
              "        originalFileStream?.end?.();",
              "        stream.destroy();",
              "        logger?.debug('encrypted data successfully');",
            ];
  const dispatcherLines = params?.dispatcherPatched
    ? [
        "                const response = await fetch(url, {",
        "                    method: 'POST',",
        "                    body: stream,",
        "                    headers: {",
        "                        'Content-Type': 'application/octet-stream',",
        "                        Origin: DEFAULT_ORIGIN",
        "                    },",
        "                    // Baileys passes a generic agent here in some runtimes. Undici's",
        "                    // `dispatcher` only works with Dispatcher-compatible implementations,",
        "                    // so only wire it through when the object actually implements",
        "                    // `dispatch`.",
        "                    ...(typeof fetchAgent?.dispatch === 'function' ? { dispatcher: fetchAgent } : {}),",
        "                    duplex: 'half',",
        "                });",
      ]
    : params?.dispatcherHeaderDrifted
      ? [
          "                const response = await fetch(url, {",
          "                    dispatcher: fetchAgent,",
          "                    method: 'POST',",
          "                    body: stream,",
          "                    headers: {",
          "                        Origin: DEFAULT_ORIGIN,",
          "                        'Content-Type': 'application/octet-stream'",
          "                    },",
          "                    duplex: 'half',",
          "                });",
        ]
      : [
          "                const response = await fetch(url, {",
          "                    dispatcher: fetchAgent,",
          "                    method: 'POST',",
          "                    body: stream,",
          "                    headers: {",
          "                        'Content-Type': 'application/octet-stream',",
          "                        Origin: DEFAULT_ORIGIN",
          "                    },",
          "                    duplex: 'half',",
          "                });",
        ];
  return [
    "import { once } from 'events';",
    "const encryptedStream = async () => {",
    ...encryptedLines,
    "};",
    "const upload = async () => {",
    ...dispatcherLines,
    "};",
  ].join("\n");
}

afterEach(() => {
  cleanupTrackedTempDirs(tempDirs);
});

describe("stageBundledPluginRuntimeDeps", () => {
  it("drops Lark SDK type cargo while keeping runtime entrypoints", () => {
    const repoRoot = makeRepoRoot("openclaw-stage-bundled-runtime-deps-");

    writeRepoFile(
      repoRoot,
      "dist/extensions/feishu/package.json",
      JSON.stringify(
        {
          name: "@openclaw/feishu",
          version: "2026.4.10",
          dependencies: {
            "@larksuiteoapi/node-sdk": "^1.60.0",
          },
          openclaw: {
            bundle: {
              stageRuntimeDependencies: true,
            },
          },
        },
        null,
        2,
      ),
    );

    writeRepoFile(
      repoRoot,
      "node_modules/@larksuiteoapi/node-sdk/package.json",
      JSON.stringify(
        {
          name: "@larksuiteoapi/node-sdk",
          version: "1.60.0",
          main: "./lib/index.js",
          module: "./es/index.js",
          types: "./types",
        },
        null,
        2,
      ),
    );
    writeRepoFile(
      repoRoot,
      "node_modules/@larksuiteoapi/node-sdk/lib/index.js",
      "export const runtime = true;\n",
    );
    writeRepoFile(
      repoRoot,
      "node_modules/@larksuiteoapi/node-sdk/es/index.js",
      "export const moduleRuntime = true;\n",
    );
    writeRepoFile(
      repoRoot,
      "node_modules/@larksuiteoapi/node-sdk/types/index.d.ts",
      "export interface HugeTypeSurface {}\n",
    );

    return loadStageBundledPluginRuntimeDeps().then((stageBundledPluginRuntimeDeps) => {
      stageBundledPluginRuntimeDeps({ repoRoot });

      const stagedRoot = path.join(
        repoRoot,
        "dist",
        "extensions",
        "feishu",
        "node_modules",
        "@larksuiteoapi",
        "node-sdk",
      );
      expect(fs.existsSync(path.join(stagedRoot, "lib", "index.js"))).toBe(true);
      expect(fs.existsSync(path.join(stagedRoot, "es", "index.js"))).toBe(true);
      expect(fs.existsSync(path.join(stagedRoot, "types"))).toBe(false);
    });
  });

  it("strips non-runtime dependency sections before temp npm staging", async () => {
    const repoRoot = makeRepoRoot("openclaw-stage-bundled-runtime-manifest-");
    writeRepoFile(
      repoRoot,
      "dist/extensions/amazon-bedrock/package.json",
      JSON.stringify(
        {
          name: "@openclaw/amazon-bedrock-provider",
          version: "2026.4.10",
          dependencies: {
            "@aws-sdk/client-bedrock": "3.1024.0",
          },
          devDependencies: {
            "@openclaw/plugin-sdk": "workspace:*",
          },
          peerDependencies: {
            openclaw: "^0.0.0",
          },
          peerDependenciesMeta: {
            openclaw: {
              optional: true,
            },
          },
          openclaw: {
            bundle: {
              stageRuntimeDependencies: true,
            },
          },
        },
        null,
        2,
      ),
    );

    const stageBundledPluginRuntimeDeps = await loadStageBundledPluginRuntimeDeps();
    const installs: Array<Record<string, unknown>> = [];
    stageBundledPluginRuntimeDeps({
      repoRoot,
      installAttempts: 1,
      installPluginRuntimeDepsImpl(params: { packageJson: Record<string, unknown> }) {
        installs.push(params.packageJson);
      },
    });

    expect(installs).toHaveLength(1);
    expect(installs[0]?.dependencies).toEqual({
      "@aws-sdk/client-bedrock": "3.1024.0",
    });
    expect(installs[0]?.devDependencies).toBeUndefined();
    expect(installs[0]?.peerDependencies).toBeUndefined();
    expect(installs[0]?.peerDependenciesMeta).toBeUndefined();
  });

  it("reuses root-installed runtime deps for nested git spec dependencies", async () => {
    const repoRoot = makeRepoRoot("openclaw-stage-bundled-runtime-git-deps-");
    writeRepoFile(
      repoRoot,
      "dist/extensions/whatsapp/package.json",
      JSON.stringify(
        {
          name: "@openclaw/whatsapp",
          version: "2026.4.14",
          dependencies: {
            "@whiskeysockets/baileys": "7.0.0-rc.9",
          },
          openclaw: {
            bundle: {
              stageRuntimeDependencies: true,
            },
          },
        },
        null,
        2,
      ),
    );
    writeRepoFile(
      repoRoot,
      "node_modules/@whiskeysockets/baileys/package.json",
      JSON.stringify(
        {
          name: "@whiskeysockets/baileys",
          version: "7.0.0-rc.9",
          dependencies: {
            libsignal: "git+https://github.com/whiskeysockets/libsignal-node",
          },
        },
        null,
        2,
      ),
    );
    writeRepoFile(
      repoRoot,
      "node_modules/@whiskeysockets/baileys/lib/index.js",
      "export const baileys = true;\n",
    );
    writeRepoFile(
      repoRoot,
      "node_modules/libsignal/package.json",
      JSON.stringify(
        {
          name: "@whiskeysockets/libsignal-node",
          version: "2.0.1",
        },
        null,
        2,
      ),
    );
    writeRepoFile(repoRoot, "node_modules/libsignal/index.js", "module.exports = {};\n");

    const spawnSyncMock = vi.fn(() => {
      throw new Error("spawnSync should not run when root-installed runtime deps are reusable");
    });
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>(
        "node:child_process",
      );
      return {
        ...actual,
        spawnSync: spawnSyncMock,
      };
    });
    try {
      const stageBundledPluginRuntimeDeps = await loadFreshStageBundledPluginRuntimeDeps(
        "git-deps-fast-path",
      );
      stageBundledPluginRuntimeDeps({ repoRoot });
    } finally {
      vi.doUnmock("node:child_process");
    }

    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(
      fs.existsSync(
        path.join(
          repoRoot,
          "dist",
          "extensions",
          "whatsapp",
          "node_modules",
          "@whiskeysockets",
          "baileys",
          "lib",
          "index.js",
        ),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(
          repoRoot,
          "dist",
          "extensions",
          "whatsapp",
          "node_modules",
          "libsignal",
          "index.js",
        ),
      ),
    ).toBe(true);
  });

  it("reuses hoisted nested runtime deps even when semver ranges drift", async () => {
    const repoRoot = makeRepoRoot("openclaw-stage-bundled-runtime-hoisted-deps-");
    writeRepoFile(
      repoRoot,
      "dist/extensions/whatsapp/package.json",
      JSON.stringify(
        {
          name: "@openclaw/whatsapp",
          version: "2026.4.14",
          dependencies: {
            "music-metadata": "11.12.3",
          },
          openclaw: {
            bundle: {
              stageRuntimeDependencies: true,
            },
          },
        },
        null,
        2,
      ),
    );
    writeRepoFile(
      repoRoot,
      "node_modules/music-metadata/package.json",
      JSON.stringify(
        {
          name: "music-metadata",
          version: "11.12.3",
          dependencies: {
            "file-type": "^21.3.1",
          },
        },
        null,
        2,
      ),
    );
    writeRepoFile(repoRoot, "node_modules/music-metadata/lib/index.js", "export const mm = true;\n");
    writeRepoFile(
      repoRoot,
      "node_modules/file-type/package.json",
      JSON.stringify(
        {
          name: "file-type",
          version: "22.0.1",
        },
        null,
        2,
      ),
    );
    writeRepoFile(repoRoot, "node_modules/file-type/index.js", "export const ft = true;\n");

    const spawnSyncMock = vi.fn(() => {
      throw new Error("spawnSync should not run when the hoisted root closure is reusable");
    });
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>(
        "node:child_process",
      );
      return {
        ...actual,
        spawnSync: spawnSyncMock,
      };
    });
    try {
      const stageBundledPluginRuntimeDeps = await loadFreshStageBundledPluginRuntimeDeps(
        "hoisted-semver-drift",
      );
      stageBundledPluginRuntimeDeps({ repoRoot });
    } finally {
      vi.doUnmock("node:child_process");
    }

    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(
      fs.existsSync(
        path.join(
          repoRoot,
          "dist",
          "extensions",
          "whatsapp",
          "node_modules",
          "music-metadata",
          "lib",
          "index.js",
        ),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(
          repoRoot,
          "dist",
          "extensions",
          "whatsapp",
          "node_modules",
          "file-type",
          "index.js",
        ),
      ),
    ).toBe(true);
  });

  it("patches installed Baileys encryptedStream flush ordering for shipped runtime deps", async () => {
    const repoRoot = makeRepoRoot("openclaw-stage-bundled-runtime-hotfix-");
    const targetPath = path.join(
      repoRoot,
      "node_modules",
      "@whiskeysockets",
      "baileys",
      "lib",
      "Utils",
      "messages-media.js",
    );
    writeRepoFile(
      repoRoot,
      "node_modules/@whiskeysockets/baileys/lib/Utils/messages-media.js",
      createBaileysMessagesMediaSource(),
    );

    const { applyBaileysEncryptedStreamFinishHotfix } = await loadPostinstallBundledPluginsModule();
    const result = applyBaileysEncryptedStreamFinishHotfix({ packageRoot: repoRoot });

    expect(result).toEqual({
      applied: true,
      reason: "patched",
      targetPath,
    });
    expect(fs.readFileSync(targetPath, "utf8")).toContain(
      "const encFinishPromise = once(encFileWriteStream, 'finish');",
    );
    expect(fs.readFileSync(targetPath, "utf8")).toContain(
      "await Promise.all([encFinishPromise, originalFinishPromise]);",
    );
    expect(fs.readFileSync(targetPath, "utf8")).toContain(
      "...(typeof fetchAgent?.dispatch === 'function' ? { dispatcher: fetchAgent } : {}),",
    );
    expect(fs.readFileSync(targetPath, "utf8")).not.toContain("dispatcher: fetchAgent,");
  });

  it("patches the Baileys dispatcher guard when the flush hotfix is already present", async () => {
    const repoRoot = makeRepoRoot("openclaw-stage-bundled-runtime-hotfix-dispatcher-");
    const targetPath = path.join(
      repoRoot,
      "node_modules",
      "@whiskeysockets",
      "baileys",
      "lib",
      "Utils",
      "messages-media.js",
    );
    writeRepoFile(
      repoRoot,
      "node_modules/@whiskeysockets/baileys/lib/Utils/messages-media.js",
      createBaileysMessagesMediaSource({ encryptedStreamPatched: true }),
    );

    const { applyBaileysEncryptedStreamFinishHotfix } = await loadPostinstallBundledPluginsModule();
    const result = applyBaileysEncryptedStreamFinishHotfix({ packageRoot: repoRoot });

    expect(result).toEqual({
      applied: true,
      reason: "patched",
      targetPath,
    });
    expect(fs.readFileSync(targetPath, "utf8")).toContain(
      "await Promise.all([encFinishPromise, originalFinishPromise]);",
    );
    expect(fs.readFileSync(targetPath, "utf8")).toContain(
      "...(typeof fetchAgent?.dispatch === 'function' ? { dispatcher: fetchAgent } : {}),",
    );
  });

  it("patches the Baileys dispatcher guard even when the encryptedStream block changed", async () => {
    const repoRoot = makeRepoRoot("openclaw-stage-bundled-runtime-hotfix-dispatcher-only-");
    const targetPath = path.join(
      repoRoot,
      "node_modules",
      "@whiskeysockets",
      "baileys",
      "lib",
      "Utils",
      "messages-media.js",
    );
    writeRepoFile(
      repoRoot,
      "node_modules/@whiskeysockets/baileys/lib/Utils/messages-media.js",
      createBaileysMessagesMediaSource({ encryptedStreamUnrecognized: true }),
    );

    const { applyBaileysEncryptedStreamFinishHotfix } = await loadPostinstallBundledPluginsModule();
    const result = applyBaileysEncryptedStreamFinishHotfix({ packageRoot: repoRoot });

    expect(result).toEqual({
      applied: true,
      reason: "patched",
      targetPath,
    });
    expect(fs.readFileSync(targetPath, "utf8")).toContain(
      "logger?.debug('encrypted data changed upstream');",
    );
    expect(fs.readFileSync(targetPath, "utf8")).toContain(
      "...(typeof fetchAgent?.dispatch === 'function' ? { dispatcher: fetchAgent } : {}),",
    );
  });

  it("fails when the dispatcher block drifts even if encryptedStream is patchable", async () => {
    const repoRoot = makeRepoRoot("openclaw-stage-bundled-runtime-hotfix-dispatcher-drifted-");
    const targetPath = path.join(
      repoRoot,
      "node_modules",
      "@whiskeysockets",
      "baileys",
      "lib",
      "Utils",
      "messages-media.js",
    );
    writeRepoFile(
      repoRoot,
      "node_modules/@whiskeysockets/baileys/lib/Utils/messages-media.js",
      createBaileysMessagesMediaSource({ dispatcherHeaderDrifted: true }),
    );

    const originalText = fs.readFileSync(targetPath, "utf8");
    const { applyBaileysEncryptedStreamFinishHotfix } = await loadPostinstallBundledPluginsModule();
    const result = applyBaileysEncryptedStreamFinishHotfix({ packageRoot: repoRoot });

    expect(result).toEqual({
      applied: false,
      reason: "unexpected_content",
      targetPath,
    });
    expect(fs.readFileSync(targetPath, "utf8")).toBe(originalText);
  });

  it("patches the Baileys dispatcher guard when sequential awaits include comments", async () => {
    const repoRoot = makeRepoRoot(
      "openclaw-stage-bundled-runtime-hotfix-dispatcher-sequential-comments-",
    );
    const targetPath = path.join(
      repoRoot,
      "node_modules",
      "@whiskeysockets",
      "baileys",
      "lib",
      "Utils",
      "messages-media.js",
    );
    writeRepoFile(
      repoRoot,
      "node_modules/@whiskeysockets/baileys/lib/Utils/messages-media.js",
      createBaileysMessagesMediaSource({ encryptedStreamPatchedSequentiallyWithComments: true }),
    );

    const { applyBaileysEncryptedStreamFinishHotfix } = await loadPostinstallBundledPluginsModule();
    const result = applyBaileysEncryptedStreamFinishHotfix({ packageRoot: repoRoot });

    expect(result).toEqual({
      applied: true,
      reason: "patched",
      targetPath,
    });
    expect(fs.readFileSync(targetPath, "utf8")).toContain(
      "...(typeof fetchAgent?.dispatch === 'function' ? { dispatcher: fetchAgent } : {}),",
    );
    expect(fs.readFileSync(targetPath, "utf8")).toContain("await encFinishPromise;");
    expect(fs.readFileSync(targetPath, "utf8")).toContain("await originalFinishPromise;");
  });

  it("patches the Baileys dispatcher guard when the flush hotfix uses sequential awaits", async () => {
    const repoRoot = makeRepoRoot("openclaw-stage-bundled-runtime-hotfix-dispatcher-sequential-");
    const targetPath = path.join(
      repoRoot,
      "node_modules",
      "@whiskeysockets",
      "baileys",
      "lib",
      "Utils",
      "messages-media.js",
    );
    writeRepoFile(
      repoRoot,
      "node_modules/@whiskeysockets/baileys/lib/Utils/messages-media.js",
      createBaileysMessagesMediaSource({ encryptedStreamPatchedSequentially: true }),
    );

    const { applyBaileysEncryptedStreamFinishHotfix } = await loadPostinstallBundledPluginsModule();
    const result = applyBaileysEncryptedStreamFinishHotfix({ packageRoot: repoRoot });

    expect(result).toEqual({
      applied: true,
      reason: "patched",
      targetPath,
    });
    expect(fs.readFileSync(targetPath, "utf8")).toContain("await encFinishPromise;");
    expect(fs.readFileSync(targetPath, "utf8")).toContain("await originalFinishPromise;");
    expect(fs.readFileSync(targetPath, "utf8")).toContain(
      "...(typeof fetchAgent?.dispatch === 'function' ? { dispatcher: fetchAgent } : {}),",
    );
  });

  it("preserves the original module read mode when replacing Baileys", async () => {
    const repoRoot = makeRepoRoot("openclaw-stage-bundled-runtime-hotfix-mode-");
    const targetPath = path.join(
      repoRoot,
      "node_modules",
      "@whiskeysockets",
      "baileys",
      "lib",
      "Utils",
      "messages-media.js",
    );
    writeRepoFile(
      repoRoot,
      "node_modules/@whiskeysockets/baileys/lib/Utils/messages-media.js",
      createBaileysMessagesMediaSource(),
    );
    fs.chmodSync(targetPath, 0o644);

    const { applyBaileysEncryptedStreamFinishHotfix } = await loadPostinstallBundledPluginsModule();
    const result = applyBaileysEncryptedStreamFinishHotfix({ packageRoot: repoRoot });

    expect(result).toEqual({
      applied: true,
      reason: "patched",
      targetPath,
    });
    expect(fs.statSync(targetPath).mode & 0o777).toBe(0o644);
  });

  it("refuses symlink targets for the Baileys hotfix", async () => {
    const repoRoot = makeRepoRoot("openclaw-stage-bundled-runtime-hotfix-symlink-");
    const targetPath = path.join(
      repoRoot,
      "node_modules",
      "@whiskeysockets",
      "baileys",
      "lib",
      "Utils",
      "messages-media.js",
    );
    const redirectedTarget = path.join(repoRoot, "redirected-messages-media.js");
    writeRepoFile(repoRoot, "redirected-messages-media.js", "const untouched = true;\n");
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.symlinkSync(redirectedTarget, targetPath);

    const { applyBaileysEncryptedStreamFinishHotfix } = await loadPostinstallBundledPluginsModule();
    const result = applyBaileysEncryptedStreamFinishHotfix({ packageRoot: repoRoot });

    expect(result).toEqual({
      applied: false,
      reason: "unsafe_target",
      targetPath,
    });
    expect(fs.readFileSync(redirectedTarget, "utf8")).toBe("const untouched = true;\n");
  });

  it("downgrades Baileys hotfix write failures to a non-fatal result", async () => {
    const repoRoot = makeRepoRoot("openclaw-stage-bundled-runtime-hotfix-write-failure-");
    const targetPath = path.join(
      repoRoot,
      "node_modules",
      "@whiskeysockets",
      "baileys",
      "lib",
      "Utils",
      "messages-media.js",
    );
    writeRepoFile(
      repoRoot,
      "node_modules/@whiskeysockets/baileys/lib/Utils/messages-media.js",
      createBaileysMessagesMediaSource(),
    );

    const { applyBaileysEncryptedStreamFinishHotfix } = await loadPostinstallBundledPluginsModule();
    const result = applyBaileysEncryptedStreamFinishHotfix({
      packageRoot: repoRoot,
      writeFileSync() {
        throw new Error("read-only filesystem");
      },
    });

    expect(result).toEqual({
      applied: false,
      reason: "error",
      targetPath,
      error: "read-only filesystem",
    });
    expect(fs.readFileSync(targetPath, "utf8")).toContain("dispatcher: fetchAgent,");
  });

  it("refuses pre-created symlink temp paths instead of following them", async () => {
    const repoRoot = makeRepoRoot("openclaw-stage-bundled-runtime-hotfix-temp-symlink-");
    const targetPath = path.join(
      repoRoot,
      "node_modules",
      "@whiskeysockets",
      "baileys",
      "lib",
      "Utils",
      "messages-media.js",
    );
    const redirectedTarget = path.join(repoRoot, "redirected-temp-target.js");
    const attackerTempPath = path.join(
      path.dirname(targetPath),
      ".messages-media.js.attacker-temp",
    );
    writeRepoFile(
      repoRoot,
      "node_modules/@whiskeysockets/baileys/lib/Utils/messages-media.js",
      createBaileysMessagesMediaSource(),
    );
    writeRepoFile(repoRoot, "redirected-temp-target.js", "const untouched = true;\n");
    fs.symlinkSync(redirectedTarget, attackerTempPath);

    const { applyBaileysEncryptedStreamFinishHotfix } = await loadPostinstallBundledPluginsModule();
    const result = applyBaileysEncryptedStreamFinishHotfix({
      packageRoot: repoRoot,
      createTempPath() {
        return attackerTempPath;
      },
    });

    expect(result.applied).toBe(false);
    expect(result.reason).toBe("error");
    expect(result.error).toContain("EEXIST");
    expect(fs.readFileSync(redirectedTarget, "utf8")).toBe("const untouched = true;\n");
    expect(fs.readFileSync(targetPath, "utf8")).toContain("dispatcher: fetchAgent,");
  });
});

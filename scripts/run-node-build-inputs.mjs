import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  BUNDLED_PLUGIN_PATH_PREFIX,
  BUNDLED_PLUGIN_ROOT_DIR,
} from "./lib/bundled-plugin-paths.mjs";

const extensionSourceFilePattern = /\.(?:[cm]?[jt]sx?)$/;
const ignoredRunNodeRepoPaths = new Set([
  "src/canvas-host/a2ui/.bundle.hash",
  "src/canvas-host/a2ui/a2ui.bundle.js",
]);
const defaultRunNodeSourceRoots = ["src", BUNDLED_PLUGIN_ROOT_DIR];
const defaultRunNodeConfigFiles = ["tsconfig.json", "package.json", "tsdown.config.ts"];
const prunedFingerprintDirNames = new Set([
  ".artifacts",
  ".cache",
  ".git",
  ".turbo",
  ".vite",
  "coverage",
  "dist",
  "dist-runtime",
  "node_modules",
]);

const normalizePath = (filePath) => String(filePath ?? "").replaceAll("\\", "/");

const isIgnoredSourcePath = (relativePath) => {
  const normalizedPath = normalizePath(relativePath);
  return (
    normalizedPath.endsWith(".test.ts") ||
    normalizedPath.endsWith(".test.tsx") ||
    normalizedPath.endsWith("test-helpers.ts")
  );
};

const isBuildRelevantSourcePath = (relativePath) => {
  const normalizedPath = normalizePath(relativePath);
  return extensionSourceFilePattern.test(normalizedPath) && !isIgnoredSourcePath(normalizedPath);
};

const extensionRestartMetadataFiles = new Set(["openclaw.plugin.json", "package.json"]);

const isRestartRelevantExtensionPath = (relativePath) => {
  const normalizedPath = normalizePath(relativePath);
  if (extensionRestartMetadataFiles.has(path.posix.basename(normalizedPath))) {
    return true;
  }
  return isBuildRelevantSourcePath(normalizedPath);
};

const isRelevantRunNodePath = (repoPath, isRelevantBundledPluginPath) => {
  const normalizedPath = normalizePath(repoPath).replace(/^\.\/+/, "");
  if (ignoredRunNodeRepoPaths.has(normalizedPath)) {
    return false;
  }
  if (defaultRunNodeConfigFiles.includes(normalizedPath)) {
    return true;
  }
  if (normalizedPath.startsWith("src/")) {
    return !isIgnoredSourcePath(normalizedPath.slice("src/".length));
  }
  if (normalizedPath.startsWith(BUNDLED_PLUGIN_PATH_PREFIX)) {
    return isRelevantBundledPluginPath(normalizedPath.slice(BUNDLED_PLUGIN_PATH_PREFIX.length));
  }
  return false;
};

export const isBuildRelevantRunNodePath = (repoPath) =>
  isRelevantRunNodePath(repoPath, isBuildRelevantSourcePath);

export const isRestartRelevantRunNodePath = (repoPath) =>
  isRelevantRunNodePath(repoPath, isRestartRelevantExtensionPath);

const stat = (filePath, fsImpl) => {
  try {
    return fsImpl.statSync(filePath);
  } catch {
    return null;
  }
};

const lstat = (filePath, fsImpl) => {
  try {
    return fsImpl.lstatSync(filePath);
  } catch {
    return null;
  }
};

function collectFingerprintFiles(rootPath, cwd, fsImpl, out) {
  const rootStat = lstat(rootPath, fsImpl);
  if (!rootStat) {
    return;
  }
  if (rootStat.isSymbolicLink()) {
    return;
  }
  if (rootStat.isFile()) {
    const repoPath = normalizePath(path.relative(cwd, rootPath));
    if (isBuildRelevantRunNodePath(repoPath)) {
      out.push({ absolutePath: rootPath, repoPath });
    }
    return;
  }
  if (!rootStat.isDirectory()) {
    return;
  }
  const entries = fsImpl.readdirSync(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    if (
      entry.name === ".DS_Store" ||
      entry.isSymbolicLink() ||
      (entry.isDirectory() && prunedFingerprintDirNames.has(entry.name))
    ) {
      continue;
    }
    collectFingerprintFiles(path.join(rootPath, entry.name), cwd, fsImpl, out);
  }
}

export function resolveRunNodeBuildInputFingerprint(params = {}) {
  const cwd = params.cwd ?? process.cwd();
  const fsImpl = params.fs ?? fs;
  const sourceRoots =
    params.sourceRoots ??
    defaultRunNodeSourceRoots.map((sourceRoot) => ({
      name: sourceRoot,
      path: path.join(cwd, sourceRoot),
    }));
  const configFiles =
    params.configFiles ?? defaultRunNodeConfigFiles.map((filePath) => path.join(cwd, filePath));
  const files = [];

  for (const configFile of configFiles) {
    const configStat = stat(configFile, fsImpl);
    if (!configStat?.isFile()) {
      continue;
    }
    const repoPath = normalizePath(path.relative(cwd, configFile));
    if (isBuildRelevantRunNodePath(repoPath)) {
      files.push({ absolutePath: configFile, repoPath });
    }
  }

  for (const sourceRoot of sourceRoots) {
    collectFingerprintFiles(sourceRoot.path, cwd, fsImpl, files);
  }

  const uniqueFiles = Array.from(
    new Map(files.map((file) => [file.repoPath, file])).values(),
  ).toSorted((left, right) => left.repoPath.localeCompare(right.repoPath));

  if (uniqueFiles.length === 0) {
    return null;
  }

  const hash = createHash("sha256");
  hash.update("run-node-build-inputs:v1\0");
  for (const file of uniqueFiles) {
    hash.update(file.repoPath);
    hash.update("\0");
    hash.update(fsImpl.readFileSync(file.absolutePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

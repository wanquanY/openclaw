import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function normalizePackageRuntimeEntry(entry) {
  return String(entry || "").replace(/^\.\//u, "");
}

function listDeclaredRuntimeEntries(packageJson) {
  const openclaw = packageJson?.openclaw;
  if (!openclaw) {
    return [];
  }
  const extensions = Array.isArray(openclaw.extensions)
    ? openclaw.extensions.filter((entry) => typeof entry === "string" && entry.trim().length > 0)
    : [];
  const setupEntry =
    typeof openclaw.setupEntry === "string" && openclaw.setupEntry.trim().length > 0
      ? [openclaw.setupEntry]
      : [];
  return Array.from(new Set([...extensions, ...setupEntry].map(normalizePackageRuntimeEntry)));
}

function validatePluginTree(rootDir, label) {
  const failures = [];
  if (!fs.existsSync(rootDir)) {
    return failures;
  }

  for (const dirent of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) {
      continue;
    }
    const pluginDir = path.join(rootDir, dirent.name);
    const packageJsonPath = path.join(pluginDir, "package.json");
    if (!fs.existsSync(packageJsonPath)) {
      continue;
    }
    const packageJson = readJson(packageJsonPath);
    const declaredEntries = listDeclaredRuntimeEntries(packageJson);
    for (const relativeEntry of declaredEntries) {
      const entryPath = path.join(pluginDir, relativeEntry);
      if (fs.existsSync(entryPath) && fs.statSync(entryPath).isFile()) {
        continue;
      }
      failures.push(`${label}/${dirent.name}: missing declared runtime entry ${relativeEntry}`);
    }
  }

  return failures;
}

export function checkBundledPluginRuntimeIntegrity(params = {}) {
  const repoRoot = params.cwd ?? params.repoRoot ?? process.cwd();
  const failures = [
    ...validatePluginTree(path.join(repoRoot, "dist", "extensions"), "dist/extensions"),
    ...validatePluginTree(
      path.join(repoRoot, "dist-runtime", "extensions"),
      "dist-runtime/extensions",
    ),
  ];

  if (failures.length > 0) {
    throw new Error(
      `bundled plugin runtime integrity check failed:\n${failures.map((line) => `- ${line}`).join("\n")}`,
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    checkBundledPluginRuntimeIntegrity();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }
}

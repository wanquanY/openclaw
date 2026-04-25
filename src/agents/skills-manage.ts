import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveExistingInstallPath, withExtractedArchiveRoot } from "../infra/install-flow.js";
import { installFromValidatedNpmSpecArchive } from "../infra/install-from-npm-spec.js";
import { installPackageDirWithManifestDeps } from "../infra/install-package-dir.js";
import { resolveSafeInstallDir } from "../infra/install-safe-path.js";
import { scanSkillInstallSource } from "../plugins/install-security-scan.js";
import { resolveUserPath } from "../utils.js";
import {
  readClawHubSkillOrigin,
  readClawHubSkillsLockfile,
  writeClawHubSkillsLockfile,
} from "./skills-clawhub.js";
import { loadWorkspaceSkillEntries } from "./skills.js";
import { resolveSkillKey } from "./skills/frontmatter.js";
import { loadSkillsFromDirSafe } from "./skills/local-loader.js";

const OPENCLAW_SKILL_ORIGIN_RELATIVE_PATH = path.join(".openclaw", "origin.json");
const CLAWHUB_SKILL_ORIGIN_RELATIVE_PATHS = [
  path.join(".clawhub", "origin.json"),
  path.join(".clawdhub", "origin.json"),
];

type Logger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

export type ManagedWorkspaceSkillOrigin = {
  version: 1;
  source: "file" | "remote-npm";
  installedAt: number;
  requestedSpecifier?: string;
  registry?: string;
};

export type ManagedWorkspaceSkillLifecycle =
  | {
      source: "clawhub";
    }
  | ManagedWorkspaceSkillOrigin;

export type WorkspaceSkillImportResult =
  | {
      ok: true;
      skillName: string;
      skillKey: string;
      description?: string;
      message: string;
      warnings: string[];
      installedPath: string;
      npmResolution?: Record<string, unknown>;
      integrityDrift?: Record<string, unknown>;
    }
  | {
      ok: false;
      message: string;
      warnings: string[];
    };

export type WorkspaceSkillUninstallResult =
  | {
      ok: true;
      skillKey: string;
      skillName: string;
      removedPath: string;
    }
  | {
      ok: false;
      message: string;
    };

function readJsonFileSync<TValue>(filePath: string): TValue | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as TValue;
  } catch {
    return null;
  }
}

export function detectManagedWorkspaceSkillLifecycleSync(
  skillDir: string,
): ManagedWorkspaceSkillLifecycle | null {
  const localOrigin = readJsonFileSync<ManagedWorkspaceSkillOrigin>(
    path.join(skillDir, OPENCLAW_SKILL_ORIGIN_RELATIVE_PATH),
  );
  if (
    localOrigin?.version === 1 &&
    (localOrigin.source === "file" || localOrigin.source === "remote-npm") &&
    typeof localOrigin.installedAt === "number"
  ) {
    return localOrigin;
  }
  for (const relativePath of CLAWHUB_SKILL_ORIGIN_RELATIVE_PATHS) {
    const fullPath = path.join(skillDir, relativePath);
    if (fs.existsSync(fullPath)) {
      return {
        source: "clawhub",
      };
    }
  }
  return null;
}

async function writeManagedWorkspaceSkillOrigin(
  skillDir: string,
  origin: ManagedWorkspaceSkillOrigin,
): Promise<void> {
  const targetPath = path.join(skillDir, OPENCLAW_SKILL_ORIGIN_RELATIVE_PATH);
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  await fsp.writeFile(targetPath, `${JSON.stringify(origin, null, 2)}\n`, "utf8");
}

function resolveWorkspaceSkillsDir(workspaceDir: string): string {
  return path.join(resolveUserPath(workspaceDir), "skills");
}

async function readManifestDependencies(sourceDir: string): Promise<Record<string, unknown>> {
  try {
    const manifest = JSON.parse(
      await fsp.readFile(path.join(sourceDir, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    const dependencies = manifest.dependencies;
    const optionalDependencies = manifest.optionalDependencies;
    const peerDependencies = manifest.peerDependencies;
    return {
      ...(dependencies && typeof dependencies === "object" ? dependencies : {}),
      ...(optionalDependencies && typeof optionalDependencies === "object"
        ? optionalDependencies
        : {}),
      ...(peerDependencies && typeof peerDependencies === "object" ? peerDependencies : {}),
    };
  } catch {
    return {};
  }
}

async function resolveImportableSkillFromSourceDir(sourceDir: string): Promise<
  | {
      ok: true;
      skillName: string;
      skillKey: string;
      description?: string;
      sourceDir: string;
    }
  | {
      ok: false;
      message: string;
    }
> {
  const loaded = loadSkillsFromDirSafe({
    dir: sourceDir,
    source: "openclaw-import",
  }).skills;
  if (loaded.length !== 1) {
    return {
      ok: false,
      message:
        loaded.length === 0
          ? "archive is missing a valid SKILL.md root"
          : "archive must contain exactly one importable skill root",
    };
  }
  const skillName = loaded[0].name.trim();
  return {
    ok: true,
    skillName,
    skillKey: skillName,
    description: loaded[0].description?.trim() || undefined,
    sourceDir: loaded[0].baseDir,
  };
}

async function installWorkspaceSkillFromResolvedSource(params: {
  sourceDir: string;
  workspaceDir: string;
  force?: boolean;
  timeoutMs?: number;
  logger?: Logger;
  origin: ManagedWorkspaceSkillOrigin;
}): Promise<WorkspaceSkillImportResult> {
  const warnings: string[] = [];
  const resolved = await resolveImportableSkillFromSourceDir(params.sourceDir);
  if (!resolved.ok) {
    return {
      ok: false,
      message: resolved.message,
      warnings,
    };
  }

  const scanResult = await scanSkillInstallSource({
    installId: `import:${params.origin.source}`,
    logger: {
      warn: (message) => warnings.push(message),
    },
    origin: `openclaw-${params.origin.source}`,
    skillName: resolved.skillName,
    sourceDir: path.resolve(resolved.sourceDir),
  });
  if (scanResult?.blocked) {
    return {
      ok: false,
      message: scanResult.blocked.reason,
      warnings,
    };
  }

  const skillsDir = resolveWorkspaceSkillsDir(params.workspaceDir);
  await fsp.mkdir(skillsDir, { recursive: true });
  const installTarget = resolveSafeInstallDir({
    baseDir: skillsDir,
    id: resolved.skillKey,
    invalidNameMessage: "invalid skill target path",
  });
  if (!installTarget.ok) {
    return {
      ok: false,
      message: installTarget.error,
      warnings,
    };
  }

  const targetDir = installTarget.path;
  const targetExists = await fsp
    .stat(targetDir)
    .then((stat) => stat.isDirectory())
    .catch(() => false);
  if (targetExists && !params.force) {
    return {
      ok: false,
      message: `Skill "${resolved.skillKey}" already exists in this workspace. Re-run with force to replace it.`,
      warnings,
    };
  }

  const installResult = await installPackageDirWithManifestDeps({
    sourceDir: resolved.sourceDir,
    targetDir,
    mode: targetExists ? "update" : "install",
    timeoutMs: Math.min(Math.max(params.timeoutMs ?? 300_000, 1_000), 900_000),
    logger: params.logger,
    copyErrorPrefix: "failed to install skill",
    depsLogMessage: "Installing skill dependencies…",
    manifestDependencies: await readManifestDependencies(resolved.sourceDir),
  });
  if (!installResult.ok) {
    return {
      ok: false,
      message: installResult.error,
      warnings,
    };
  }

  await writeManagedWorkspaceSkillOrigin(targetDir, params.origin);
  return {
    ok: true,
    skillName: resolved.skillName,
    skillKey: resolved.skillKey,
    description: resolved.description,
    message: `Installed ${resolved.skillName}`,
    warnings,
    installedPath: targetDir,
  };
}

export async function installWorkspaceSkillFromArchive(params: {
  archivePath: string;
  workspaceDir: string;
  force?: boolean;
  timeoutMs?: number;
  logger?: Logger;
  requestedSpecifier?: string;
}): Promise<WorkspaceSkillImportResult> {
  const pathResult = await resolveExistingInstallPath(params.archivePath);
  if (!pathResult.ok) {
    return {
      ok: false,
      message: pathResult.error,
      warnings: [],
    };
  }
  if (!pathResult.stat.isFile()) {
    return {
      ok: false,
      message: `not a file: ${pathResult.resolvedPath}`,
      warnings: [],
    };
  }

  const result = await withExtractedArchiveRoot({
    archivePath: pathResult.resolvedPath,
    tempDirPrefix: "openclaw-skill-",
    timeoutMs: Math.min(Math.max(params.timeoutMs ?? 120_000, 1_000), 900_000),
    logger: params.logger,
    rootMarkers: ["SKILL.md"],
    onExtracted: async (rootDir) =>
      await installWorkspaceSkillFromResolvedSource({
        sourceDir: rootDir,
        workspaceDir: params.workspaceDir,
        force: params.force,
        timeoutMs: params.timeoutMs,
        logger: params.logger,
        origin: {
          version: 1,
          source: "file",
          installedAt: Date.now(),
          ...(params.requestedSpecifier ? { requestedSpecifier: params.requestedSpecifier } : {}),
        },
      }),
  });
  if ("warnings" in result) {
    return result;
  }
  return {
    ok: false,
    message: result.error,
    warnings: [],
  };
}

export async function installWorkspaceSkillFromNpmSpec(params: {
  spec: string;
  workspaceDir: string;
  registry?: string;
  force?: boolean;
  timeoutMs?: number;
  logger?: Logger;
}): Promise<WorkspaceSkillImportResult> {
  const result = await installFromValidatedNpmSpecArchive({
    spec: params.spec,
    timeoutMs: Math.min(Math.max(params.timeoutMs ?? 120_000, 1_000), 900_000),
    tempDirPrefix: "openclaw-skill-pack-",
    warn: (message) => params.logger?.warn?.(message),
    archiveInstallParams: {},
    installFromArchive: async ({ archivePath }) => {
      const installResult = await withExtractedArchiveRoot({
        archivePath,
        tempDirPrefix: "openclaw-skill-pack-extract-",
        timeoutMs: Math.min(Math.max(params.timeoutMs ?? 120_000, 1_000), 900_000),
        logger: params.logger,
        rootMarkers: ["SKILL.md"],
        onExtracted: async (rootDir) =>
          await installWorkspaceSkillFromResolvedSource({
            sourceDir: rootDir,
            workspaceDir: params.workspaceDir,
            force: params.force,
            timeoutMs: params.timeoutMs,
            logger: params.logger,
            origin: {
              version: 1,
              source: "remote-npm",
              installedAt: Date.now(),
              requestedSpecifier: params.spec,
              ...(params.registry ? { registry: params.registry } : {}),
            },
          }),
      });
      if ("warnings" in installResult) {
        return installResult;
      }
      return {
        ok: false,
        message: installResult.error,
        warnings: [],
      } satisfies WorkspaceSkillImportResult;
    },
  });
  if (result.ok) {
    return result;
  }
  if ("message" in result) {
    return result;
  }
  return {
    ok: false,
    message: result.error,
    warnings: [],
  };
}

export async function uninstallWorkspaceSkill(params: {
  workspaceDir: string;
  skillKey: string;
  config?: OpenClawConfig;
  agentId?: string;
}): Promise<WorkspaceSkillUninstallResult> {
  const workspaceDir = resolveUserPath(params.workspaceDir);
  const workspaceSkillsDir = resolveWorkspaceSkillsDir(workspaceDir);
  const entries = loadWorkspaceSkillEntries(workspaceDir, {
    config: params.config,
    agentId: params.agentId,
  });
  const matched = entries.find((entry) => {
    const entrySkillKey = resolveSkillKey(entry.skill, entry).trim();
    return entrySkillKey === params.skillKey || entry.skill.name.trim() === params.skillKey;
  });
  if (!matched) {
    return {
      ok: false,
      message: `Skill not found: ${params.skillKey}`,
    };
  }

  const skillDir = path.resolve(matched.skill.baseDir);
  const relativePath = path.relative(workspaceSkillsDir, skillDir);
  const insideWorkspaceSkills =
    relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath);
  const lifecycle = detectManagedWorkspaceSkillLifecycleSync(skillDir);
  if (!insideWorkspaceSkills || !lifecycle) {
    return {
      ok: false,
      message:
        "Only workspace-installed skills can be removed here. Project-authored or shared skills must be removed manually.",
    };
  }

  if (lifecycle.source === "clawhub") {
    const clawHubOrigin = await readClawHubSkillOrigin(skillDir);
    if (clawHubOrigin?.slug) {
      const lock = await readClawHubSkillsLockfile(workspaceDir);
      if (lock.skills[clawHubOrigin.slug]) {
        delete lock.skills[clawHubOrigin.slug];
        await writeClawHubSkillsLockfile(workspaceDir, lock);
      }
    }
  }

  await fsp.rm(skillDir, { recursive: true, force: true });
  return {
    ok: true,
    skillKey: resolveSkillKey(matched.skill, matched),
    skillName: matched.skill.name,
    removedPath: skillDir,
  };
}

export function formatWorkspaceSkillImportError(error: unknown): WorkspaceSkillImportResult {
  return {
    ok: false,
    message: formatErrorMessage(error),
    warnings: [],
  };
}

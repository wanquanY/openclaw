import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadSessionStore, type SessionEntry } from "../config/sessions.js";
import type {
  SessionFileAction,
  SessionFileKind,
  SessionFileRecord,
  SessionsFilesListParams,
  SessionsFilesListResult,
  SessionsFilesTrackParams,
  SessionsFilesTrackResult,
} from "./protocol/index.js";
import {
  loadCombinedSessionStoreForGateway,
  resolveGatewaySessionStoreTarget,
  resolveSessionTranscriptCandidates,
} from "./session-utils.js";

const TOOL_CALL_TYPES = new Set(["toolcall", "tool_call", "tooluse", "tool_use"]);
const TOOL_RESULT_ROLES = new Set(["tool", "toolresult", "tool_result"]);
const SESSION_FILES_MAX_SCAN_ENTRIES = 200_000;
const SESSION_FILES_FALLBACK_WINDOW_MS = 2 * 60 * 60 * 1000;
const SESSION_FILES_SCAN_START_GRACE_MS = 60_000;
const SESSION_FILES_SCAN_END_GRACE_MS = 5 * 60 * 1000;
const SESSION_FILES_EXEC_PROMOTE_BEFORE_MS = 10 * 60 * 1000;
const SESSION_FILES_EXEC_PROMOTE_AFTER_MS = 2 * 60 * 1000;
const SESSION_FILES_IGNORED_DIRS = new Set([
  ".git",
  ".openclaw",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
]);
const SESSION_FILES_IGNORED_FILE_NAMES = new Set([".DS_Store"]);
const APPLY_PATCH_ADD_PREFIX = "*** Add File:";
const APPLY_PATCH_UPDATE_PREFIX = "*** Update File:";
const APPLY_PATCH_DELETE_PREFIX = "*** Delete File:";
const APPLY_PATCH_MOVE_PREFIX = "*** Move to:";
const APPLY_PATCH_SUMMARY_RE = /^\s*([AMD])\s+(.+?)\s*$/;
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/;
const COMMAND_PATH_EXT_RE =
  /\.(xlsx|xls|csv|json|txt|md|markdown|yaml|yml|toml|ini|xml|pdf|docx?|pptx?|png|jpe?g|gif|webp|svg|py|js|jsx|ts|tsx|sh|sql|html|css)$/i;
const ACTION_ORDER: SessionFileAction[] = ["created", "updated", "deleted", "read", "referenced"];
const SESSION_FILES_MUTATION_LOG_VERSION = 1;
const SESSION_FILES_MUTATION_LOG_MAX_EVENTS = 4_000;
const SESSION_FILES_MAX_SCOPED_SESSIONS = 200;

type SessionFilesScope = "created" | "changed" | "all";

type PathAction = {
  path: string;
  action: SessionFileAction;
};

type PendingToolCall = {
  toolName: string;
  pathActions: PathAction[];
  ts?: number;
  execCommand?: string;
};

type MutableSessionFile = {
  path: string;
  workspacePath?: string;
  kind: SessionFileKind;
  actions: Set<SessionFileAction>;
  exists?: boolean;
  firstSeenAt?: number;
  lastSeenAt?: number;
};

type TranscriptParseResult = {
  minTs?: number;
  maxTs?: number;
};

type SessionFilesMutationEvent = {
  id: string;
  op: "rename" | "delete";
  path: string;
  nextPath?: string;
  ts: number;
};

type SessionFilesMutationLog = {
  version: number;
  key: string;
  sessionId: string;
  updatedAt: number;
  events: SessionFilesMutationEvent[];
};

function isWorkspaceScanEnabled(): boolean {
  return process.env.OPENCLAW_SESSION_FILES_WORKSPACE_SCAN === "1";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function normalizeToolName(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const normalized = value.trim().toLowerCase().replaceAll("-", "_");
  if (normalized === "bash") {
    return "exec";
  }
  return normalized;
}

function normalizeType(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().toLowerCase();
}

function normalizeRole(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().toLowerCase();
}

function normalizeOutputPath(input: string): string {
  const normalized = input
    .replaceAll("\\", "/")
    .replace(/\/{2,}/g, "/")
    .trim();
  if (!normalized || normalized === "/") {
    return normalized;
  }
  return normalized.replace(/\/+$/g, "");
}

function normalizeScope(scope: unknown): SessionFilesScope {
  if (scope === "created" || scope === "changed" || scope === "all") {
    return scope;
  }
  return "created";
}

function normalizeMutationPath(raw: unknown): string {
  if (typeof raw !== "string") {
    return "";
  }
  return normalizeOutputPath(raw);
}

function toTimestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    if (value < 10_000_000_000) {
      return Math.floor(value * 1000);
    }
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    const parsedNumber = Number(trimmed);
    if (Number.isFinite(parsedNumber) && parsedNumber > 0) {
      return toTimestampMs(parsedNumber);
    }
    const parsedDate = Date.parse(trimmed);
    if (Number.isFinite(parsedDate) && parsedDate > 0) {
      return Math.floor(parsedDate);
    }
  }
  return undefined;
}

function resolveTimestamp(record?: Record<string, unknown>): number | undefined {
  if (!record) {
    return undefined;
  }
  return (
    toTimestampMs(record.timestamp) ??
    toTimestampMs(record.ts) ??
    toTimestampMs(record.createdAtMs) ??
    toTimestampMs(record.createdAt) ??
    toTimestampMs(record.updatedAtMs) ??
    toTimestampMs(record.updatedAt)
  );
}

function updateWindow(result: TranscriptParseResult, ts: number | undefined) {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) {
    return;
  }
  if (result.minTs === undefined || ts < result.minTs) {
    result.minTs = ts;
  }
  if (result.maxTs === undefined || ts > result.maxTs) {
    result.maxTs = ts;
  }
}

function safeParseJsonLine(line: string): Record<string, unknown> | undefined {
  if (!line.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(line);
    return asRecord(parsed);
  } catch {
    return undefined;
  }
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function stringList(record: Record<string, unknown>, keys: readonly string[]): string[] {
  const out: string[] = [];
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      out.push(value.trim());
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && item.trim()) {
          out.push(item.trim());
        }
      }
    }
  }
  return out;
}

function dedupePathActions(actions: PathAction[]): PathAction[] {
  const map = new Map<string, SessionFileAction>();
  for (const item of actions) {
    const normalizedPath = normalizeOutputPath(item.path);
    if (!normalizedPath || normalizedPath === ".") {
      continue;
    }
    const existing = map.get(normalizedPath);
    if (!existing) {
      map.set(normalizedPath, item.action);
      continue;
    }
    const existingOrder = ACTION_ORDER.indexOf(existing);
    const nextOrder = ACTION_ORDER.indexOf(item.action);
    if (nextOrder >= 0 && (existingOrder < 0 || nextOrder < existingOrder)) {
      map.set(normalizedPath, item.action);
    }
  }
  return [...map.entries()].map(([pathValue, action]) => ({ path: pathValue, action }));
}

function parseApplyPatchInputActions(input: string): PathAction[] {
  const actions: PathAction[] = [];
  let currentUpdatePath: string | undefined;
  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (line.startsWith(APPLY_PATCH_ADD_PREFIX)) {
      actions.push({
        action: "created",
        path: line.slice(APPLY_PATCH_ADD_PREFIX.length).trim(),
      });
      currentUpdatePath = undefined;
      continue;
    }
    if (line.startsWith(APPLY_PATCH_UPDATE_PREFIX)) {
      const updatePath = line.slice(APPLY_PATCH_UPDATE_PREFIX.length).trim();
      if (updatePath) {
        actions.push({ action: "updated", path: updatePath });
        currentUpdatePath = updatePath;
      } else {
        currentUpdatePath = undefined;
      }
      continue;
    }
    if (line.startsWith(APPLY_PATCH_DELETE_PREFIX)) {
      actions.push({
        action: "deleted",
        path: line.slice(APPLY_PATCH_DELETE_PREFIX.length).trim(),
      });
      currentUpdatePath = undefined;
      continue;
    }
    if (line.startsWith(APPLY_PATCH_MOVE_PREFIX)) {
      const movePath = line.slice(APPLY_PATCH_MOVE_PREFIX.length).trim();
      if (currentUpdatePath) {
        actions.push({ action: "deleted", path: currentUpdatePath });
      }
      if (movePath) {
        actions.push({ action: "created", path: movePath });
        currentUpdatePath = movePath;
      } else {
        currentUpdatePath = undefined;
      }
    }
  }
  return dedupePathActions(actions);
}

function parseApplyPatchSummaryActions(text: string): PathAction[] {
  const actions: PathAction[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const match = rawLine.match(APPLY_PATCH_SUMMARY_RE);
    if (!match) {
      continue;
    }
    const marker = match[1];
    const rawPath = match[2]?.trim();
    if (!rawPath) {
      continue;
    }
    if (marker === "A") {
      actions.push({ action: "created", path: rawPath });
    } else if (marker === "M") {
      actions.push({ action: "updated", path: rawPath });
    } else if (marker === "D") {
      actions.push({ action: "deleted", path: rawPath });
    }
  }
  return dedupePathActions(actions);
}

function extractCommandPathHints(command: string): string[] {
  const out = new Set<string>();
  const addCandidate = (raw: string) => {
    const trimmed = raw.trim().replace(/^[`"'“”]+|[`"'“”,;:]+$/g, "");
    if (!trimmed || trimmed.length > 280) {
      return;
    }
    if (trimmed.startsWith("-") || URL_SCHEME_RE.test(trimmed)) {
      return;
    }
    const normalized = trimmed.replaceAll("\\", "/");
    const hasPathPrefix =
      normalized.startsWith("/") ||
      normalized.startsWith("./") ||
      normalized.startsWith("../") ||
      normalized.startsWith("~/") ||
      WINDOWS_DRIVE_RE.test(trimmed);
    const hasSeparator = normalized.includes("/");
    const hasKnownExtension = COMMAND_PATH_EXT_RE.test(normalized);
    if (!hasPathPrefix && !hasSeparator && !hasKnownExtension) {
      return;
    }
    out.add(trimmed);
  };

  for (const match of command.matchAll(/(["'`])([^"'`\r\n]{1,260})\1/g)) {
    addCandidate(match[2] ?? "");
  }
  for (const token of command.split(/\s+/)) {
    addCandidate(token);
  }
  return [...out];
}

const EXEC_READ_ONLY_COMMANDS = new Set([
  ".",
  "cat",
  "date",
  "dirname",
  "echo",
  "env",
  "find",
  "head",
  "id",
  "jq",
  "ls",
  "pwd",
  "readlink",
  "realpath",
  "rg",
  "sort",
  "tail",
  "tree",
  "uniq",
  "wc",
  "which",
  "whoami",
]);

const EXEC_WRAPPER_COMMANDS = new Set(["command", "env", "time"]);

function splitShellCommandSegments(command: string): string[] {
  return command
    .split(/(?:&&|\|\||\||;|\n)/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function shellTokenize(segment: string): string[] {
  return segment.match(/(?:[^\s"'`]+|"[^"]*"|'[^']*'|`[^`]*`)+/g) ?? [];
}

function normalizeShellToken(raw: string): string {
  return raw.trim().replace(/^["'`]+|["'`]+$/g, "");
}

function isEnvAssignmentToken(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function shouldSkipWrapperToken(wrapperName: string, token: string): boolean {
  if (wrapperName === "env") {
    return token.startsWith("-") || isEnvAssignmentToken(token);
  }
  return token.startsWith("-");
}

function resolveSegmentCommandName(segment: string): string | null {
  const tokens = shellTokenize(segment);
  let index = 0;
  let wrapperName: string | null = null;
  while (index < tokens.length) {
    const token = normalizeShellToken(tokens[index] ?? "");
    index += 1;
    if (!token) {
      continue;
    }
    if (!wrapperName && isEnvAssignmentToken(token)) {
      continue;
    }
    if (wrapperName && shouldSkipWrapperToken(wrapperName, token)) {
      continue;
    }
    const lowered = path.basename(token).toLowerCase();
    if (EXEC_WRAPPER_COMMANDS.has(lowered)) {
      wrapperName = lowered;
      continue;
    }
    return lowered;
  }
  if (wrapperName && EXEC_READ_ONLY_COMMANDS.has(wrapperName)) {
    return wrapperName;
  }
  return null;
}

function hasNonDevNullRedirection(command: string): boolean {
  for (const match of command.matchAll(/(?:^|[\s;|&])\d*(?:>>|>)\s*([^\s;|&]+)/g)) {
    const target = normalizeShellToken(match[1] ?? "");
    if (!target) {
      continue;
    }
    if (target.startsWith("&")) {
      continue;
    }
    if (target === "/dev/null") {
      continue;
    }
    return true;
  }
  return false;
}

function isExecCommandReadOnly(command: string): boolean {
  const normalized = command.trim();
  if (!normalized) {
    return false;
  }
  if (hasNonDevNullRedirection(normalized)) {
    return false;
  }

  let seenCommand = false;
  for (const segment of splitShellCommandSegments(normalized)) {
    const commandName = resolveSegmentCommandName(segment);
    if (!commandName) {
      continue;
    }
    seenCommand = true;
    if (!EXEC_READ_ONLY_COMMANDS.has(commandName)) {
      return false;
    }
  }
  return seenCommand;
}

function derivePathActionsFromToolCall(toolName: string, args: unknown): PathAction[] {
  const record = asRecord(args);
  if (!record) {
    return [];
  }
  const actions: PathAction[] = [];
  const add = (action: SessionFileAction, pathValue: string | undefined) => {
    if (!pathValue) {
      return;
    }
    actions.push({ action, path: pathValue });
  };

  if (toolName === "read") {
    add("read", firstString(record, ["path", "file_path", "filePath"]));
    for (const entry of stringList(record, ["paths", "files"])) {
      add("read", entry);
    }
    return dedupePathActions(actions);
  }

  if (toolName === "write" || toolName === "edit") {
    add("updated", firstString(record, ["path", "file_path", "filePath"]));
    return dedupePathActions(actions);
  }

  if (toolName === "apply_patch") {
    const input = firstString(record, ["input", "patch"]);
    if (input) {
      actions.push(...parseApplyPatchInputActions(input));
    }
    add("updated", firstString(record, ["path", "file_path", "filePath"]));
    return dedupePathActions(actions);
  }

  if (toolName === "exec") {
    const command = firstString(record, ["command", "cmd"]);
    if (command) {
      for (const hint of extractCommandPathHints(command)) {
        add("referenced", hint);
      }
    }
    return dedupePathActions(actions);
  }

  add("referenced", firstString(record, ["path", "file_path", "filePath"]));
  for (const entry of stringList(record, ["paths", "files"])) {
    add("referenced", entry);
  }
  return dedupePathActions(actions);
}

function extractTextFromToolResultPayload(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  const record = asRecord(value);
  if (!record) {
    return "";
  }
  if (typeof record.text === "string") {
    return record.text;
  }
  const content = Array.isArray(record.content) ? record.content : [];
  const texts: string[] = [];
  for (const item of content) {
    const entry = asRecord(item);
    if (!entry) {
      continue;
    }
    if (typeof entry.text === "string" && entry.text.trim()) {
      texts.push(entry.text);
    }
  }
  if (texts.length > 0) {
    return texts.join("\n");
  }
  if (typeof record.message === "string") {
    return record.message;
  }
  return "";
}

type ResolvedPathCandidate = {
  key: string;
  path: string;
  workspacePath?: string;
  absolutePath?: string;
};

function pathInsideWorkspace(workspaceDir: string, absolutePath: string): string | null {
  const workspaceRoot = path.resolve(workspaceDir);
  const relative = path.relative(workspaceRoot, absolutePath);
  if (!relative) {
    return ".";
  }
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return normalizeOutputPath(relative);
}

function shouldIgnoreWorkspacePath(workspacePath: string): boolean {
  const normalized = normalizeOutputPath(workspacePath);
  if (!normalized || normalized === ".") {
    return false;
  }
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0) {
    return false;
  }
  if (segments.some((segment) => SESSION_FILES_IGNORED_DIRS.has(segment))) {
    return true;
  }
  const fileName = segments[segments.length - 1];
  return SESSION_FILES_IGNORED_FILE_NAMES.has(fileName);
}

function resolvePathCandidate(
  pathValue: string,
  workspaceDir?: string,
): ResolvedPathCandidate | null {
  const trimmed = String(pathValue ?? "").trim();
  if (!trimmed || trimmed.includes("\0") || URL_SCHEME_RE.test(trimmed)) {
    return null;
  }
  let absolutePath: string | undefined;
  if (path.isAbsolute(trimmed) || WINDOWS_DRIVE_RE.test(trimmed)) {
    absolutePath = path.resolve(trimmed);
  } else if (workspaceDir) {
    absolutePath = path.resolve(workspaceDir, trimmed);
  }

  let outputPath = normalizeOutputPath(trimmed);
  let workspacePath: string | undefined;
  if (workspaceDir && absolutePath) {
    const relativePath = pathInsideWorkspace(workspaceDir, absolutePath);
    if (relativePath && relativePath !== ".") {
      workspacePath = relativePath;
      outputPath = normalizeOutputPath(absolutePath);
    } else if (relativePath === ".") {
      return null;
    } else {
      outputPath = normalizeOutputPath(absolutePath);
    }
  } else if (absolutePath) {
    outputPath = normalizeOutputPath(absolutePath);
  }

  if (!outputPath || outputPath === ".") {
    return null;
  }
  if (workspacePath && shouldIgnoreWorkspacePath(workspacePath)) {
    return null;
  }
  const key = workspacePath ? `workspace:${workspacePath}` : `path:${outputPath}`;
  return {
    key,
    path: outputPath,
    workspacePath,
    absolutePath,
  };
}

function getPathStat(absolutePath: string, cache: Map<string, fs.Stats | null>): fs.Stats | null {
  const cached = cache.get(absolutePath);
  if (cached !== undefined) {
    return cached;
  }
  try {
    const stat = fs.statSync(absolutePath);
    cache.set(absolutePath, stat);
    return stat;
  } catch {
    cache.set(absolutePath, null);
    return null;
  }
}

function resolveKindFromStat(stat: fs.Stats | null): SessionFileKind {
  if (!stat) {
    return "unknown";
  }
  if (stat.isDirectory()) {
    return "directory";
  }
  if (stat.isFile()) {
    return "file";
  }
  return "unknown";
}

function hasErrorStatus(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "error" || normalized === "failed" || normalized === "failure";
}

function isToolResultError(message: Record<string, unknown>): boolean {
  if (message.isError === true || message.is_error === true) {
    return true;
  }
  if (hasErrorStatus(message.status)) {
    return true;
  }
  const details = asRecord(message.details);
  if (details && hasErrorStatus(details.status)) {
    return true;
  }
  const result = asRecord(message.result);
  if (result && hasErrorStatus(result.status)) {
    return true;
  }
  return false;
}

function promoteExecActionByStat(params: {
  action: SessionFileAction;
  pathValue: string;
  seenAt?: number;
  workspaceDir?: string;
  statCache: Map<string, fs.Stats | null>;
}): SessionFileAction {
  if (params.action !== "referenced") {
    return params.action;
  }
  const candidate = resolvePathCandidate(params.pathValue, params.workspaceDir);
  if (!candidate?.absolutePath) {
    return params.action;
  }
  const stat = getPathStat(candidate.absolutePath, params.statCache);
  if (!stat) {
    return params.action;
  }
  const seenAt = params.seenAt && Number.isFinite(params.seenAt) ? params.seenAt : Date.now();
  const lowerBound = Math.max(0, seenAt - SESSION_FILES_EXEC_PROMOTE_BEFORE_MS);
  const upperBound = seenAt + SESSION_FILES_EXEC_PROMOTE_AFTER_MS;
  const birthtime = toTimestampMs(stat.birthtimeMs);
  if (birthtime !== undefined && birthtime >= lowerBound && birthtime <= upperBound) {
    return "created";
  }
  const mtime = toTimestampMs(stat.mtimeMs);
  if (mtime !== undefined && mtime >= lowerBound && mtime <= upperBound) {
    return "updated";
  }
  return params.action;
}

function pushSessionFileRecord(params: {
  map: Map<string, MutableSessionFile>;
  statCache: Map<string, fs.Stats | null>;
  workspaceDir?: string;
  pathValue: string;
  action: SessionFileAction;
  seenAt?: number;
  kindHint?: SessionFileKind;
  existsHint?: boolean;
}) {
  const candidate = resolvePathCandidate(params.pathValue, params.workspaceDir);
  if (!candidate) {
    return;
  }
  const seenAt = params.seenAt && Number.isFinite(params.seenAt) ? params.seenAt : Date.now();
  const stat = candidate.absolutePath
    ? getPathStat(candidate.absolutePath, params.statCache)
    : null;
  const exists = params.existsHint ?? Boolean(stat);
  const kind = params.kindHint ?? resolveKindFromStat(stat);

  const existing = params.map.get(candidate.key);
  if (!existing) {
    params.map.set(candidate.key, {
      path: candidate.path,
      workspacePath: candidate.workspacePath,
      kind,
      actions: new Set([params.action]),
      exists,
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
    });
    return;
  }

  existing.actions.add(params.action);
  existing.kind = existing.kind === "unknown" ? kind : existing.kind;
  if (existing.exists === undefined) {
    existing.exists = exists;
  } else if (!exists) {
    existing.exists = false;
  }
  if (existing.firstSeenAt === undefined || seenAt < existing.firstSeenAt) {
    existing.firstSeenAt = seenAt;
  }
  if (existing.lastSeenAt === undefined || seenAt > existing.lastSeenAt) {
    existing.lastSeenAt = seenAt;
  }
}

function parseTranscriptFile(params: {
  transcriptPath: string;
  workspaceDir?: string;
  map: Map<string, MutableSessionFile>;
  statCache: Map<string, fs.Stats | null>;
}): TranscriptParseResult {
  const result: TranscriptParseResult = {};
  let raw = "";
  try {
    raw = fs.readFileSync(params.transcriptPath, "utf-8");
  } catch {
    return result;
  }
  const pendingToolCalls = new Map<string, PendingToolCall>();

  for (const line of raw.split(/\r?\n/)) {
    const parsed = safeParseJsonLine(line);
    if (!parsed) {
      continue;
    }

    const lineTs = resolveTimestamp(parsed);
    updateWindow(result, lineTs);

    const message =
      asRecord(parsed.message) ?? (typeof parsed.role === "string" ? parsed : undefined);
    if (!message) {
      continue;
    }

    const messageTs = resolveTimestamp(message) ?? lineTs;
    updateWindow(result, messageTs);

    const role = normalizeRole(message.role);
    if (role === "assistant") {
      const content = Array.isArray(message.content) ? message.content : [];
      for (const blockRaw of content) {
        const block = asRecord(blockRaw);
        if (!block || !TOOL_CALL_TYPES.has(normalizeType(block.type))) {
          continue;
        }
        const toolCallId = firstString(block, ["id", "toolCallId", "tool_call_id", "toolUseId"]);
        const toolName = normalizeToolName(
          firstString(block, ["name", "toolName", "tool_name"]) ?? "",
        );
        const pathActions = derivePathActionsFromToolCall(
          toolName,
          block.arguments ?? block.input ?? block.args,
        );
        if (!toolCallId) {
          for (const item of pathActions) {
            pushSessionFileRecord({
              map: params.map,
              statCache: params.statCache,
              workspaceDir: params.workspaceDir,
              pathValue: item.path,
              action: item.action === "read" ? "read" : "referenced",
              seenAt: messageTs,
            });
          }
          continue;
        }
        pendingToolCalls.set(toolCallId, {
          toolName,
          pathActions,
          ts: messageTs,
          execCommand:
            toolName === "exec"
              ? firstString(asRecord(block.arguments ?? block.input ?? block.args) ?? {}, [
                  "command",
                  "cmd",
                ])
              : undefined,
        });
      }
      continue;
    }

    if (!TOOL_RESULT_ROLES.has(role)) {
      continue;
    }

    const toolCallId = firstString(message, [
      "toolCallId",
      "tool_call_id",
      "toolUseId",
      "tool_use_id",
    ]);
    const pending = toolCallId ? pendingToolCalls.get(toolCallId) : undefined;
    const toolName =
      pending?.toolName ||
      normalizeToolName(firstString(message, ["toolName", "tool_name", "name"]) ?? "");
    const isError = isToolResultError(message);

    if (pending) {
      for (const item of pending.pathActions) {
        let action = isError && item.action !== "read" ? "referenced" : item.action;
        if (
          !isError &&
          pending.toolName === "exec" &&
          pending.execCommand &&
          !isExecCommandReadOnly(pending.execCommand)
        ) {
          action = promoteExecActionByStat({
            action,
            pathValue: item.path,
            seenAt: messageTs ?? pending.ts,
            workspaceDir: params.workspaceDir,
            statCache: params.statCache,
          });
        }
        pushSessionFileRecord({
          map: params.map,
          statCache: params.statCache,
          workspaceDir: params.workspaceDir,
          pathValue: item.path,
          action,
          seenAt: messageTs ?? pending.ts,
        });
      }
      if (toolCallId) {
        pendingToolCalls.delete(toolCallId);
      }
    }

    if (toolName === "apply_patch") {
      const summaryActions = parseApplyPatchSummaryActions(
        extractTextFromToolResultPayload(message) ||
          extractTextFromToolResultPayload(message.result) ||
          extractTextFromToolResultPayload(message.details),
      );
      for (const item of summaryActions) {
        pushSessionFileRecord({
          map: params.map,
          statCache: params.statCache,
          workspaceDir: params.workspaceDir,
          pathValue: item.path,
          action: isError ? "referenced" : item.action,
          seenAt: messageTs,
        });
      }
    }
  }

  for (const pending of pendingToolCalls.values()) {
    for (const item of pending.pathActions) {
      pushSessionFileRecord({
        map: params.map,
        statCache: params.statCache,
        workspaceDir: params.workspaceDir,
        pathValue: item.path,
        action: item.action === "read" ? "read" : "referenced",
        seenAt: pending.ts,
      });
    }
  }

  return result;
}

function resolveSessionTimeWindow(params: {
  entry: SessionEntry | undefined;
  transcriptPath?: string;
  transcriptWindow: TranscriptParseResult;
}): { startMs: number; endMs: number } {
  const now = Date.now();
  const transcriptStat = params.transcriptPath
    ? (() => {
        try {
          return fs.statSync(params.transcriptPath);
        } catch {
          return undefined;
        }
      })()
    : undefined;

  const endCandidates = [
    params.transcriptWindow.maxTs,
    params.entry?.updatedAt,
    transcriptStat?.mtimeMs,
    now,
  ].filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const endMs = endCandidates.length > 0 ? Math.max(...endCandidates) : now;

  const fallbackStart = Math.max(0, endMs - SESSION_FILES_FALLBACK_WINDOW_MS);
  const startCandidates = [
    params.transcriptWindow.minTs,
    transcriptStat?.birthtimeMs,
    fallbackStart,
  ].filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0,
  );
  let startMs = startCandidates.length > 0 ? Math.min(...startCandidates) : fallbackStart;
  if (!Number.isFinite(startMs) || startMs <= 0) {
    startMs = fallbackStart;
  }
  if (startMs > endMs) {
    startMs = Math.max(0, endMs - SESSION_FILES_FALLBACK_WINDOW_MS);
  }

  return { startMs, endMs };
}

function applyWorkspaceMtimeScan(params: {
  workspaceDir: string;
  window: { startMs: number; endMs: number };
  map: Map<string, MutableSessionFile>;
  statCache: Map<string, fs.Stats | null>;
}) {
  const workspaceRoot = path.resolve(params.workspaceDir);
  let rootStat: fs.Stats | null = null;
  try {
    rootStat = fs.statSync(workspaceRoot);
  } catch {
    return;
  }
  if (!rootStat?.isDirectory()) {
    return;
  }

  const scanStart = Math.max(0, params.window.startMs - SESSION_FILES_SCAN_START_GRACE_MS);
  const scanEnd = params.window.endMs + SESSION_FILES_SCAN_END_GRACE_MS;
  const stack: string[] = [workspaceRoot];
  let scannedEntries = 0;

  while (stack.length > 0 && scannedEntries < SESSION_FILES_MAX_SCAN_ENTRIES) {
    const currentDir = stack.pop();
    if (!currentDir) {
      break;
    }
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (scannedEntries >= SESSION_FILES_MAX_SCAN_ENTRIES) {
        break;
      }
      scannedEntries += 1;
      if (entry.name === "." || entry.name === "..") {
        continue;
      }
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (SESSION_FILES_IGNORED_DIRS.has(entry.name)) {
          continue;
        }
        stack.push(fullPath);
        continue;
      }

      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }
      if (!stat.isFile()) {
        continue;
      }
      params.statCache.set(fullPath, stat);

      const mtime = toTimestampMs(stat.mtimeMs);
      if (mtime === undefined || mtime < scanStart || mtime > scanEnd) {
        continue;
      }
      const birthtime = toTimestampMs(stat.birthtimeMs);
      const createdInWindow =
        birthtime !== undefined && birthtime >= scanStart && birthtime <= scanEnd;
      const seenAt = birthtime ?? mtime;

      if (createdInWindow) {
        pushSessionFileRecord({
          map: params.map,
          statCache: params.statCache,
          workspaceDir: workspaceRoot,
          pathValue: fullPath,
          action: "created",
          seenAt,
          kindHint: "file",
          existsHint: true,
        });
      }

      pushSessionFileRecord({
        map: params.map,
        statCache: params.statCache,
        workspaceDir: workspaceRoot,
        pathValue: fullPath,
        action: "updated",
        seenAt: mtime,
        kindHint: "file",
        existsHint: true,
      });
    }
  }
}

function sortActions(actions: Set<SessionFileAction>): SessionFileAction[] {
  return [...actions].toSorted((a, b) => ACTION_ORDER.indexOf(a) - ACTION_ORDER.indexOf(b));
}

function scopeIncludesRecord(scope: SessionFilesScope, actions: Set<SessionFileAction>): boolean {
  if (scope === "all") {
    return true;
  }
  if (scope === "created") {
    return actions.has("created");
  }
  return actions.has("created") || actions.has("updated") || actions.has("deleted");
}

function toSessionFileRecord(record: MutableSessionFile): SessionFileRecord | null {
  const actions = sortActions(record.actions);
  if (actions.length === 0) {
    return null;
  }
  return {
    path: record.path,
    workspacePath: record.workspacePath,
    kind: record.kind,
    action: actions[0],
    actions,
    exists: record.exists,
    firstSeenAt: record.firstSeenAt,
    lastSeenAt: record.lastSeenAt,
  };
}

function resolveSessionEntryForKey(params: { cfg: OpenClawConfig; key: string }): {
  canonicalKey: string;
  agentId: string;
  storePath: string;
  entry?: SessionEntry;
} {
  const initialTarget = resolveGatewaySessionStoreTarget({
    cfg: params.cfg,
    key: params.key,
    scanLegacyKeys: false,
  });
  const store = loadSessionStore(initialTarget.storePath);
  const target = resolveGatewaySessionStoreTarget({
    cfg: params.cfg,
    key: params.key,
    store,
  });
  const entry = target.storeKeys.map((candidate) => store[candidate]).find(Boolean);
  return {
    canonicalKey: target.canonicalKey,
    agentId: target.agentId,
    storePath: target.storePath,
    entry,
  };
}

function resolveWorkspaceDirForAgent(cfg: OpenClawConfig, agentId: string): string | undefined {
  try {
    return path.resolve(resolveAgentWorkspaceDir(cfg, agentId));
  } catch {
    return undefined;
  }
}

function cloneMutableSessionFile(record: MutableSessionFile): MutableSessionFile {
  return {
    path: record.path,
    workspacePath: record.workspacePath,
    kind: record.kind,
    actions: new Set(record.actions),
    exists: record.exists,
    firstSeenAt: record.firstSeenAt,
    lastSeenAt: record.lastSeenAt,
  };
}

function collectSpawnedDescendantSessionKeys(params: {
  cfg: OpenClawConfig;
  rootSessionKey: string;
  maxSessions?: number;
}): string[] {
  const rootSessionKey = params.rootSessionKey.trim();
  if (!rootSessionKey) {
    return [];
  }
  const maxSessions =
    typeof params.maxSessions === "number" && Number.isFinite(params.maxSessions)
      ? Math.max(1, Math.floor(params.maxSessions))
      : SESSION_FILES_MAX_SCOPED_SESSIONS;

  const { store } = loadCombinedSessionStoreForGateway(params.cfg);
  const childrenByParent = new Map<string, string[]>();
  for (const [sessionKey, entry] of Object.entries(store)) {
    const parentKey = typeof entry?.spawnedBy === "string" ? entry.spawnedBy.trim() : "";
    if (!parentKey || !sessionKey.trim()) {
      continue;
    }
    const list = childrenByParent.get(parentKey) ?? [];
    list.push(sessionKey);
    childrenByParent.set(parentKey, list);
  }

  const descendants: string[] = [];
  const seen = new Set<string>([rootSessionKey]);
  const queue: string[] = [rootSessionKey];

  while (queue.length > 0 && descendants.length < maxSessions) {
    const parent = queue.shift();
    if (!parent) {
      break;
    }
    const children = childrenByParent.get(parent) ?? [];
    for (const childKey of children) {
      const normalizedChildKey = childKey.trim();
      if (!normalizedChildKey || seen.has(normalizedChildKey)) {
        continue;
      }
      seen.add(normalizedChildKey);
      descendants.push(normalizedChildKey);
      queue.push(normalizedChildKey);
      if (descendants.length >= maxSessions) {
        break;
      }
    }
  }

  return descendants;
}

function collectSessionFilesMapForResolvedEntry(params: {
  cfg: OpenClawConfig;
  resolved: ReturnType<typeof resolveSessionEntryForKey>;
}): {
  workspaceDir?: string;
  transcriptPath?: string;
  map: Map<string, MutableSessionFile>;
} {
  const workspaceDir = resolveWorkspaceDirForAgent(params.cfg, params.resolved.agentId);
  const map = new Map<string, MutableSessionFile>();
  const statCache = new Map<string, fs.Stats | null>();

  if (!params.resolved.entry?.sessionId) {
    return {
      workspaceDir,
      map,
    };
  }

  const transcriptPath = resolveSessionTranscriptCandidates(
    params.resolved.entry.sessionId,
    params.resolved.storePath,
    params.resolved.entry.sessionFile,
    params.resolved.agentId,
  ).find((candidate) => fs.existsSync(candidate));

  const transcriptWindow: TranscriptParseResult = {};
  if (transcriptPath) {
    const parsed = parseTranscriptFile({
      transcriptPath,
      workspaceDir,
      map,
      statCache,
    });
    transcriptWindow.minTs = parsed.minTs;
    transcriptWindow.maxTs = parsed.maxTs;
  }

  if (workspaceDir && isWorkspaceScanEnabled()) {
    applyWorkspaceMtimeScan({
      workspaceDir,
      window: resolveSessionTimeWindow({
        entry: params.resolved.entry,
        transcriptPath,
        transcriptWindow,
      }),
      map,
      statCache,
    });
  }

  const mutationLogPath = resolveSessionFilesMutationLogPath({
    sessionId: params.resolved.entry.sessionId,
    storePath: params.resolved.storePath,
  });
  const legacyMutationLogPath = resolveLegacySessionFilesMutationLogPath(transcriptPath);
  const mutationLog = readSessionFilesMutationLog({
    logPath: mutationLogPath,
    key: params.resolved.canonicalKey,
    sessionId: params.resolved.entry.sessionId,
  });
  const mergedMutationLog =
    legacyMutationLogPath && legacyMutationLogPath !== mutationLogPath
      ? mergeSessionFilesMutationLogs({
          primary: mutationLog,
          secondary: readSessionFilesMutationLog({
            logPath: legacyMutationLogPath,
            key: params.resolved.canonicalKey,
            sessionId: params.resolved.entry.sessionId,
          }),
        })
      : mutationLog;

  applySessionFilesMutationLog({
    map,
    events: mergedMutationLog.events,
    workspaceDir,
    statCache,
  });

  return {
    workspaceDir,
    transcriptPath,
    map,
  };
}

function resolveSessionFilesMutationLogPath(params: {
  sessionId: string;
  storePath: string;
}): string {
  const sessionsDir = path.dirname(params.storePath);
  return path.join(sessionsDir, `${params.sessionId}.files-events.json`);
}

function resolveLegacySessionFilesMutationLogPath(transcriptPath?: string): string | undefined {
  if (!transcriptPath) {
    return undefined;
  }
  return `${transcriptPath}.files-events.json`;
}

function createEmptySessionFilesMutationLog(params: {
  key: string;
  sessionId: string;
}): SessionFilesMutationLog {
  return {
    version: SESSION_FILES_MUTATION_LOG_VERSION,
    key: params.key,
    sessionId: params.sessionId,
    updatedAt: Date.now(),
    events: [],
  };
}

function parseSessionFilesMutationEvent(raw: unknown): SessionFilesMutationEvent | null {
  const record = asRecord(raw);
  if (!record) {
    return null;
  }
  const op = record.op === "rename" || record.op === "delete" ? record.op : null;
  if (!op) {
    return null;
  }
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const pathValue = normalizeMutationPath(record.path);
  const nextPath = normalizeMutationPath(record.nextPath);
  if (!id || !pathValue) {
    return null;
  }
  if (op === "rename" && !nextPath) {
    return null;
  }
  const ts = toTimestampMs(record.ts) ?? Date.now();
  return {
    id,
    op,
    path: pathValue,
    nextPath: op === "rename" ? nextPath : undefined,
    ts,
  };
}

function readSessionFilesMutationLog(params: {
  logPath: string;
  key: string;
  sessionId: string;
}): SessionFilesMutationLog {
  if (!fs.existsSync(params.logPath)) {
    return createEmptySessionFilesMutationLog({
      key: params.key,
      sessionId: params.sessionId,
    });
  }
  try {
    const raw = fs.readFileSync(params.logPath, "utf-8");
    const parsed = JSON.parse(raw);
    const record = asRecord(parsed);
    if (!record) {
      return createEmptySessionFilesMutationLog({
        key: params.key,
        sessionId: params.sessionId,
      });
    }
    const events = Array.isArray(record.events)
      ? record.events
          .map(parseSessionFilesMutationEvent)
          .filter((item): item is SessionFilesMutationEvent => Boolean(item))
      : [];
    const dedupedById = new Map<string, SessionFilesMutationEvent>();
    for (const event of events) {
      dedupedById.set(event.id, event);
    }
    const ordered = [...dedupedById.values()]
      .toSorted((a, b) => a.ts - b.ts)
      .slice(-SESSION_FILES_MUTATION_LOG_MAX_EVENTS);
    return {
      version:
        typeof record.version === "number"
          ? Math.floor(record.version)
          : SESSION_FILES_MUTATION_LOG_VERSION,
      key: typeof record.key === "string" && record.key.trim() ? record.key.trim() : params.key,
      sessionId:
        typeof record.sessionId === "string" && record.sessionId.trim()
          ? record.sessionId.trim()
          : params.sessionId,
      updatedAt: toTimestampMs(record.updatedAt) ?? Date.now(),
      events: ordered,
    };
  } catch {
    return createEmptySessionFilesMutationLog({
      key: params.key,
      sessionId: params.sessionId,
    });
  }
}

function writeSessionFilesMutationLog(logPath: string, payload: SessionFilesMutationLog): void {
  const dir = path.dirname(logPath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = `${logPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, JSON.stringify(payload), "utf-8");
  fs.renameSync(tempPath, logPath);
}

function mergeSessionFilesMutationLogs(params: {
  primary: SessionFilesMutationLog;
  secondary: SessionFilesMutationLog;
}): SessionFilesMutationLog {
  const deduped = new Map<string, SessionFilesMutationEvent>();
  for (const event of params.primary.events) {
    deduped.set(event.id, event);
  }
  for (const event of params.secondary.events) {
    const existing = deduped.get(event.id);
    if (!existing || event.ts >= existing.ts) {
      deduped.set(event.id, event);
    }
  }
  return {
    version: SESSION_FILES_MUTATION_LOG_VERSION,
    key: params.primary.key,
    sessionId: params.primary.sessionId,
    updatedAt: Math.max(params.primary.updatedAt, params.secondary.updatedAt),
    events: [...deduped.values()]
      .toSorted((a, b) => a.ts - b.ts)
      .slice(-SESSION_FILES_MUTATION_LOG_MAX_EVENTS),
  };
}

function hasSessionFilesMutationLogDifferences(
  source: SessionFilesMutationLog,
  merged: SessionFilesMutationLog,
): boolean {
  if (merged.events.length !== source.events.length) {
    return true;
  }
  const sourceById = new Map(source.events.map((event) => [event.id, event]));
  for (const event of merged.events) {
    const sourceEvent = sourceById.get(event.id);
    if (!sourceEvent) {
      return true;
    }
    if (
      sourceEvent.op !== event.op ||
      sourceEvent.path !== event.path ||
      sourceEvent.nextPath !== event.nextPath ||
      sourceEvent.ts !== event.ts
    ) {
      return true;
    }
  }
  return false;
}

function mergeMutableSessionFile(
  target: MutableSessionFile,
  incoming: MutableSessionFile,
): MutableSessionFile {
  if (target.kind === "unknown" && incoming.kind !== "unknown") {
    target.kind = incoming.kind;
  }
  for (const action of incoming.actions) {
    target.actions.add(action);
  }
  if (incoming.exists === false) {
    target.exists = false;
  } else if (incoming.exists === true && target.exists === undefined) {
    target.exists = true;
  }
  if (incoming.firstSeenAt !== undefined) {
    target.firstSeenAt =
      target.firstSeenAt === undefined
        ? incoming.firstSeenAt
        : Math.min(target.firstSeenAt, incoming.firstSeenAt);
  }
  if (incoming.lastSeenAt !== undefined) {
    target.lastSeenAt =
      target.lastSeenAt === undefined
        ? incoming.lastSeenAt
        : Math.max(target.lastSeenAt, incoming.lastSeenAt);
  }
  return target;
}

function applySessionFilesMutationLog(params: {
  map: Map<string, MutableSessionFile>;
  events: SessionFilesMutationEvent[];
  workspaceDir?: string;
  statCache: Map<string, fs.Stats | null>;
}) {
  if (params.events.length === 0) {
    return;
  }
  for (const event of params.events) {
    const seenAt = toTimestampMs(event.ts) ?? Date.now();
    if (event.op === "rename") {
      const fromCandidate = resolvePathCandidate(event.path, params.workspaceDir);
      const toCandidate = resolvePathCandidate(event.nextPath ?? "", params.workspaceDir);
      if (!fromCandidate || !toCandidate) {
        continue;
      }

      const source = params.map.get(fromCandidate.key);
      if (source) {
        params.map.delete(fromCandidate.key);
      }
      const targetExisting = params.map.get(toCandidate.key);

      const renamed: MutableSessionFile = source
        ? {
            ...source,
            path: toCandidate.path,
            workspacePath: toCandidate.workspacePath,
            actions: new Set(source.actions),
            firstSeenAt: source.firstSeenAt ?? seenAt,
            lastSeenAt: Math.max(source.lastSeenAt ?? seenAt, seenAt),
          }
        : {
            path: toCandidate.path,
            workspacePath: toCandidate.workspacePath,
            kind: "unknown",
            actions: new Set<SessionFileAction>(),
            exists: true,
            firstSeenAt: seenAt,
            lastSeenAt: seenAt,
          };

      renamed.actions.add("updated");
      renamed.actions.delete("deleted");

      if (toCandidate.absolutePath) {
        const stat = getPathStat(toCandidate.absolutePath, params.statCache);
        renamed.kind = resolveKindFromStat(stat);
        renamed.exists = Boolean(stat);
      } else if (renamed.exists === undefined) {
        renamed.exists = true;
      }

      if (targetExisting) {
        params.map.set(toCandidate.key, mergeMutableSessionFile(targetExisting, renamed));
      } else {
        params.map.set(toCandidate.key, renamed);
      }
      continue;
    }

    const candidate = resolvePathCandidate(event.path, params.workspaceDir);
    if (!candidate) {
      continue;
    }
    const existing = params.map.get(candidate.key);
    if (existing) {
      existing.actions.add("deleted");
      existing.exists = false;
      existing.lastSeenAt = Math.max(existing.lastSeenAt ?? seenAt, seenAt);
      if (existing.firstSeenAt === undefined) {
        existing.firstSeenAt = seenAt;
      }
      continue;
    }
    params.map.set(candidate.key, {
      path: candidate.path,
      workspacePath: candidate.workspacePath,
      kind: "unknown",
      actions: new Set<SessionFileAction>(["deleted"]),
      exists: false,
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
    });
  }
}

export function trackSessionFilesForGateway(params: {
  cfg: OpenClawConfig;
  key: string;
  opts: SessionsFilesTrackParams;
}): SessionsFilesTrackResult {
  const key = params.key.trim();
  const resolved = resolveSessionEntryForKey({
    cfg: params.cfg,
    key,
  });
  const now = Date.now();
  const rawEvents = Array.isArray(params.opts.events) ? params.opts.events : [];
  if (!resolved.entry?.sessionId) {
    return {
      ts: now,
      key: resolved.canonicalKey,
      status: "missing",
      applied: 0,
      ignored: rawEvents.length,
    };
  }

  const transcriptPath = resolveSessionTranscriptCandidates(
    resolved.entry.sessionId,
    resolved.storePath,
    resolved.entry.sessionFile,
    resolved.agentId,
  ).find((candidate) => fs.existsSync(candidate));
  const logPath = resolveSessionFilesMutationLogPath({
    sessionId: resolved.entry.sessionId,
    storePath: resolved.storePath,
  });
  const legacyLogPath = resolveLegacySessionFilesMutationLogPath(transcriptPath);
  const log = readSessionFilesMutationLog({
    logPath,
    key: resolved.canonicalKey,
    sessionId: resolved.entry.sessionId,
  });
  const legacyLog =
    legacyLogPath && legacyLogPath !== logPath
      ? readSessionFilesMutationLog({
          logPath: legacyLogPath,
          key: resolved.canonicalKey,
          sessionId: resolved.entry.sessionId,
        })
      : undefined;
  const mergedLog = legacyLog
    ? mergeSessionFilesMutationLogs({
        primary: log,
        secondary: legacyLog,
      })
    : log;

  const eventIds = new Set(mergedLog.events.map((event) => event.id));
  let applied = 0;
  let ignored = 0;

  for (const raw of rawEvents) {
    const op = raw?.op === "rename" || raw?.op === "delete" ? raw.op : null;
    const pathValue = normalizeMutationPath(raw?.path);
    const nextPath = normalizeMutationPath(raw?.nextPath);
    const eventId = typeof raw?.id === "string" && raw.id.trim() ? raw.id.trim() : randomUUID();
    const ts = toTimestampMs(raw?.ts) ?? now;
    if (!op || !pathValue) {
      ignored += 1;
      continue;
    }
    if (op === "rename" && !nextPath) {
      ignored += 1;
      continue;
    }
    if (eventIds.has(eventId)) {
      ignored += 1;
      continue;
    }
    eventIds.add(eventId);
    mergedLog.events.push({
      id: eventId,
      op,
      path: pathValue,
      nextPath: op === "rename" ? nextPath : undefined,
      ts,
    });
    applied += 1;
  }

  const migratedFromLegacy = legacyLog
    ? hasSessionFilesMutationLogDifferences(log, mergedLog)
    : false;

  if (applied > 0 || migratedFromLegacy) {
    mergedLog.version = SESSION_FILES_MUTATION_LOG_VERSION;
    mergedLog.key = resolved.canonicalKey;
    mergedLog.sessionId = resolved.entry.sessionId;
    mergedLog.updatedAt = now;
    mergedLog.events = mergedLog.events
      .toSorted((a, b) => a.ts - b.ts)
      .slice(-SESSION_FILES_MUTATION_LOG_MAX_EVENTS);
    writeSessionFilesMutationLog(logPath, mergedLog);
  }

  return {
    ts: now,
    key: resolved.canonicalKey,
    sessionId: resolved.entry.sessionId,
    status: applied > 0 ? "ok" : "noop",
    applied,
    ignored,
    logPath,
  };
}

export function listSessionFilesForGateway(params: {
  cfg: OpenClawConfig;
  key: string;
  opts: SessionsFilesListParams;
}): SessionsFilesListResult {
  const key = params.key.trim();
  const includeMissing = params.opts.includeMissing === true;
  const includeSpawned = params.opts.includeSpawned === true;
  const scope = normalizeScope(params.opts.scope);
  const limit =
    typeof params.opts.limit === "number" && Number.isFinite(params.opts.limit)
      ? Math.max(1, Math.min(10_000, Math.floor(params.opts.limit)))
      : 500;
  const resolved = resolveSessionEntryForKey({
    cfg: params.cfg,
    key,
  });
  const rootFiles = collectSessionFilesMapForResolvedEntry({
    cfg: params.cfg,
    resolved,
  });

  if (!resolved.entry?.sessionId) {
    return {
      ts: Date.now(),
      key: resolved.canonicalKey,
      status: "missing",
      workspaceDir: rootFiles.workspaceDir,
      files: [],
      count: 0,
    };
  }

  const scopedMap = new Map<string, MutableSessionFile>();
  let hasAnyTranscript = Boolean(rootFiles.transcriptPath);
  for (const [entryKey, record] of rootFiles.map.entries()) {
    scopedMap.set(entryKey, cloneMutableSessionFile(record));
  }

  if (includeSpawned) {
    const descendants = collectSpawnedDescendantSessionKeys({
      cfg: params.cfg,
      rootSessionKey: resolved.canonicalKey,
    });
    for (const childKey of descendants) {
      const childResolved = resolveSessionEntryForKey({
        cfg: params.cfg,
        key: childKey,
      });
      if (!childResolved.entry?.sessionId) {
        continue;
      }
      const childFiles = collectSessionFilesMapForResolvedEntry({
        cfg: params.cfg,
        resolved: childResolved,
      });
      if (childFiles.transcriptPath) {
        hasAnyTranscript = true;
      }
      for (const [entryKey, record] of childFiles.map.entries()) {
        const existing = scopedMap.get(entryKey);
        if (!existing) {
          scopedMap.set(entryKey, cloneMutableSessionFile(record));
          continue;
        }
        scopedMap.set(entryKey, mergeMutableSessionFile(existing, cloneMutableSessionFile(record)));
      }
    }
  }

  const filtered = [...scopedMap.values()]
    .filter((item) => scopeIncludesRecord(scope, item.actions))
    .filter((item) => includeMissing || item.exists !== false)
    .map(toSessionFileRecord)
    .filter((item): item is SessionFileRecord => Boolean(item))
    .toSorted((a, b) => {
      const aSeen = a.lastSeenAt ?? a.firstSeenAt ?? 0;
      const bSeen = b.lastSeenAt ?? b.firstSeenAt ?? 0;
      if (aSeen !== bSeen) {
        return bSeen - aSeen;
      }
      return a.path.localeCompare(b.path);
    });

  const files = filtered.slice(0, limit);
  const status = files.length > 0 ? "ok" : hasAnyTranscript ? "empty" : "no-transcript";
  return {
    ts: Date.now(),
    key: resolved.canonicalKey,
    sessionId: resolved.entry.sessionId,
    status,
    workspaceDir: rootFiles.workspaceDir,
    transcriptPath: rootFiles.transcriptPath,
    files,
    count: files.length,
  };
}
